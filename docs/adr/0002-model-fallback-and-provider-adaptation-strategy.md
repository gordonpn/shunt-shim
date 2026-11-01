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
   Adopt an **Adaptive Capability Matrix with Dynamic Circuit Breakers** for extended architecture, with a **Bounded Primary-Fallback Resolver** for the implemented MVP.
   - **Implemented MVP Resolver**: The gateway evaluates the configured primary provider (default: Groq `qwen/qwen3.8-27b`) and fallback provider (default: Google AI Studio `gemini-2.5-flash-lite`), swappable via `PRIMARY_PROVIDER`. Eligible failures triggering Attempt 2 fallback prior to downstream commitment are strictly: HTTP 429 (Too Many Requests), HTTP 503 (Service Unavailable), Upstream Connect/Header Timeout (5s), and network fetch failure within the 60s total deadline. Transient 5xx codes such as HTTP 500 and 502, client validation errors (HTTP 400), and credential errors (HTTP 401/403) are ineligible for fallback.
   - **Post-MVP Circuit Breaker**: Dynamic circuit breakers with isolate-local memory and canary probing will govern multi-turn and multi-provider pools.

2. **State Management and Evolution**:
   - **Implemented MVP**: Stateless execution within Cloudflare Workers isolates; bounded one-attempt failover on eligible upstream failures without cross-request state dependencies.
   - **Post-MVP Iterations (Isolate-Local Memory)**: Maintain endpoint health and cooldown timestamps in module-scoped isolate memory. Cooldown deadlines are stored as epoch milliseconds (`cooldown_until: number`).
   - **Evolutionary Roadmap**: If cross-instance coordination or synchronized global quotas are required under high traffic volume, evaluate Cloudflare KV or Durable Objects.

3. **Provider Upstream Protocol Selection**:
   - **Groq**: Utilize the native OpenAI-compatible REST API (`https://api.groq.com/openai/v1/chat/completions`).
   - **Google AI Studio (MVP)**: Utilize the official OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`).
   - **Google Gemini Native REST (Post-MVP)**: A dedicated bidirectional translation adapter to the native Google REST API (`/v1beta/models/{model}:generateContent`) is deferred to post-MVP.

4. **Operational Invariants**:
   - **Response Commitment Point**: (MVP note: Streaming SSE is deferred to post-MVP and rejected with HTTP 400 `unsupported_parameter`.) Fallback is permitted strictly before downstream response headers and body bytes are flushed. Once committed, provider selection is locked.
   - **Conservative Token Estimation**: Guard context ceilings using a lightweight character/byte heuristic rather than bundling heavy WASM TikToken/BPE tokenizer dependencies into edge isolates.
   - **Rate Limit and Failure Header Normalization**: Extract `Retry-After` on HTTP 429 responses to return to clients.
   - **Cancellation and Bounded Deadlines**: Combine downstream `Request.signal` with abort controllers for the 5s per-attempt timeout and 60s total gateway deadline using linked signals (`AbortSignal.any()`). Client disconnects, attempt timeouts, and total deadline expirations immediately abort active upstream `fetch` calls.

## Rationale and Alternatives Considered

- **Selected: Dynamic Circuit Breaker with Capability Matrix**
  Provides near-zero overhead during outages, respects upstream rate limit reset intervals, and distributes traffic cleanly across providers without wasting backup quotas in lockstep.
- **Rejected: Hedged Request Racing**
  Speculative duplicate requests double TPM and RPM consumption, accelerating quota exhaustion under rate-limited free tiers.
- **Rejected: Immediate Distributed State (Cloudflare KV / Durable Objects)**
  KV has eventual consistency and write propagation latency (up to 60 seconds) unsuitable for sub-minute rate limit windows. Durable Objects introduce cross-region routing latency and billing overhead. Best-effort isolate-local memory satisfies the simplicity-first principle for initial iterations.
- **Selected: Native Google REST API for Gemini**
  The native REST API provides official parameter support, schema control, and stable error envelopes, avoiding compatibility drift in third-party OpenAI emulation endpoints.
