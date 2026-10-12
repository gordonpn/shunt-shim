# Review Client Compatibility Contract

Status: required MVP behavior, not implemented or certified. The targets are
DeepSeek Review, OpenCodeReview, and PR-Agent without client code changes.
Account-specific model capabilities must still be verified on Groq and Gemini.

## Source-verified client configuration

Checked on 2026-10-06 against pinned source revisions. Use the same gateway secret
in each client's credential setting; keep upstream credentials on the gateway.

| Client | Settings for `https://proxy.example.com` | Verified behavior |
| :--- | :--- | :--- |
| [DeepSeek Review v1](https://github.com/hustcer/deepseek-review/blob/eccde2e9781008d795e366b951e313e37af88dd5/nu/review.nu#L148-L216) | Action [inputs](https://github.com/hustcer/deepseek-review/blob/eccde2e9781008d795e366b951e313e37af88dd5/action.yaml): `base-url=https://proxy.example.com/v1`, `model=fast`, `chat-token=<gateway secret>` | Appends `/chat/completions`, sends Bearer auth and `thinking.type=disabled`; Actions use non-streaming, local CLI can stream |
| [OpenCodeReview](https://github.com/alibaba/open-code-review/blob/182898cf522da3d04157b422752d028417974e19/action.yml) | Action `llm_protocol=openai`, `llm_url=https://proxy.example.com/v1/chat/completions`, `llm_model=fast`, `llm_auth_token=<gateway secret>` | Select OpenAI explicitly; default extra body disables thinking; default LLM timeout is 300 seconds |
| [PR-Agent](https://github.com/The-PR-Agent/pr-agent/blob/99b72f62abb4c6dc7ebde98818dc535cf54d8023/docs/docs/usage-guide/changing_a_model.md#L711-L768) | `config.model=openai/fast`, `config.fallback_models=[]`, `openai.api_base=https://proxy.example.com/v1`, secret `OPENAI__KEY=<gateway secret>` | OpenAI prefix selects LiteLLM's compatible route; set `config.custom_model_max_tokens` to the verified shared context limit |

PR-Agent's prefix is client routing metadata; the gateway receives `fast`. Do not
configure external client fallback models. Check weak/reasoning model overrides
and automatic review settings in the pinned client before running smoke tests.
Record the resolved action/image/CLI revision and LiteLLM version in evidence.

OpenCodeReview accepts a base URL or full endpoint in its
[client constructor](https://github.com/alibaba/open-code-review/blob/182898cf522da3d04157b422752d028417974e19/internal/llm/client.go#L585-L605).
Its [request builder](https://github.com/alibaba/open-code-review/blob/182898cf522da3d04157b422752d028417974e19/internal/llm/client.go#L880-L945)
uses tool-result messages, JSON-string function arguments, and
`max_completion_tokens`. Its [streaming branch](https://github.com/alibaba/open-code-review/blob/182898cf522da3d04157b422752d028417974e19/internal/llm/client.go#L685-L709)
requests usage by default. Bearer is the verified OpenAI-mode path; configurable
authentication headers elsewhere in the client do not prove OpenAI-mode support.

## HTTP and request contract

- `POST /v1/chat/completions` and `POST /chat/completions` execute the same handler,
  with identical auth, validation, routing, errors, JSON, and SSE behavior.
- `GET /v1/models` returns exactly `fast`. Model names are configured opaque
  aliases, not an OpenAI model-name allowlist or arbitrary provider bypass.
- Accept `Authorization: Bearer <token>` or `x-api-key: <token>` against one
  independently generated gateway secret. Neither header: 401. Malformed or
  invalid supplied credentials: 401. If both are supplied, both must match the
  configured secret; reject conflicting credentials. Never forward either.
- Require a JSON object, nonempty model string, and nonempty messages array.
  Support text `system`, `user`, `assistant`, and `tool` roles. Assistant content
  can be null or omitted when tool calls are present; other text content is a
  string. Validate tool-result IDs against preceding assistant calls, including
  multiple calls and results; each result resolves one outstanding call ID once.
  Reject multimodal blocks and malformed core fields.
- Accept standard function `tools` and `tool_choice` values `auto`, `required`,
  `none`, or a named function selector. A selected function must exist. Absent
  tools permit absent choice or `none`; other choices require nonempty tools.
- Support optional finite temperature in the verified shared range and positive
  integer output limits. Accept both
  `max_tokens` and `max_completion_tokens`; the latter wins when both are valid.
  Validate both supplied values and map exactly one winning limit to each upstream's supported
  field. Account verification confirms Gemini rejects requests containing both fields with
  HTTP 400 (`max_tokens and max_completion_tokens cannot both be set`), making dispatch
  normalization to a single parameter mandatory.
  See [Groq verification report](GROQ_CAPABILITY.md) and [Gemini verification report](GEMINI_CAPABILITY.md).
- `stream` defaults to false and must be boolean. Accept
  `stream_options.include_usage` as boolean for streaming; reject non-null
  stream options when streaming is false. Omitted/null optional options use
  defaults; empty tools mean no tools. Empty messages remain invalid.
- Accept `thinking` and `reasoning_effort` as compatibility extensions. Preserve
  unknown fields in the parsed request without rejecting them. Only an explicit
  per-provider mapping may forward extensions; otherwise ignore them. Extensions
  cannot override model, endpoint, auth, or validated core fields. Ignoring a
  reasoning hint does not promise reasoning support or disable upstream thinking.

Use the two upstreams' OpenAI-compatible endpoints and a small validated request
representation. Normalize output limits and approved extensions at dispatch.
Native Anthropic/Gemini adapters and a general provider IR are deferred.

### Shared request bounds

| Parameter / Bound | Value | Units | Enforcement Behavior |
| :--- | :--- | :--- | :--- |
| Inbound Request Body Limit | 10,485,760 | bytes (10 MB) | Immediate HTTP 413 `payload_too_large` response prior to JSON parse; zero upstream dispatch. On the Workers Free plan (10 ms CPU limit), parsing near-limit payloads will be benchmarked; streaming parsing or payload ceiling calibration applies if parsing approaches CPU budget. |
| Shared Context Window Ceiling | 128,000 | tokens | Combined prompt and requested output limit (`prompt_tokens + max_completion_tokens <= 128,000`). Bounded by Groq context on verified models (`openai/gpt-oss-120b`, `qwen/qwen3.8-27b`). PR-Agent configured with `config.custom_model_max_tokens=128000`. Combined token requests exceeding 128k return HTTP 400 `context_length_exceeded` prior to upstream dispatch. |
| Max Output Tokens Bound | 8,192 | tokens | Accepted in `max_tokens` or `max_completion_tokens`. Both Groq and Gemini support up to 8,192 completion tokens. |
| Upstream Connect Timeout | 5,000 | ms (5s) | Per-attempt connection deadline. Connection failure or reaching the 5s connect deadline on Attempt 1 triggers eligible fallback before response commitment. |
| Upstream Attempt Timeout | 60,000 | ms (60s) | Per-attempt execution deadline. Attempt 1 reaching 60s without committing response headers triggers eligible fallback if remaining gateway deadline permits; Attempt 2 reaching 60s triggers HTTP 504 `gateway_timeout`. |
| Total Gateway Deadline | 150,000 | ms (150s) | Bounded wall-clock deadline across all attempts. Expiration before response commitment terminates request with HTTP 504 `gateway_timeout`. Expiration after response commitment terminates active stream without emitting `[DONE]`. |

Client and ingress timeout alignment:
- DeepSeek Review v1 Nu review script default timeout: 180 seconds.
- OpenCodeReview default LLM client timeout: 300 seconds.
- PR-Agent LiteLLM default client timeout: 300 seconds.
- Cloudflare Workers edge network streaming timeout: 180 to 300 seconds (configured to exceed the 150s gateway total deadline by at least 30 seconds to guarantee delivery of HTTP 504 responses prior to edge termination).
All client and edge ingress timeouts exceed the gateway's 150s bounded total deadline.

### Request validation pipeline and status precedence

Validation checks run in the following strict sequential pipeline before upstream dispatch to guarantee mutually exclusive status outcomes:
1. **Endpoint Existence**: Unmatched route paths return HTTP 404 Not Found (`invalid_request_error`) prior to authentication.
2. **HTTP Method**: Matched routes requested with unsupported HTTP methods return HTTP 405 Method Not Allowed (`invalid_request_error`) with an `Allow` header prior to authentication.
3. **Gateway Authentication**: Requests to supported routes with missing, malformed, or invalid credentials return HTTP 401 Unauthorized (`invalid_api_key`).
4. **Inbound Body Size**: Authenticated requests exceeding 10,485,760 bytes return HTTP 413 Payload Too Large (`payload_too_large`) prior to JSON parsing.
5. **Payload Schema & Model Alias**: Authenticated requests within size limits are parsed. Malformed JSON or invalid schema (empty messages, unknown roles, or invalid tool calls) returns HTTP 400 Bad Request (`invalid_request_error`). Unknown model aliases (any string other than `fast`) return HTTP 404 Not Found (`model_not_found`). Combined token budgets exceeding 128,000 return HTTP 400 Bad Request (`context_length_exceeded`).

### Unsupported methods and endpoints

| Endpoint Path | HTTP Method | Gateway Status | Error Code | Response Details |
| :--- | :--- | :--- | :--- | :--- |
| `/v1/chat/completions`, `/chat/completions` | GET, PUT, DELETE, PATCH | 405 Method Not Allowed | `invalid_request_error` | Evaluated at step 2. Header `Allow: POST`. Zero upstream invocation. |
| `/v1/models` | POST, PUT, DELETE, PATCH | 405 Method Not Allowed | `invalid_request_error` | Evaluated at step 2. Header `Allow: GET`. Zero upstream invocation. |
| Any unrecognized route (e.g., `/v1/embeddings`, `/v1/responses`) | Any | 404 Not Found | `invalid_request_error` | Evaluated at step 1. Unsupported endpoint. Zero upstream invocation. |
| Supported route | Supported method | 401 Unauthorized | `invalid_api_key` | Evaluated at step 3. Missing, malformed, or mismatching credentials. |
| Supported route | Supported method | 413 Payload Too Large | `payload_too_large` | Evaluated at step 4. Body size > 10,485,760 bytes. Zero upstream invocation. |
| `/v1/chat/completions`, `/chat/completions` | POST | 404 Not Found | `model_not_found` | Evaluated at step 5. Unknown model alias (model string other than `fast`). |

## Response and failure contract

- JSON responses have `id`, `object=chat.completion`, Unix `created`, model,
  and nonempty `choices` with index, assistant message, and a valid finish reason.
  Text content is a string; concatenate valid upstream text blocks in order and
  reject non-text or malformed blocks with 502. A tool-only message may have null
  content; preserve
  stable call IDs, function names, JSON-string arguments, and `tool_calls` finish
  reason. Supported final reasons are `stop`, `length`, `tool_calls`, and
  `content_filter`. Never rewrite truncation or filtering to `stop`; empty finish
  reasons and invalid upstream shapes are protocol errors.
- Preserve upstream `usage` token counts and optional token details when present;
  never fabricate zero usage. Optional `reasoning_content` may be preserved, but
  content-only completions must work. No reasoning generation guarantee is made.
- Streaming uses `text/event-stream`, incremental `chat.completion.chunk` events,
  stable IDs/model/created, indexed text/tool deltas, null interim finish reasons,
  and a final finish reason followed by `data: [DONE]`. Preserve fragmented tool
  arguments and multiple calls. Never buffer the entire completion or synthesize
  a successful terminator after upstream failure. With include_usage, preserve
  the final usage-only event with `choices=[]` before `[DONE]`; provider evidence
  must establish this capability before claiming streamed-usage compatibility.
- Errors use an OpenAI-style `error` object with message, type, param, and code.
  Map invalid input to 400, gateway auth to 401, unknown alias to 404, body limit
  to 413, quota exhaustion to 429, internal failure to 500, invalid upstream
  response or upstream credential rejection to 502, exhausted unavailability to
  503, and exhausted timeout/deadline to 504. Never embed failures in HTTP 200.
- Preserve safe `Retry-After` and request/token rate-limit headers from the final
  failing attempt. Mixed failures use the final attempt's category; both 429s
  remain 429. No fallback for validation, upstream auth, or protocol errors.
- One Groq attempt and at most one Gemini attempt share one bounded total
  deadline. Fallback eligibility and response commitment follow [MVP](MVP.md).
  No replay after downstream headers/body are committed. Select deadlines within
  each client's timeout and configure ingress timeouts above the gateway bound.

### Downstream commitment point (streaming)

The downstream commitment point is defined as the moment the gateway flushes HTTP 200 response headers (`Content-Type: text/event-stream`) to the downstream client. Once headers are committed to the network, the HTTP status is finalized and cannot be converted to an error or fallback response.

- **Provider lock**: As soon as HTTP 200 response headers are committed, the chosen upstream provider is permanently locked. No fallback or status code changes are possible once headers are in flight.
- **Zero mid-stream replay**: The gateway will strictly never replay a request on the fallback provider once response headers are sent.
- **Mid-stream failure handling**: If the upstream provider disconnects, aborts, errors, or reaches a deadline after downstream header commitment, the gateway terminates the downstream connection immediately without emitting a synthetic `data: [DONE]` terminator. The client observes a truncated stream and handles the transport error.
- **Client disconnect cancellation**: The Worker environment enables the `enable_request_signal` compatibility flag, propagating client disconnection through `Request.signal` to cancel active upstream fetches via `AbortController`.

### Mixed-failure mapping and observable outcomes

When Attempt 1 (Groq) fails with an eligible error (HTTP 429, HTTP 503, connect failure / 5s connect timeout, or 60s execution timeout) before downstream response header commitment, Attempt 2 (Gemini fallback) executes within the remaining time of the 150s total deadline.

The returned HTTP status code and OpenAI-compatible error object match the final failing attempt:

| Primary Attempt (Groq) | Fallback Attempt (Gemini) | Gateway Status | Error Code | Observable Outcome / Behavior |
| :--- | :--- | :--- | :--- | :--- |
| 429 Too Many Requests | 200 OK | 200 OK | (None) | Fallback succeeds; return Gemini completion. |
| 503 Service Unavailable | 200 OK | 200 OK | (None) | Fallback succeeds; return Gemini completion. |
| Connect Timeout (5s) | 200 OK | 200 OK | (None) | Fallback succeeds; return Gemini completion. |
| Attempt 1 Timeout (60s) | 200 OK | 200 OK | (None) | Fallback succeeds; return Gemini completion. |
| 429 Too Many Requests | 429 Too Many Requests | 429 | `rate_limit_exceeded` | All providers rate-limited; preserve `Retry-After` from final attempt. |
| 429 Too Many Requests | 503 Service Unavailable | 503 | `service_unavailable` | Final attempt unavailable; return 503 error. |
| 503 Service Unavailable | 429 Too Many Requests | 429 | `rate_limit_exceeded` | Final attempt rate-limited; return 429 error. |
| 503 Service Unavailable | 503 Service Unavailable | 503 | `service_unavailable` | Both providers unavailable; return 503 error. |
| Eligible failure (429/503/timeout) | Attempt Timeout (60s) | 504 | `gateway_timeout` | Fallback attempt timed out before commitment; return 504 error. |
| Eligible failure (429/503/timeout) | Total Deadline (150s) | 504 | `gateway_timeout` | Total deadline expired before commitment; return 504 error. |
| Connect Timeout (5s) | 429 Too Many Requests | 429 | `rate_limit_exceeded` | Final attempt rate-limited; return 429 error. |
| Connect Timeout (5s) | Connect Timeout (5s) | 504 | `gateway_timeout` | Both provider connection attempts timed out; return 504 error. |
| 400 Bad Request | (No fallback) | 502 | `bad_gateway` | Upstream validation failure; do not retry; return 502 error. |
| 401 / 403 Unauthorized | (No fallback) | 502 | `bad_gateway` | Upstream credential failure; do not expose upstream keys; return 502 error. |
| Headers committed (200 SSE) | Upstream failure / timeout | 200 | (Aborted) | Stream severed without `[DONE]`; zero fallback replay. |
| Client disconnect | (In progress) | (Closed) | (Aborted) | Abort upstream fetch immediately via AbortController. |

## Evidence required before compatibility claims

Automate every row in [MVP acceptance criteria](MVP.md#acceptance-criteria), including
negative cases, with mocked upstreams. Verify successful JSON, tools, SSE, and
usage independently for each account-selected model. Run DeepSeek Review's Action
text review, OpenCodeReview's complete tool cycle, and PR-Agent's review through
the deployed gateway; test streaming via supported client modes and fixtures.
Repeat OpenCodeReview's tool cycle with a controlled eligible primary failure.
Record sanitized revisions, settings, request IDs, results, and commands under
`docs/`. A contract fixture or successful text response alone is not proof that
all three real clients work. Paid routing, cost accounting, and circuit breakers
remain outside the MVP.
