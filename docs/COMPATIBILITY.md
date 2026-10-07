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
| [PR-Agent](https://github.com/The-PR-Agent/pr-agent/blob/99b72f62abb4c6dc7ebde98818dc535cf54d8023/docs/docs/usage-guide/changing_a_model.md#L711-L768) | `config.model=openai/fast`, `config.fallback_models=["openai/fast"]`, `openai.api_base=https://proxy.example.com/v1`, secret `OPENAI__KEY=<gateway secret>` | OpenAI prefix selects LiteLLM's compatible route; set `config.custom_model_max_tokens` to the verified shared context limit |

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
  Validate both supplied values and map one limit to each upstream's supported
  field. Document model-specific bounds after account verification.
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
