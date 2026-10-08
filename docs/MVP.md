# MVP Scope and Deployment Options

Status: proposal, not implemented. The repository currently contains design
documentation, environment examples, and task-runner scaffolding, but no gateway
implementation. Language and deployment platform remain undecided.

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
| Responses | Non-streaming JSON and streaming SSE |
| Coding support | System/user/assistant/tool messages, function tools, tool results, both token-limit fields, optional reasoning metadata and usage |
| Failover | At most one fallback attempt, on upstream HTTP 429, HTTP 503, or a connection timeout |
| Safety | Authentication and payload validation before upstream dispatch; body limits, bounded timeouts, and cancellation |
| Diagnostics | Provider, actual model, status, latency, and fallback reason; no prompts, completions, or credentials |

Validate core fields, reject unknown aliases, and define the subset shared by the
selected models. Tolerate unknown extension fields, including thinking and
reasoning hints; forward only approved provider mappings and ignore other extras.
Never let extensions override validated fields or credentials. Do not select paid
models or forward caller credentials upstream.

Fallback is permitted only before committing the downstream response. Once a
stream starts, never replay the request on another provider. Do not conceal
upstream validation or credential failures behind a fallback. If all candidates
are rate-limited, return an OpenAI-style HTTP 429 error; upstream unavailability
must remain distinguishable from quota exhaustion.

Use both providers' OpenAI-compatible endpoints initially:

- [Groq chat completions](https://console.groq.com/docs/api-reference).
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai),
  including streaming and function calling.

This avoids a native Gemini request adapter and custom SSE translator. Verify
the actual client and model behavior before claiming compatibility. Preserve
streamed tool-call fields and finish reasons, not just text deltas.

## Deferred

- Proactive quota prediction, shared counters, and circuit-breaker state.
- Tenant priorities, per-project accounting, and reserved capacity.
- Token estimation and automatic large-context routing.
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
| Valid Bearer, x-api-key, or matching dual credentials | Either completion path is requested | Execute identical auth, validation, routing, JSON/SSE, and error behavior |
| Valid gateway credentials | The model catalog is requested | Return exactly the supported `fast` alias in OpenAI model-list format |
| Malformed JSON/core fields, invalid messages/tools, or an unknown alias | A completion is requested | Return 400 for invalid input or 404 for an unknown alias with no upstream request |
| Unknown extras, disabled/enabled thinking hints, or reasoning_effort | An otherwise valid request is parsed | Accept it; only approved mappings are forwarded and core fields cannot be overridden |
| Either token-limit field, both fields, or an invalid supplied limit | A completion is requested | Map one positive limit with max_completion_tokens precedence, or return 400 even if the other field is valid |
| Every defined role, tool_choice variant, and optional absent/null/empty value | Validation runs | Match the contract exactly, including rejection of unknown roles, orphan tool results, and missing selected functions |
| A request exceeds the configured body limit | A completion is requested | Return HTTP 413 and make no upstream request |
| A valid text request | Either provider succeeds | Return an OpenAI-compatible JSON completion |
| Tool-only, truncated, filtered, content-only, or malformed upstream output | JSON is returned | Preserve valid finish reasons and null tool-only content; missing metadata or invalid shapes produce 502 |
| Upstream usage or optional reasoning_content is present or absent | A response is returned | Preserve supplied metadata without inventing token counts or requiring reasoning content |
| A valid streaming request | Either provider succeeds | Deliver incremental SSE events without buffering the whole response and preserve the completion terminator |
| stream_options.include_usage is true, false, or absent | A streaming response completes | For true preserve the final choices=[] usage event before [DONE]; other cases must also parse correctly |
| A tool-capable request | The client sends tools and later their results | Preserve tool-call identifiers, arguments, result messages, and finish reasons in JSON and streaming responses |
| The primary returns 429 or 503, or times out before response commitment | The fallback succeeds | Make exactly one fallback attempt and return its response |
| The primary returns a validation or credential error | A completion is requested | Surface the error without attempting fallback |
| Both providers return 429 | A completion is requested | Return a clear HTTP 429 error without further attempts |
| Both providers are unavailable | A completion is requested | Return a bounded failure distinguishable from quota exhaustion |
| Timeout, protocol failure, upstream auth rejection, or mixed eligible failures | Attempts end before commitment | Use the contract's 504/502/final-attempt category and safe retry headers, never an HTTP 200 error |
| The primary has already begun streaming | The stream fails | End the failed stream without replaying on the fallback |
| The client disconnects or the request deadline expires | Upstream work is active | Cancel upstream work and make no further attempts |

The final smoke tests must run all three clients through the deployed gateway:
DeepSeek Review Action text, OpenCodeReview tool-call/tool-result/final-response,
and PR-Agent review. Prove each provider independently and controlled fallback.
Streaming remains required for the MVP; a text-only smoke test is insufficient.

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
budget, but parsing and validating large payloads does. Verify CPU usage with the
largest supported request before choosing the free plan.

For every target, verify that the ingress does not buffer SSE, client disconnects
cancel upstream work, and proxy timeouts exceed the gateway's bounded deadline.
Keep deployment configuration version-controlled and credentials outside it.

### Shortlist

- Choose **Workers** when minimal operations and free hosting matter more than
  a conventional runtime.
- Choose **an existing server** when native Go or another preferred language,
  low incremental cost, and portability matter most.
- Choose **Cloud Run** when a conventional container runtime and managed
  operations matter enough to accept billing risk and cold starts.
- Consider **Fly.io** when a small paid service is acceptable and a conventional
  runtime is preferable to edge-specific APIs.
- Choose **a local daemon** only if the initial requirement is single-machine use.

Do not implement multiple deployment targets for the MVP. Select one after
confirming the preferred language, whether an always-on server is available,
and whether zero possible hosting spend is a requirement.

Sources checked on 2026-10-05:

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- [Cloud Run overview](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run).
- [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract).
- [Cloud Run request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout).
- [Cloud Run pricing](https://cloud.google.com/run/pricing).
- [Fly.io pricing](https://fly.io/docs/about/pricing/).
- [Fly.io free trial](https://fly.io/docs/about/free-trial/).
