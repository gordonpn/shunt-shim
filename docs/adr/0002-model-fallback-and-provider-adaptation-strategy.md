# 2. Model Fallback and Provider Adaptation Strategy

Date: 2026-10-13
Status: Accepted (Amended for MVP: OpenAI-compatible Google AI Studio endpoint, non-streaming JSON, 60s total deadline; see docs/ARCHITECTURE.md)

> [!NOTE]
> **MVP Amendment (2026-10-30)**: For the implemented MVP runtime, Google AI Studio uses its official OpenAI-compatible endpoint (`/v1beta/openai/chat/completions`), streaming SSE is deferred and rejected with HTTP 400 `unsupported_parameter`, and the total gateway deadline is 60 seconds. Dynamic circuit breakers with isolate-local memory will govern post-MVP multi-turn failover; the MVP implements bounded one-fallback failover. See [ARCHITECTURE.md](../ARCHITECTURE.md) and [COMPATIBILITY.md](../COMPATIBILITY.md) for the active runtime contract.

## Context

The gateway multiplexes free-tier and multi-provider API pools where rate limits (HTTP 429), cold-start timeouts, and transient HTTP 503 service unavailability are standard operational states rather than rare exceptions. Incoming client requests adhere to the OpenAI Chat Completions standard (`/v1/chat/completions`) and route across heterogeneous backends (Groq and Google Gemini) with differing context ceilings, token quotas, and parameter schemas.

Key operational risks:
- **Cascade Exhaustion**: Outages on the primary provider can trigger synchronized failover spikes to the fallback provider, rapidly exhausting all available free-tier allocations.
- **Cumulative Latency Penalties**: Naive waterfall loops re-attempt dead endpoints on every incoming request, multiplying client-observed latency by the number of failing round-trips.
- **Quota Waste Through Hedging**: Speculative request racing doubles consumption against strict TPM (Tokens Per Minute) and RPM ceilings.
- **Streaming State Corruption**: Failing over after headers or streaming chunks are flushed downstream corrupts client-side SSE parsers and causes duplicate completions.

Three fallback architectures were evaluated:
1. **Capability-Bucketed Cascading Waterfall (Static Routing)**: Pure stateless priority ladder (`Model_1 -> Model_2`). Deterministic, but brittle during outages due to repeated network round-trip failures before reaching healthy backups.
2. **Dynamic Circuit Breaker with Cooldown Tracking (Stateful Routing)**: Maintains endpoint health state (`Healthy`, `Open`, `Half-Open`) to bypass cooling-down models with zero latency penalty.
3. **Hedged Request Racing with Early Abort**: Speculatively fires concurrent secondary requests if the primary does not yield time-to-first-token within an SLA. Minimizes latency, but burns duplicate quota, making it unsuitable for free-tier constraints.

## Decision

1. **Fallback Architecture**:
   Adopt an **Adaptive Capability Matrix with Dynamic Circuit Breakers**.
   - Incoming payloads are filtered by required capabilities (tools, JSON response format, context length) to select eligible candidate models.
   - The circuit breaker evaluates candidate models and bypasses any endpoint currently in the `Open` (cooling down) state at zero latency penalty.
   - Initial dispatch targets the highest-priority eligible healthy candidate (Groq). Eligible failures triggering fallback prior to downstream response commitment are strictly defined as: HTTP 429 (Too Many Requests), HTTP 503 (Service Unavailable), Upstream Connect Timeout (5s), and Attempt 1 Execution Timeout (60s, if remaining total gateway deadline permits). Transient 5xx codes such as HTTP 500 and 502, client validation errors (HTTP 400), and credential errors (HTTP 401/403) are ineligible for fallback.
   - Concurrency and Cascade Admission: When an in-flight burst causes primary requests to fail concurrently, cascading requests evaluate the fallback provider's health and circuit state. If the fallback endpoint is also tripped or cooling down, the gateway returns the primary failure immediately to prevent cascade exhaustion on backup quotas.
   - Execution Timeout Trade-Off: If Attempt 1 times out at 60s before committing downstream headers, the upstream fetch is aborted immediately via linked abort signals. Any uncancelled inference accepted upstream before abort propagation is recognized as an accepted trade-off to deliver client completions within the total deadline.

2. **State Management and Evolution**:
   - **Initial Iterations (Isolate-Local Memory)**: Maintain endpoint health and cooldown timestamps in module-scoped isolate memory. Cooldown deadlines are stored as epoch milliseconds (`cooldown_until: number`). This provides zero-latency cooldown tracking without distributed lock overhead or database dependencies.
   - **Canary Gate and In-Flight Claim**: In the `Half-Open` state, when `cooldown_until <= Date.now()`, the first arriving request atomically claims the probe slot (`probing = true`). Concurrent requests arriving while a probe is in flight observe `probing === true` and treat the circuit as `Open`, bypassing to fallback without competing for probe traffic.
   - **Circuit Generation Versioning**: Transitions to `Open` increment an integer `generation` counter. A completed probe transitions the circuit to `Healthy` and clears `probing` only if its generation matches the active circuit generation. Late successes from earlier in-flight requests cannot clear a newer cooldown opened by a subsequent request. If the canary probe fails, the circuit returns to `Open`, calculates an incremented backoff cooldown, and clears `probing`.
   - **Evolutionary Roadmap**: If cross-instance coordination or synchronized global quotas are required under high traffic volume, evaluate Cloudflare KV (read-heavy, eventual consistency) or Durable Objects (transactional atomic coordination).

3. **Provider Upstream Protocol Selection**:
   - **Groq**: Utilize the native OpenAI-compatible REST API (`https://api.groq.com/openai/v1/chat/completions`).
   - **Google Gemini**: Utilize the native Google REST API (`https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` and `:streamGenerateContent?alt=sse`) through a dedicated bidirectional translation adapter.
   - Using the native Google REST API avoids the impedance mismatch and double-shim limitations of the unofficial OpenAI-compatible endpoint, granting direct control over safety settings, generation configs, and native schema mappings.

4. **Operational Invariants**:
   - **Streaming Point of No Return**: Fallback is permitted strictly before downstream response headers (`Content-Type: text/event-stream`) or body bytes are flushed. Once byte 0 is transmitted downstream, provider selection is locked. Never embed failures in an HTTP 200 stream: if upstream disconnects, aborts, errors, or times out mid-stream, the gateway terminates and severs the downstream connection immediately without emitting a synthetic `data: [DONE]` terminator or an inline SSE error event. The client observes a transport error, preserving client SDK retry semantics.
   - **Conservative Token Estimation**: Guard context ceilings using a lightweight character/byte heuristic (~4 characters per token with a 15% safety margin for standard text; density factor scaling down to ~2 characters per token for dense source code, JSON, and CJK text) rather than bundling heavy WASM TikToken/BPE tokenizer dependencies into edge isolates.
   - **Rate Limit and Failure Header Normalization**: Extract `Retry-After`, `x-ratelimit-reset-requests`, and `x-ratelimit-reset-tokens` into a unified `cooldown_until` timestamp in epoch milliseconds. When multiple reset headers are present on an HTTP 429 response, `cooldown_until` resolves to the latest (maximum) reported reset deadline. For HTTP 429 responses without reset headers, HTTP 503, connect timeouts, and execution timeouts, enforce bounded exponential backoff with jitter: `min(300, 2^attempt * 5) +/- jitter` (in seconds, stored as epoch milliseconds).
   - **Cancellation and Zombie Drain Prevention**: Combine downstream `Request.signal` with abort controllers for the 60s per-attempt timeout and 150s total gateway deadline using linked signals (`AbortSignal.any()`). Client disconnects, attempt timeouts, and total deadline expirations immediately abort active upstream `fetch` calls before initiating fallback or returning error responses, preventing background token generation from burning free-tier quotas.

## Rationale and Alternatives Considered

- **Selected: Dynamic Circuit Breaker with Capability Matrix**
  Provides near-zero overhead during outages, respects upstream rate limit reset intervals, and distributes traffic cleanly across providers without wasting backup quotas in lockstep.
- **Rejected: Hedged Request Racing**
  Speculative duplicate requests double TPM and RPM consumption, accelerating quota exhaustion under rate-limited free tiers.
- **Rejected: Immediate Distributed State (Cloudflare KV / Durable Objects)**
  KV has eventual consistency and write propagation latency (up to 60 seconds) unsuitable for sub-minute rate limit windows. Durable Objects introduce cross-region routing latency and billing overhead. Best-effort isolate-local memory satisfies the simplicity-first principle for initial iterations.
- **Selected: Native Google REST API for Gemini**
  The native REST API provides official parameter support, schema control, and stable error envelopes, avoiding compatibility drift in third-party OpenAI emulation endpoints.
