# 3. Unified Search Gateway Architecture and Interface Boundaries

Date: 2026-11-15
Status: Accepted

## Context

The `shunt-shim` gateway established a zero-spend Cloudflare Workers (TypeScript / Hono) edge runtime ([ADR 0001](0001-runtime-target-and-shared-request-bounds.md)) and a bounded primary-fallback routing model ([ADR 0002](0002-model-fallback-and-provider-adaptation-strategy.md)) for OpenAI-compatible chat completions (`/v1/chat/completions`). Coding agents, review workflows, and local developer tooling also require programmatic web search to ground analysis in live documentation, security advisories, and external package metadata.

Web search APIs differ fundamentally from LLM chat completions across request schemas, billing structures, timeout budgets, and upstream failure semantics:
- **Heterogeneous Contracts**: Unlike `/v1/chat/completions`, which benefits from widespread OpenAI protocol convergence across Groq and Google AI Studio, web search providers expose incompatible proprietary REST payloads, authentication headers, and result structures.
- **Credit and Financial Risk Profiles**: Verified November 2026 provider economics demonstrate sharp differences between cardless recurring tiers and card-backed or non-renewing plans:
  - **Tavily**: 1,000 free monthly credits without a credit card (1 credit for `"basic"` search depth, 2 credits for `"advanced"` search depth), enforcing a hard HTTP 429/432 stop upon exhaustion.
  - **Exa**: $10 in free monthly credits without a credit card, enforcing a hard HTTP 402 (Payment Required) stop when credits are depleted.
  - **Brave Search**: $5 per month in prepaid credits (approximately 1,000 requests at $5 per 1,000 queries), but requires a credit card on file and carries paid overage risk if usage exceeds the monthly cap.
  - **Parallel Search**: Variable per-request pricing with credit-card continuation and automatic billing beyond initial promotional allocations.
  - **Linkup**: €5 monthly free credit allocation without a credit card (approximately 1,000 standard searches at €0.005 per query) with a hard quota stop, suitable as a secondary expansion tier.
  - **Firecrawl**: 1,000 free monthly credits without a credit card, billed at 2 credits per 10 search results, primarily oriented around combined search and full-page scraping.
  - **Serper and Jina AI**: Non-recurring starter credit pools (such as Serper's one-time 2,500 queries or Jina AI's one-time token grant) that permanently deplete rather than replenishing monthly.
  - **Google Custom Search JSON API**: Closed to new customers and scheduled for final sunset on January 1, 2027, making it unviable for new gateway integrations.
- **Distinct Latency and Payload Profiles**: Search requests carry small query payloads rather than multi-megabyte code diffs and should resolve within tighter wall-clock deadlines than long-form LLM generation.

Conflating web search adaptation inside the chat completions pipeline (`src/upstream.ts`) or forcing search callers to invoke synthetic LLM tool-call loops would tightly couple unrelated domain schemas, complicate error normalization, and risk unintended credit burn.

## Decision

1. **Decoupled Endpoint and Contract Boundary**:
   - Expose `POST /v1/search` (and a future MCP `web_search` tool wrapper targeting the same internal service interface) as an independent subsystem under `src/search/`, strictly separated from the chat completions pipeline in `src/upstream.ts`.
   - Each upstream search backend is encapsulated behind a dedicated `SearchProviderAdapter` module (`src/search/providers/`) that translates between the gateway's canonical search contract and the provider's native HTTP API.
   - **Canonical Request Schema (`SearchRequest`)**:
     - `query` (required non-empty string): The search query text.
     - `max_results` (optional integer, range `1..20`, default `10`): Maximum number of normalized result items to return.
     - `search_depth` (optional enum `"basic" | "advanced"`, default `"basic"`): Controls retrieval depth and maps directly to provider credit tiers (for example, Tavily 1-credit basic vs 2-credit advanced execution).
     - `include_domains` (optional string array): Domain allowlist filter.
     - `exclude_domains` (optional string array): Domain blocklist filter.
     - `provider` (optional enum or provider identifier): Optional explicit provider override when permitted by active policy.
   - **Canonical Response Schema (`SearchResponse`)**:
     - Returns a deterministic JSON envelope containing normalized result items (`title`, `url`, `snippet`, `published_date`, `score`), top-level `provider` attribution indicating which adapter fulfilled the request, and a normalized `usage` object reporting credits or request units consumed.

2. **Shared Edge Infrastructure**:
   - `/v1/search` shares the outer Hono middleware stack with `/v1/chat/completions` to preserve a single operational security and observability posture:
     - **Authentication Parity (`authMiddleware`)**: Reuses constant-time secret verification across `Authorization: Bearer <token>` and `x-api-key: <token>` against `GATEWAY_TOKENS` (returning HTTP 401 on missing, mismatched, or invalid credentials).
     - **Correlation IDs**: Extracts or generates `x-request-id` on every request and echoes it in response headers and error envelopes.
     - **Privacy-Preserving Diagnostics (`diagnosticsMiddleware`)**: Emits structured JSON log events restricted to an explicit low-cardinality allowlist (`requestId`, `route`, `status`, `latencyMs`, `provider`, `attemptCount`, `errorCode`). Raw search `query` strings, returned result `url` values, `snippet` text, and upstream or gateway credentials are never written to logs.

3. **Search Request Bounds and Timeouts**:
   - **Inbound Body Limit**: Enforce a 1 MB (`1,048,576` bytes) maximum request body size on `POST /v1/search`. Payloads exceeding 1 MB are rejected immediately with HTTP 413 `payload_too_large` prior to JSON parsing or upstream dispatch.
   - **Per-Provider Connect / Header Timeout**: 5,000 ms (5s) per upstream provider attempt.
   - **Total Search Gateway Deadline**: 30,000 ms (30s) wall-clock deadline across all attempts for `/v1/search` (tighter than the 60s chat completions deadline to reflect search SLA expectations). Expiration aborts in-flight fetches and returns HTTP 504 `gateway_timeout`.
   - **Client Disconnect Cancellation**: Propagates downstream client disconnects via `Request.signal` combined with per-attempt and total-deadline `AbortController` timers using `AbortSignal.any()` under the Worker `enable_request_signal` compatibility flag.
   - **Response Commitment Point**: Fallback is permitted only before downstream HTTP response headers are committed.

4. **Fail-Closed Financial Safety (`FREE_ONLY_POLICY`)**:
   - Every `SearchProviderAdapter` declares static capability and billing metadata, including `requiresCreditCard: boolean`.
   - The gateway enforces `FREE_ONLY_POLICY=true` by default. Under this default policy, the router quarantines any provider marked `requiresCreditCard: true` (including Brave Search and Parallel Search) and refuses to dispatch traffic to it even if an API key is present in the environment.
   - Card-backed providers remain quarantined until Phase 2 atomic quota reservation infrastructure is active and the operator explicitly configures `ALLOW_CARD_BACKED_PROVIDERS=true` alongside a positive monthly spend or credit ceiling.

5. **Routing and State Evolution**:
   - **Phase 1 MVP (Sequential Bounded Fallback with Isolate-Local Cooldowns)**:
     - Routes `POST /v1/search` through a deterministic priority chain of cardless recurring free-tier providers: **Tavily (Primary) -> Exa (Fallback)**.
     - Eligible failover triggers prior to response commitment include HTTP 429 (Too Many Requests), HTTP 402 / HTTP 432 (Provider Quota or Credit Exhaustion), HTTP 503 (Service Unavailable), 5s per-attempt connect/header timeouts, and network fetch errors within the 30s total deadline. Client validation errors (HTTP 400) and gateway authentication errors (HTTP 401) never trigger fallback.
     - Tracks rate-limit and quota-exhaustion cooldown timestamps (`cooldown_until` in epoch milliseconds, derived from upstream `Retry-After` headers or bounded exponential backoff) in module-scoped isolate-local memory so subsequent requests on the same warm isolate bypass a known-exhausted primary without incurring a wasted round-trip.
   - **Phase 2 Evolution (Durable Object Atomic Quota Reservations)**:
     - Before enabling any card-backed provider (`Brave`, `Parallel`) or multi-tenant quota budgets, state management evolves to a Cloudflare Durable Object coordinator that performs atomic pre-dispatch credit reservation and reconciliation, eliminating cross-isolate race conditions.

6. **Explicit Non-Goals**:
   - **No Full-Page Crawling or Scraping in `/v1/search`**: `/v1/search` returns bounded search metadata and snippets only. Full-page content extraction and URL scraping (such as Firecrawl page extraction or Jina Reader workflows) are deferred to a separate future `/v1/fetch` interface boundary.
   - **No Speculative Multi-Provider Fan-Out (Hedging)**: The gateway never dispatches concurrent duplicate search requests across multiple providers for a single inbound call, preserving scarce monthly credit allocations.
   - **No Unauthenticated SearXNG or HTML Scraping**: The gateway relies strictly on official, authenticated provider APIs with deterministic JSON contracts rather than public SearXNG instances or brittle HTML scraping.
   - **No Persistent Result Caching in MVP**: Phase 1 MVP executes stateless live queries without Cloudflare KV or Cache API persistence, avoiding stale search results and cache-key privacy liabilities.

## Consequences

### Positive
- **Clean Subsystem Modularity**: Isolating search schemas, adapters, and routing in `src/search/` prevents regression risk in `src/upstream.ts` and allows chat completions and search to evolve independently.
- **Zero Accidental Spend**: Combining cardless Phase 1 providers (Tavily and Exa) with the fail-closed `FREE_ONLY_POLICY=true` guard guarantees $0.00 upstream billing even under misconfigured secrets or traffic spikes.
- **Consistent Edge Security and Privacy**: Reusing `authMiddleware` and `diagnosticsMiddleware` ensures `/v1/search` inherits constant-time token verification, `x-request-id` correlation, and strict log redaction of sensitive query and result payloads from day one.

### Trade-offs and Operational Constraints
- **Isolate-Local State Boundaries in Phase 1**: Because Cloudflare Workers may run multiple edge isolates concurrently, module-scoped cooldown state is best-effort per isolate. Under sudden multi-region bursts, separate isolates may independently discover a provider's HTTP 429 or HTTP 402 state before each isolate records its local cooldown. This is safe for cardless providers with hard upstream quota stops (Tavily and Exa) but is insufficient for card-backed billing protection, which is why card-backed providers are gated on Phase 2 Durable Objects.
- **Adapter Maintenance per Provider**: Because web search providers lack a shared industry standard akin to OpenAI Chat Completions, each new search backend requires a dedicated schema and error translation adapter under `src/search/providers/`.

## Rationale and Alternatives Considered

- **Selected (Phase 1): Sequential Bounded Fallback with Isolate-Local Cooldowns (`Tavily -> Exa`)**
  Provides deterministic routing, zero infrastructure cost, zero cross-region coordination latency on the hot path, and immediate protection against repeated retries to an exhausted provider within warm isolates. Because both Tavily and Exa enforce hard upstream credit stops without credit cards, best-effort isolate memory is financially safe for MVP launch.
- **Deferred to Phase 2: Distributed Durable Object Quota Routing**
  Cloudflare Durable Objects provide strong single-threaded consistency capable of atomic credit reservations across all global edge isolates. However, invoking a Durable Object on every request adds cross-network coordination latency and requires additional Worker migration bindings. Deferring Durable Objects until Phase 2 keeps the Phase 1 MVP lightweight while establishing them as a mandatory prerequisite before enabling card-backed providers (`Brave`, `Parallel`).
- **Rejected: Query-Intent Classification Routing**
  Using heuristics or an auxiliary LLM call to classify queries (for example, routing semantic research queries to Exa and keyword lookups to Tavily) introduces pre-dispatch latency, classification ambiguity, and potential token consumption. Callers that require a specific engine can pass the optional `provider` field explicitly; default traffic follows the deterministic priority ladder.
- **Rejected: Parallel Hedged Requests / Multi-Provider Fan-Out**
  Dispatching simultaneous requests to multiple search providers to minimize tail latency or merge result sets multiplies credit consumption by the fan-out factor, rapidly exhausting the 1,000-query monthly free tiers.
- **Rejected: Multiplexing Search Inside `/v1/chat/completions`**
  Emulating web search as a synthetic model name or server-side tool loop inside `/v1/chat/completions` obscures structured search metadata (`url`, `published_date`, `score`), imposes unnecessary 10 MB body buffers, and prevents non-LLM clients and MCP tools from consuming structured search results directly.
