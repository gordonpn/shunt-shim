# 2. Model Fallback and Provider Adaptation Strategy

Date: 2026-10-13
Status: Accepted

## Context

The gateway multiplexes free-tier and multi-provider API pools where rate limits (HTTP 429), cold-start timeouts, and transient 5xx errors are standard operational states rather than rare exceptions. Incoming client requests adhere to the OpenAI Chat Completions standard (`/v1/chat/completions`) and route across heterogeneous backends (Groq and Google Gemini) with differing context ceilings, token quotas, and parameter schemas.

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
   - Initial dispatch targets the highest-priority eligible healthy candidate (Groq). If an eligible failure occurs prior to response commitment, the circuit trips and execution cascades to the next eligible healthy candidate (Gemini).

2. **State Management and Evolution**:
   - **Initial Iterations (Isolate-Local Memory)**: Maintain endpoint health and cooldown timestamps in module-scoped isolate memory. This provides zero-latency cooldown tracking without distributed lock overhead or database dependencies.
   - **Canary Gate**: In the `Half-Open` state, use a timestamp-based single-probe gate (`cooldown_until <= Date.now()`). The next incoming request tests endpoint recovery: success returns the circuit to `Healthy`, while failure resets the cooldown window.
   - **Evolutionary Roadmap**: If cross-instance coordination or synchronized global quotas are required under high traffic volume, evaluate Cloudflare KV (read-heavy, eventual consistency) or Durable Objects (transactional atomic coordination).

3. **Provider Upstream Protocol Selection**:
   - **Groq**: Utilize the native OpenAI-compatible REST API (`https://api.groq.com/openai/v1/chat/completions`).
   - **Google Gemini**: Utilize the native Google REST API (`https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` and `:streamGenerateContent?alt=sse`) through a dedicated bidirectional translation adapter.
   - Using the native Google REST API avoids the impedance mismatch and double-shim limitations of the unofficial OpenAI-compatible endpoint, granting direct control over safety settings, generation configs, and native schema mappings.

4. **Operational Invariants**:
   - **Streaming Point of No Return**: Fallback is permitted strictly before downstream response headers (`Content-Type: text/event-stream`) or body bytes are flushed. Once byte 0 is transmitted downstream, provider selection is locked. If upstream fails mid-stream, the gateway terminates the connection cleanly with an OpenAI-compatible SSE error event (`data: {"error": ...}`) rather than attempting mid-stream failover.
   - **Conservative Token Estimation**: Guard context ceilings using a lightweight character/byte heuristic (~4 characters per token with a 15% safety margin) rather than bundling heavy WASM TikToken/BPE tokenizer dependencies into edge isolates.
   - **Rate Limit Header Normalization**: Extract `Retry-After`, `x-ratelimit-reset-requests`, and `x-ratelimit-reset-tokens` into a unified `cooldown_until` Unix timestamp. When headers are absent on HTTP 429, enforce bounded exponential backoff with jitter: `min(300, 2^attempt * 5) +/- jitter`.
   - **Cancellation and Zombie Drain Prevention**: Bind all upstream `fetch` calls to downstream `Request.signal`. Client disconnects immediately abort active upstream inference, preventing background token generation from burning free-tier quotas.

## Rationale and Alternatives Considered

- **Selected: Dynamic Circuit Breaker with Capability Matrix**
  Provides near-zero overhead during outages, respects upstream rate limit reset intervals, and distributes traffic cleanly across providers without wasting backup quotas in lockstep.
- **Rejected: Hedged Request Racing**
  Speculative duplicate requests double TPM and RPM consumption, accelerating quota exhaustion under rate-limited free tiers.
- **Rejected: Immediate Distributed State (Cloudflare KV / Durable Objects)**
  KV has eventual consistency and write propagation latency (up to 60 seconds) unsuitable for sub-minute rate limit windows. Durable Objects introduce cross-region routing latency and billing overhead. Best-effort isolate-local memory satisfies the simplicity-first principle for initial iterations.
- **Selected: Native Google REST API for Gemini**
  The native REST API provides official parameter support, schema control, and stable error envelopes, avoiding compatibility drift in third-party OpenAI emulation endpoints.
