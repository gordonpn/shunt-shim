# MVP Scope and Deployment Options

Status: Cloudflare Worker service implemented. See [ARCHITECTURE.md](ARCHITECTURE.md),
[CONFIGURATION.md](CONFIGURATION.md), and [COMPATIBILITY.md](COMPATIBILITY.md) for the
active runtime contract. See [ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md)
and [ADR 0002](adr/0002-model-fallback-and-provider-adaptation-strategy.md) for foundational
decision records.

The other architecture, configuration, and runbook documents describe the broader
design. Their commands and capabilities are not evidence of a working gateway.

## Goal

DeepSeek Review, OpenCodeReview, and PR-Agent can use one OpenAI Chat Completions
contract without client code changes, including OpenCodeReview's tool workflow.
They can continue after an eligible primary failure when the fallback has capacity.
See the [source-verified compatibility contract](COMPATIBILITY.md).

The gateway does not create additional quota or guarantee uninterrupted access.
If every eligible provider is exhausted, return an explicit error.

## Included

| Area | Scope |
| :--- | :--- |
| Deployment | One gateway instance or service; no database |
| Authentication | One random gateway secret accepted via Bearer or `x-api-key` |
| Endpoints | `GET /v1/models`; one completion handler at `/v1/chat/completions` and `/chat/completions` |
| Routing | One alias, `fast`, with Groq first and Gemini as fallback |
| Models | Explicit allowlist of models verified available on the configured accounts' free tiers |
| Responses | Non-streaming JSON (streaming SSE deferred to post-MVP; stream: true rejected with HTTP 400 unsupported_parameter) |
| Coding support | System/user/assistant/tool messages, function tools, tool results, both token-limit fields, optional reasoning metadata and usage |
| Failover | At most one fallback attempt, on upstream HTTP 429, HTTP 503, connect/header timeout (5s), or network fetch failure within 60s total deadline |
| Safety | Authentication and payload validation before upstream dispatch; body limits, bounded timeouts, and cancellation |
| Diagnostics | Provider, actual model, status, latency, and fallback reason; no prompts, completions, or credentials |

Validate core fields, reject unknown aliases, and define the subset shared by the
selected models. Tolerate unknown extension fields, including thinking and
reasoning hints; forward only approved provider mappings and ignore other extras.
Never let extensions override validated fields or credentials. Do not select paid
models or forward caller credentials upstream.

Fallback is permitted only before committing the downstream response. Once headers
are sent, never replay the request on another provider. Do not conceal
upstream validation or credential failures behind a fallback. If all candidates
are rate-limited, return an OpenAI-style HTTP 429 error; upstream unavailability
must remain distinguishable from quota exhaustion.

Provider endpoint selection:

- [Groq chat completions](https://console.groq.com/docs/api-reference):
  native OpenAI-compatible REST API (`/openai/v1/chat/completions`) with field validation.
- [Google AI Studio chat completions](https://aistudio.google.com):
  official OpenAI-compatible REST API (`/v1beta/openai/chat/completions`) for fallback dispatch.

Both providers serve standard OpenAI-compatible completions endpoints, avoiding custom protocol translation adapters. Verify the actual client and model behavior before claiming compatibility. Preserve tool-call fields and finish reasons in normalized JSON responses.

## Deferred

- Proactive quota prediction, shared counters, and cross-instance circuit-breaker coordination.
- Tenant priorities, per-project accounting, and reserved capacity.
- Exact token accounting and automatic large-context routing across multi-tier pools.
- The `deep` and `reasoning` aliases.
- OpenRouter and Workers AI.
- Multimodal inputs, embeddings, and the Responses API.
- Dashboards, caching, persistent storage, and provider-plugin frameworks.

Let upstream providers enforce their own quotas first. Add coordination only
after actual usage establishes its necessity.

Cloudflare KV is not suitable for strict quota enforcement: it is eventually
consistent and does not support atomic counter updates. Concurrent increments
can overwrite each other. If strict coordination becomes necessary on Workers,
evaluate Durable Objects instead. On a conventional server, evaluate a single
coordinating process and transactional storage before adding distributed state.
See [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

## Acceptance Criteria

Automate failure cases with mocked upstreams, then run deployed-client smoke
tests for all three clients. Each provider must pass successful cases independently.

| Given | When | Then |
| :--- | :--- | :--- |
| Missing, invalid, malformed, or conflicting gateway credentials | Any API endpoint is requested | Return HTTP 401 and make no upstream request |
| Valid Bearer, x-api-key, or matching dual credentials | Either completion path is requested | Execute identical auth, validation, routing, JSON, and error behavior |
| Valid gateway credentials | The model catalog is requested | Return exactly the supported `fast` alias in OpenAI model-list format |
| Malformed JSON/core fields, invalid messages/tools, or an unknown alias | A completion is requested | Return 400 for invalid input or 404 for an unknown alias with no upstream request |
| Unknown extras, disabled/enabled thinking hints, or reasoning_effort | An otherwise valid request is parsed | Accept it; only approved mappings are forwarded and core fields cannot be overridden |
| Either token-limit field, both fields, or an invalid supplied limit | A completion is requested | Map one positive limit with max_completion_tokens precedence, or return 400 even if the other field is valid |
| Every defined role, tool_choice variant, and optional absent/null/empty value | Validation runs | Match the contract exactly, including rejection of unknown roles, orphan tool results, and missing selected functions |
| A request exceeds the configured body limit | A completion is requested | Return HTTP 413 and make no upstream request |
| A valid text request | Either provider succeeds | Return an OpenAI-compatible JSON completion |
| Tool-only, truncated, filtered, content-only, or malformed upstream output | JSON is returned | Preserve valid finish reasons and null tool-only content; missing metadata or invalid shapes produce 502 |
| Upstream usage or optional reasoning_content is present or absent | A response is returned | Preserve supplied metadata without inventing token counts or requiring reasoning content |
| A request with stream: true or stream_options supplied | A completion is requested | Return HTTP 400 unsupported_parameter before upstream dispatch |
| A tool-capable request | The client sends tools and later their results | Preserve tool-call identifiers, arguments, result messages, and finish reasons in normalized JSON responses |
| The primary returns 429 or 503, has a network fetch failure within the 60-second total deadline, or times out before response commitment | The fallback succeeds | Make exactly one fallback attempt and return its response |
| The primary returns a validation or credential error | A completion is requested | Surface the error without attempting fallback |
| Both providers return 429 | A completion is requested | Return a clear HTTP 429 error without further attempts |
| Both providers are unavailable | A completion is requested | Return a bounded failure distinguishable from quota exhaustion |
| Timeout, protocol failure, upstream auth rejection, or mixed eligible failures | Attempts end before commitment | Use the contract's 504/502/final-attempt category and safe retry headers, never an HTTP 200 error |
| Downstream response commitment | Headers are committed | Deliver response without mid-flight fallback replay |
| The client disconnects or the request deadline expires | Upstream work is active | Cancel upstream work and make no further attempts |

The final smoke tests must run all three clients through the deployed gateway:
DeepSeek Review Action text, OpenCodeReview tool-call/tool-result/final-response,
and PR-Agent review. Prove each provider independently and controlled fallback.
Non-streaming JSON completions are certified for the MVP; streaming SSE is deferred to post-MVP.

## Language Choices on Cloudflare Workers

Workers does not require TypeScript. Cloudflare documents first-class support for
JavaScript, TypeScript, Python, and Rust, plus WebAssembly for other languages.

| Language | Execution model | Implication for this gateway |
| :--- | :--- | :--- |
| JavaScript / TypeScript | Workers' JavaScript runtime | Most direct access to HTTP requests, `fetch`, and streams; TypeScript adds static checking |
| Python | Pyodide, a CPython build compiled to WebAssembly inside a V8 isolate | Supported, but check package and standard-library compatibility; it is not an unrestricted server-side Python environment |
| Rust | WebAssembly with the `workers-rs` crate | Supported HTTP handling and streaming, with a Wasm build and Workers-specific bindings |
| Go | WebAssembly integration rather than a native Go server | Possible, but expect runtime integration work; not the simplest target for a normal `net/http` service |

For Workers, TypeScript remains a straightforward default, not a requirement.
Rust is a reasonable alternative when that is the preferred language. Python is
also viable after verifying the HTTP streaming path and required packages.
If native Go and portability are priorities, prefer a conventional HTTP service
over forcing Go into Workers' runtime.

Sources: [supported languages](https://developers.cloudflare.com/workers/languages/),
[Python runtime](https://developers.cloudflare.com/workers/languages/python/how-python-workers-work/),
[Python standard library](https://developers.cloudflare.com/workers/languages/python/stdlib/),
[Rust Workers](https://developers.cloudflare.com/workers/languages/rust/), and
[WebAssembly](https://developers.cloudflare.com/workers/runtime-apis/webassembly/).

## Deployment Options

The gateway mainly waits for upstream HTTP responses. Global edge deployment is
not a prerequisite for its routing behavior, and it does not increase upstream
free-tier allowances.

| Option | Language freedom | Benefits | Costs and constraints |
| :--- | :--- | :--- | :--- |
| Cloudflare Workers | JavaScript/TypeScript, Python, Rust, or Wasm integration | Managed HTTPS, no host upkeep, free-tier allowance, streaming support | Workers-specific APIs, runtime and resource limits; no native Go server |
| Existing always-on server | Any native runtime; Go can use the standard library | Reuse existing infrastructure, ordinary HTTP streaming, no platform translation | Host updates, restarts, TLS, ingress, and availability are your responsibility; the server still has operating costs |
| Google Cloud Run service | Any language packaged in a compatible container | Managed HTTPS, autoscaling, scale to zero, portable application runtime | Cold starts, request deadlines, billing setup, and possible compute, egress, build, and registry charges |
| Fly.io Machine | Native runtime deployed as a container | Conventional service deployment with optional autostop/autostart | Paid resource usage for new organizations, plus storage and egress costs; not an always-free deployment |
| Local daemon | Any native runtime | Smallest deployment for a single machine, private by default | Unavailable when the machine sleeps; other clients need private connectivity or a separately secured ingress |

Cloud Run services have a default five-minute request timeout, configurable up to
60 minutes. Streaming must remain within that deadline. Its free tier is an
allowance, not a hard spending cap; long-lived requests and internet egress can
incur charges. A Fly.io trial is not a perpetual free tier. An existing server
has low incremental cost only if capacity and operational support already exist.

Workers Free currently allows 100,000 requests per day and 10 ms of CPU time per
HTTP request. Waiting for upstream network responses does not consume that CPU
budget, but parsing and validating large payloads does. Benchmark parsing near the
10 MB payload ceiling during implementation; calibrate payload bounds or adopt
streaming validation if parsing approaches the CPU budget.

For every target, verify that client disconnects cancel upstream work and proxy
timeouts exceed the gateway's bounded deadline.
Keep deployment configuration version-controlled and credentials outside it.

### Selected Target: Cloudflare Workers (TypeScript / Hono)

Cloudflare Workers with TypeScript and the Hono framework is selected as the
sole deployment and runtime target for the MVP (see
[ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md)).

Selected zero-spend managed edge hosting and native Web Standards streams over
a conventional server process, operating within the 10 ms CPU time limit per
request on the Workers Free plan where upstream network wait time consumes no CPU budget.

Rationale:
- **Zero hosting spend**: Operates within the Cloudflare Workers Free allowance
  (100,000 requests/day, 10 ms CPU time per request; upstream network waiting does
  not consume CPU time).
- **Managed operations & HTTPS**: Zero server upkeep, automatic TLS termination,
  and globally distributed edge ingress.
- **Streaming & Web APIs**: Direct access to standard `fetch`, `Request`,
  `Response`, and `ReadableStream` primitives with Hono routing.
- **Local developer workflow**: Reproducible local emulation using Wrangler
  (`bunx wrangler dev`) without local containers.

Rejected alternatives:
- **Existing always-on server**: Rejected due to persistent maintenance burden,
  OS updates, manual TLS renewals, and operating overhead.
- **Google Cloud Run**: Rejected due to cold-start latency, container
  registry/build complexity, and variable billing risk on outbound network egress
  and idle compute.
- **Fly.io Machine**: Rejected because free trials are not permanent free tiers
  and new organizations require paid billing verification.
- **Local daemon**: Rejected because GitHub Actions runners cannot reach local
  ports without tunneling, and the service sleeps when the host machine sleeps.

Sources checked on 2026-10-05:

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- [Cloud Run overview](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run).
- [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract).
- [Cloud Run request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout).
- [Cloud Run pricing](https://cloud.google.com/run/pricing).
- [Fly.io pricing](https://fly.io/docs/about/pricing/).
- [Fly.io free trial](https://fly.io/docs/about/free-trial/).

## Search Gateway MVP Provider Selection and Release Milestone Gates

Status: Proposed design specification. The search gateway endpoints (`/v1/search`), provider adapters, and release milestone gates described below are not yet implemented in the active Cloudflare Worker runtime, which currently serves only the LLM Chat Completions MVP contract (`GET /v1/models`, `POST /v1/chat/completions`, and `POST /chat/completions`).

### Phase 1 Search MVP Provider Selection Criteria

Phase 1 restricts live search dispatch to providers that can operate under a strict zero-card financial boundary while enforcing deterministic quota exhaustion behavior.

#### Selected Phase 1 Candidates

- **Tavily (`tavily`, primary candidate)**:
  - **Free-tier allowance**: 1,000 free API credits per month on the Researcher plan (`1` credit for `basic` search depth, `2` credits for `advanced` search depth).
  - **Financial boundary**: Does not require a credit card at signup; enforces an upstream hard stop (HTTP 432 plan limit) when monthly credits are exhausted unless pay-as-you-go is manually enabled. HTTP 429 is a retryable rate limit and is not evidence of monthly exhaustion.
  - **Selection rationale**: Predictable per-query credit cost, purpose-built search snippet output for coding and research workflows, and zero-card signup make Tavily the safest primary provider for Phase 1.
- **Exa (`exa`, secondary fallback candidate)**:
  - **Free-tier allowance**: $10 in recurring monthly free credits with a calendar reset.
  - **Financial boundary**: Enforces an upstream hard stop (HTTP 402 Payment Required) when free credits are depleted without a saved payment method or auto-reload.
  - **Selection rationale**: Provides an independent neural/keyword search index for single-hop failover when Tavily is rate-limited or unavailable, while maintaining a hard financial stop.

#### Mandatory Account Verification Requirements Before Live Enablement

Before enabling either Phase 1 candidate in a deployed environment, the operator must verify all of the following account-level safeguards:

1. **Zero saved payment method or paid balance**: Confirm in the provider billing dashboard that no credit card, bank account, or backup payment method is attached and no purchased credit balance is available. Free grants and promotional credits must be distinguished from purchased credits; a zero-card account can still spend prepaid funds.
2. **Auto-recharge and pay-as-you-go disabled**: Confirm that automatic top-ups, overage billing, and pay-as-you-go toggles are explicitly disabled so exhaustion triggers an HTTP 402, HTTP 429, or HTTP 432 error instead of an invoice.
3. **Confirmed recurring free grant**: Verify on the active account that the free credit grant resets on a recurring monthly schedule rather than operating as a one-time promotional balance.
4. **Bounded per-request cost**: Restrict gateway adapter defaults to basic search execution (`basic` depth on Tavily; standard search without full-text crawl or research add-ons on Exa) so a single `/v1/search` call cannot consume multi-credit extraction charges.

#### Fail-Closed Policy (`FREE_ONLY_POLICY=true`) and Quarantined Providers

The search gateway must enforce `FREE_ONLY_POLICY=true` by default before live enablement. Under this fail-closed policy, the router must refuse to initialize or dispatch to any search provider that requires a payment instrument on file or lacks verified recurring free-tier hard stops:

- **Quarantined card-backed providers**: Brave Search API ($5/month credit tier requiring a credit card on file; PR #178 reports a prepaid, no-subscription model, so overage exposure depends on the account's recharge settings) and Parallel Search API (paid per-request billing) are blocked from Phase 1 dispatch.
- **Quarantined unverified or trial-only providers**: Linkup (PR #178 documents a conditional monthly top-up and HTTP 429 exhaustion response, but account eligibility, card and auto-recharge policy remain unverified; PR #208 also identifies an API-wrapper restriction), Jina Search (`s.jina.ai`, non-recurring trial balance with paid reload), and Serper.dev (one-time signup credit pool without recurring monthly reset) are excluded from Phase 1 default routing.

#### Search MVP Non-Goals

To preserve the Cloudflare Workers 10 ms CPU budget, 60-second request deadline, and zero-spend guarantee, the following capabilities are explicitly out of scope for the Phase 1 Search MVP:

- **No full-page crawling or content extraction in `/v1/search`**: The search endpoint returns normalized titles, URLs, snippets, and scores only. Deep web crawling, raw HTML scraping, and multi-page research jobs are excluded.
- **No multi-provider speculative fan-out**: The gateway dispatches sequentially to at most one primary provider and one fallback provider on eligible transient failures. It never queries multiple search providers in parallel to merge or rerank results.
- **No unauthenticated SearXNG or HTML scraping**: Public SearXNG instances and direct search engine HTML scraping are rejected due to bot mitigation, CAPTCHA blocks, IP bans, and lack of SLA guarantees.
- **No persistent search result caching**: The Phase 1 gateway remains stateless and does not store query payloads or search results in Cloudflare KV, D1, or external databases.

### Graduation Gates for Card-Backed Search Providers

Card-backed search providers (such as Brave Search API and Parallel Search API) cannot be enabled in production until all four graduation gates below are implemented, tested, and signed off:

1. **Cloudflare Durable Object Atomic Quota Reservation Coordinator (#134, #135)**:
   - A strongly consistent Cloudflare Durable Object coordinator is deployed in an isolated production environment to serialize credit checks and decrement monthly provider budgets atomically before any upstream HTTP request is dispatched.
   - Cloudflare KV is explicitly prohibited for financial quota enforcement due to eventual consistency and concurrent write race conditions.
2. **Reservation Lifecycle and Upstream Timeout Uncertainty Handling (#136)**:
   - Every quota reservation follows a strict state machine (`reserved` -> `committed` or `released`).
   - When an upstream request times out, disconnects after request transmission, or returns an ambiguous transport error where upstream billing cannot be ruled out, the reservation remains committed (or enters a conservative quarantine state) so timed-out requests never silently leak paid credits.
3. **Concurrent Reservation Race-Condition Safety (#137)**:
   - Automated concurrency tests prove that parallel bursts targeting the exact remaining credit boundary cannot over-allocate quota or bypass the configured monthly cap under simultaneous Worker invocations.
4. **Provider Terms of Service Compliance and Explicit Operator Opt-In (#159)**:
   - Legal and operational review confirms that gateway proxying, snippet normalization, and automated coding-agent queries comply with the target provider's Terms of Service.
   - Production activation requires explicit operator configuration (`FREE_ONLY_POLICY=false`, `ALLOW_CARD_BACKED_PROVIDERS=true`, and a hard numeric monthly budget cap per provider). Missing any of these settings fails closed at startup.

### Phase 1 through Phase 5 Release Milestone Gates

| Milestone Phase | Scope | Entry Prerequisites | Exit and Release Verification Gates |
| :--- | :--- | :--- | :--- |
| **Phase 1: Search MVP Foundation and Fail-Closed Policy** | Define `/v1/search` contract, error taxonomy, financial safety matrix, and stateless sequential routing (`tavily` primary, `exa` fallback) under `FREE_ONLY_POLICY=true`. | Approved Search MVP specifications (#109, #110, #111, #112) and verified zero-card Tavily/Exa accounts. | Contract validation tests pass; `FREE_ONLY_POLICY=true` rejects card-backed or unconfigured providers at startup; sequential failover on eligible primary failures (including retryable Tavily HTTP 429 rate-limit responses and HTTP 503/timeouts triggering the single fallback attempt to Exa), non-retryable client/auth error surfacing (HTTP 400/401/403 without fallback), and terminal quota-exhaustion or all-provider exhaustion surfacing (HTTP 402/429/432 when no eligible fallback remains) pass with mocked upstreams and live smoke tests. |
| **Phase 2: Distributed Atomic Quota Reservations** | Implement Cloudflare Durable Object quota coordinator (#134, #135), reservation state machine (#136), and concurrency safety harness (#137). | Phase 1 exit gates passed; Durable Object bindings and storage migrations provisioned in isolated staging/production environments. | Zero quota over-allocation under simulated parallel load (#137); upstream timeouts preserve conservative credit accounting (#136); coordinator unavailability fails closed before upstream dispatch. |
| **Phase 3: Secondary Provider Expansion** | Onboard card-backed or secondary search providers (such as Brave Search; Linkup stays excluded until the PR #208 terms question and the PR #178 billing questions are resolved) behind the Durable Object quota coordinator and explicit operator opt-in flags. | Phase 2 exit gates passed; all four card-backed graduation gates (#134, #135, #136, #137, #159) verified. | Operator opt-in guards (`FREE_ONLY_POLICY=false`, `ALLOW_CARD_BACKED_PROVIDERS=true`, bounded monthly cap) enforced; adapter normalization and quota hard-stop tests pass for each expanded provider. |
| **Phase 4: Model Context Protocol Server and Coding Agent Integration** | Expose `/v1/search` through an MCP server interface and integrate search tool definitions with automated code review and coding agents. | Phase 1 (and optional Phase 2/3) search gateway deployed and stable; MCP tool schema and authentication contract defined. | End-to-end MCP client and coding-agent smoke tests pass against the deployed gateway with bounded latency, structured error propagation, and zero credential leakage in logs. |
| **Phase 5: Offline Quality Evaluation and Extended Content Extraction** | Benchmark cross-provider relevance/latency offline and evaluate optional separate endpoints for bounded content extraction (`POST /v1/extract`). | Stable production telemetry from Phases 1-4 and explicit per-operation credit multipliers defined in the quota coordinator. | Offline evaluation harness produces reproducible relevance/cost reports; any extraction endpoint enforces isolated credit budgets without regressing `/v1/search` 10 ms Worker CPU bounds. |

### Evidence and Limitations

The provider economics and terms baseline depends on the comparison in [PR #178](https://github.com/gordonpn/shunt-shim/pull/178) (`docs/FREE_TIERS.md` section 7, verified there on November 12, 2026 with Linkup updated November 19) and the terms audit in [PR #208](https://github.com/gordonpn/shunt-shim/pull/208) (`docs/research/search-provider-terms.md`, checked November 15, 2026). Both remain merge prerequisites for this specification. Their publication does not verify account eligibility or runtime enforcement.

- Exa ($10 monthly balance, HTTP 402 hard stop), Brave (card required, prepaid), Parallel (card required), and Linkup (conditional monthly top-up, eligibility and billing controls still unverified) match PR #178. Linkup's [pricing documentation](https://docs.linkup.so/pages/documentation/platform/pricing), rechecked November 26, 2026, states that eligible accounts are topped back up to $20 monthly and exhausted accounts return HTTP 429.
- Tavily's 1,000 monthly credits and no-card Researcher plan match PR #178. Its official [Search API response documentation](https://docs.tavily.com/documentation/api-reference/endpoint/search), checked November 26, 2026, distinguishes HTTP 429 excessive-request rate limits from HTTP 432 plan usage limits. These are upstream statuses; gateway error mapping and bounded failover still require implementation tests.
- These are published offers, not guarantees about a particular account, which is why the account verification checklist above is mandatory before live enablement.
- No search code path enforces the milestone gates yet: `src/search` on `main` has the registry, quota policy, and router, but no `/v1/search` route.

### Next Action

Merge PR #178 and PR #208 first, then reconcile the approved economics and terms baseline with this specification. Complete the account checklist and verify the deployed search route, adapters, error mapping and fail-closed policy before live enablement (#113, #130, #197). Phase 2 and later work is already tracked in #134, #135, #136, #137, and #159, so no new issue is needed.
