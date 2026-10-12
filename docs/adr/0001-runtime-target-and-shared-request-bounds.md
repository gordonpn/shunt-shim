# 1. Runtime Target and Shared Request Bounds

Date: 2026-10-12
Status: Accepted

## Context

The gateway needs a single deployment runtime and a deterministic request contract to serve three GitHub review clients (DeepSeek Review v1, OpenCodeReview, and PR-Agent) without client code modifications. Upstream traffic routes through Groq as the primary provider and Google Gemini as the fallback.

Key constraints:
- Strictly zero hosting spend required.
- Global HTTPS termination and streaming SSE delivery.
- Reliable execution from GitHub Actions runners and local developer environments.
- Low operational overhead without persistent server maintenance.

## Decision

1. **Deployment Target and Runtime**:
   Deploy as a Cloudflare Worker using TypeScript and the Hono web framework.
   - **Runtime**: Cloudflare Workers (V8 isolate execution environment).
   - **Language & Framework**: TypeScript with Hono for lightweight routing, middleware, and web-standard `fetch`, `Request`, and `Response` interfaces.
   - **Local Toolchain**: Bunx and Wrangler (`wrangler dev`, `wrangler deploy`, `wrangler tail`).

2. **Pinned Review Client Revisions**:
   - **DeepSeek Review v1**: Pinned commit `eccde2e9781008d795e366b951e313e37af88dd5` ([hustcer/deepseek-review](https://github.com/hustcer/deepseek-review/blob/eccde2e9781008d795e366b951e313e37af88dd5/action.yaml), checked 2026-10-06).
   - **OpenCodeReview**: Pinned commit `182898cf522da3d04157b422752d028417974e19` ([alibaba/open-code-review](https://github.com/alibaba/open-code-review/blob/182898cf522da3d04157b422752d028417974e19/action.yml), checked 2026-10-06).
   - **PR-Agent**: Pinned commit `99b72f62abb4c6dc7ebde98818dc535cf54d8023` ([The-PR-Agent/pr-agent](https://github.com/The-PR-Agent/pr-agent/blob/99b72f62abb4c6dc7ebde98818dc535cf54d8023/docs/docs/usage-guide/changing_a_model.md#L711-L768), checked 2026-10-06).

3. **Shared Request Bounds**:
   - **Inbound Body Limit**: 10,485,760 bytes (10 MB). Payloads exceeding this ceiling return HTTP 413 Payload Too Large immediately without dispatching upstream requests.
   - **Shared Context Ceiling**: 128,000 tokens. Bounded by Groq's 128k context window on Llama-3.3-70b-versatile. PR-Agent configured with `config.custom_model_max_tokens=128000`.
   - **Output Limit**: 8,192 tokens max completion tokens (`max_tokens` or `max_completion_tokens`), matching Groq and Gemini output ceilings.
   - **Timeouts and Deadlines**:
     - Upstream Connect Timeout: 5,000 ms (5s) per attempt.
     - Upstream Attempt Timeout: 60,000 ms (60s) per attempt.
     - Total Gateway Deadline: 150,000 ms (150s) bounded across all attempts.
     - Client and Ingress Alignment: Client timeouts exceed the gateway total deadline (DeepSeek Review default 180s, OpenCodeReview default 300s, PR-Agent default 300s). Cloudflare Workers streaming edge timeout accommodates the 150s window.

4. **Streaming Commitment Point**:
   Once HTTP 200 response headers and the first SSE chunk (`data: {"id":...}`) are flushed downstream to the client, the provider choice is locked. Requests are never replayed on the fallback provider mid-stream. If the active stream fails, the connection aborts without a synthesized `data: [DONE]` marker.

5. **Mixed Failure and Error Mapping**:
   Fallback is permitted only prior to downstream response commitment on eligible errors (HTTP 429, HTTP 503, connect timeout). When both attempts fail, the gateway returns the error class of the final failing attempt:
   - Primary 429 and Fallback 429: HTTP 429 with preserved `Retry-After`.
   - Primary 429 and Fallback 503: HTTP 503.
   - Primary 503 and Fallback 429: HTTP 429.
   - Primary 503 and Fallback 503: HTTP 503.
   - Primary eligible failure and Fallback Timeout: HTTP 504.
   - Primary connect timeout and Fallback 429: HTTP 429.
   - Primary connect timeout and Fallback connect timeout: HTTP 504.
   - Ineligible primary errors (400, 401, 403, 500): Terminate immediately with HTTP 502 without fallback attempt.

## Rationale and Alternatives Considered

- **Selected: Cloudflare Workers (TypeScript / Hono)**
  Provides free perpetual hosting (100,000 requests/day, 10 ms CPU time per request; upstream network wait time does not consume CPU budget), managed HTTPS, zero cold start delays, standard `fetch`/`ReadableStream` APIs, and type-safe Worker bindings.
- **Rejected: Google Cloud Run**
  Subject to cold start delays, container build overhead, and variable billing risk on network egress and idle compute.
- **Rejected: Fly.io Machines**
  Requires paid organization accounts, credit card setup, and incurs continuous resource costs.
- **Rejected: Existing Always-On Server**
  Requires persistent OS maintenance, manual TLS certificate renewal, ingress management, and dedicated operational overhead.
- **Rejected: Local Daemon**
  Inaccessible to remote GitHub Actions runners without complex tunneling and goes offline when the host machine sleeps.
