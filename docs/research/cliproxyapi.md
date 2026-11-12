# CLIProxyAPI patterns for Shunt Shim

Research for [#97](https://github.com/gordonpn/shunt-shim/issues/97), part of
[#64](https://github.com/gordonpn/shunt-shim/issues/64). Checked 2026-11-12 against
CLIProxyAPI commit [`1aaf56bc6a0fc6fce19049ba7ae8554c882304a6`](https://github.com/router-for-me/CLIProxyAPI/commit/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6).
This is a source review, not a deployed interoperability or security certification.

**Recommendation:** retain Shunt Shim's two official OpenAI-compatible upstreams
and bounded failover. Learn from CLIProxyAPI's explicit protocol mappings,
eligibility filtering and failure taxonomy; do not import its account pool,
OAuth lifecycle or server control plane.

This report is standalone so the independent LiteLLM research can edit
`gateway-patterns-comparison.md` without a concurrent same-file change. A follow-up
comparison index/section can link here; that requested integration is still outstanding.
No runtime code, dependency, OAuth flow or credential is added.

## Verified behavior and implications

### Translation and compatibility

The [translator types](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/sdk/translator/types.go) separate request,
streaming response, non-streaming response and token-count transforms. Request
transforms can return a request-scoped refusal before dispatch.
The [registry](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/sdk/translator/registry.go) selects source/target
transforms and supports normalization/plugin hooks. Missing transforms can fall
back to the original body: registration is not proof that every protocol pair
is semantically compatible. Shunt Shim should reject unsupported capabilities
explicitly rather than use an unverified raw fallback.

The actual source directory is `internal/translator/`, rather than the
issue's suggested `internal/translation/`; public handlers also live under
`sdk/api/handlers/`. Representative inspected routes:

- [OpenAI Chat Completions to Gemini](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/internal/translator/gemini/openai/chat-completions/gemini_openai_request.go)
  maps reasoning effort to thinking configuration, assistant tool calls to
  `functionCall`, tool results to `functionResponse`, and tool declarations
  and choices to Gemini configuration. Tool-result association is scoped to
  the assistant turn. Name collisions fail closed for function selection.
- [Responses to Claude](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/internal/translator/claude/openai/responses/claude_openai-responses_request.go)
  maps function/custom calls to `tool_use`, outputs to `tool_result`,
  reasoning effort to thinking, and tools to input schemas. It handles
  provider-specific details including tool search, name/ID normalization and
  errored tool outputs. Some recovery synthesizes missing tool-result messages;
  that is a policy choice Shunt Shim should not copy into its stricter validator.

These mappings demonstrate why a universal format claim is too broad. Gemini
code maps supported inline image/video/audio forms but tracks dropped parts;
Claude code explicitly notes there is no audio block. Unsupported content can
be dropped during translation. Shunt Shim's current text/function-tool contract
should continue rejecting unsupported core content before dispatch, and preserve
tool IDs, arguments, result messages, null tool-only content, finish reasons and
optional usage without inventing values.

### Account selection, affinity, quota and retries

The pinned [configuration](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/config.example.yaml) documents
`round-robin` (default), `weighted-round-robin` and `fill-first`.
The [selector](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/sdk/cliproxy/auth/selector.go) rotates from the previous
credential identity because retry exclusions and cooldown shrink candidate
sets; indexing a counter into a changing set could starve accounts.
The [weighted implementation](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/sdk/cliproxy/auth/selector_weighted.go)
uses eligible-pool accounting and speculative reservations. Config documents
integer weights (default 1, maximum 1,000,000), exclusion of non-positive weights,
bounded compensation and process-local credits reset on restart. Weights are
approximate scheduling preferences, not reserved quota or proof of capacity.

Session affinity is optional (default false), with a one-hour binding TTL.
Configuration documents explicit client session headers followed by cache keys,
conversation/body IDs, execution identity, longest-common-prefix/compaction and
derived/first-message identities. Established eligible bindings outrank recovered
higher-priority credentials. Child sessions may inherit parent bindings.
Rebinding modes are `any`, `quota`, and `never`; the last can prevent failover
for an established binding. This is stateful cache-locality routing, not a
requirement for stateless Chat Completions. Prompt-derived identity and retained
bindings introduce privacy and cross-instance-consistency questions.

Retry defaults are especially unsuitable to copy: three **additional rounds**
after the initial round exhausts eligible credentials, a per-round credential
cap of zero meaning all, and up to 30 seconds cooldown wait between rounds.
Per-credential overrides filter admission to later rounds. Documented retry
statuses include 403, 408, 429, 500, 502, 503 and 504.
[Execution code](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/sdk/cliproxy/auth/conductor_execution.go) carries round
metadata, attempted sets, retry settings and context cancellation checks.
[Cooldown code](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/sdk/cliproxy/auth/conductor_cooldown.go) tracks auth/model
state and retry hints, optionally persists snapshots, and distinguishes local
ownership from Home-managed state. Config exposes optional cooldown sidecar
persistence; memory state is the default for that feature.

None of these controls creates quota. A process's cooldown knowledge is not a
globally atomic account budget. Shunt Shim must retain exactly one eligible
fallback, the five-second connect/header bound and 60-second total deadline,
with no fallback on validation/credential failures. Do not broaden its status
allowlist merely because CLIProxyAPI retries more categories.

### Authentication and credential lifecycle

Configuration separates downstream `access.api-keys` from upstream API-key groups
and OAuth/file-backed credentials. The [login manager](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/sdk/auth/manager.go)
calls provider authenticators, merges existing credential metadata and saves via
a store; it also contains legacy credential migration/cleanup paths.
This is a credential lifecycle subsystem, substantially beyond one gateway
secret plus deployment-managed upstream secrets.

Adopt the separation of client authentication, route selection and provider
credential ownership. Avoid browser/device login, refresh workers, auth-file
uploads, token migration and dynamic credential management in the Worker.
Do not forward caller credentials or accept caller-selected base URLs.
The review does not establish provider authorization terms, refresh-token
security, or suitability of subscription OAuth accounts for this service.

### Streams, WebSockets and extensions

Configuration exposes SSE keepalives and bootstrap retries before first byte,
non-streaming blank-line keepalives, WebSocket authentication options and
provider-specific media behavior. The [response transform interfaces](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/sdk/translator/types.go)
carry original/translated requests and per-stream state across chunks; streams
need more than renaming JSON fields. A
[Responses WebSocket session implementation](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/sdk/api/handlers/openai/openai_responses_websocket_session.go)
also exists; its presence is not proof all protocols support WebSockets.

Defer SSE, WebSockets, multimodal inputs and Responses until separately scoped.
Keep rejecting `stream: true` and supplied `stream_options` now. Do not send
keepalive bytes that commit the response before fallback is decided. Any future
stream design must prohibit replay after downstream commitment and cancel
active upstream work on disconnect/deadline.

Configuration's payload defaults/overrides/filters, provider header defaults,
thinking settings, model aliases and trusted native plugins expose extension
points. Shunt Shim should keep its smaller rule: tolerate unknown extras, forward
only approved mappings, and never let extras override validated model, credentials
or bounds. Avoid prompt rewriting, tool-result synthesis and arbitrary trusted
in-process plugins as compatibility shortcuts.

### Operational controls

The pinned configuration documents the following defaults and boundaries.
These are documented settings, not measured deployment behavior.

| CLIProxyAPI control | Implication for the Worker |
| :--- | :--- |
| Request body maximum defaults to 0 (disabled); 413 when configured | Retain Shunt Shim's mandatory 10 MiB bound before JSON parsing; never copy the unlimited default. |
| Negotiated gzip/zstd response compression, including SSE; excludes WebSocket upgrades | Defer explicit encoder work until Workers CPU/memory and stream lifetime costs are measured. |
| Remote/local model catalogs, refresh and last-valid retention | Retain a static verified `fast` alias and free-tier allowlist; catalog presence proves neither account access nor quota. |
| Separate management secret; remote management false; empty key disables management routes | Learn separation of authority, but do not add management endpoints or downloadable control-panel assets. |
| Optional request/response logging and in-memory usage aggregation; both false | Keep allowlisted diagnostics only, with no prompts, completions, raw upstream errors or credentials. |
| Local bbolt KV defaults enabled outside Home mode, auth directories, optional cooldown files and process-local selectors | Native daemon persistence and shared control-plane behavior do not transfer to isolated Workers with zero DB. |
| TLS/listener/proxy, shutdown, mDNS discovery and localhost profiling settings | Deployment-specific daemon features; use managed Worker ingress and its cancellation lifecycle. |

The selector's [error-summary sanitizers](https://github.com/router-for-me/CLIProxyAPI/blob/1aaf56bc6a0fc6fce19049ba7ae8554c882304a6/sdk/cliproxy/auth/selector.go)
remove token/path patterns and bound summaries. They are useful evidence that
upstream errors are sensitive; regex redaction is not a reason to log arbitrary
provider bodies under Shunt Shim's stricter metadata-only privacy contract.

## Adopt / defer / avoid

| Decision | Pattern | Reason |
| :--- | :--- | :--- |
| Adopt | Explicit provider capability mappings and request-scoped refusal | Prevent silent degradation; verify the actual selected free-tier model. |
| Adopt | Distinguish request errors, quota exhaustion, availability and cancellation | Preserve meaningful terminal status and avoid credential-error fallback. |
| Adopt | Test candidate eligibility and commitment boundaries | Future providers must remain within the same total attempt/deadline budget. |
| Adopt | Separate downstream auth from upstream secret ownership; safe diagnostics | Fits the existing secret model without credential persistence. |
| Defer | Multiple credentials, weights, priorities, affinity and cooldown tracking | No demonstrated MVP need; requires state ownership, privacy and fairness design. |
| Defer | Native Gemini/Claude/Responses translation, SSE, WebSockets and multimedia | Existing official compatible endpoints suffice; each adds a new compatibility contract. |
| Defer | Compression and dynamic catalogs | Require edge resource and account-availability evidence. |
| Avoid | Pool-wide additional retry rounds and broader retry status lists | Could exceed two attempts/60 seconds and conceal auth or validation faults. |
| Avoid | OAuth/token files, refresh workers, management plane, local DB and plugins | Conflicts with zero DB, Worker deployment and narrow credential ownership. |
| Avoid | Silent content loss, invented tool results and prompt rewriting | Alters caller intent and masks unsupported features. |

## Compatibility and failure cases to retain or add

These are proposed contract cases, not tests implemented or run by this research.

| Scenario | Required Shunt Shim observation |
| :--- | :--- |
| Parallel tool calls reuse function names but have distinct IDs; results arrive across turns | Associate by valid call ID, preserve arguments/results, reject orphan or duplicate-invalid structures before dispatch. |
| Tool-only, length-limited, filtered or missing-usage response | Preserve permitted null content/finish reasons and optional usage; reject malformed core output with 502. |
| Unknown reasoning/vendor extras collide with model or auth fields | Only approved mappings survive; validated routing and secrets cannot be overwritten. |
| Unsupported image/audio/video, Responses or streaming request | Follow the explicit current request/path contract before contacting a provider; do not silently drop unsupported core input. |
| Primary 429/503/network/header timeout, then fallback succeeds | Exactly two attempts at most, no retry round or same-account replay. |
| Primary 400/401/403 or malformed successful output | No fallback outside the existing eligible categories; retain explicit validation/auth/protocol failure classification. |
| Both 429; both unavailable; mixed eligible errors | Preserve quota vs unavailable distinction and the existing final-attempt error/header policy. |
| Large or malformed Retry-After and sensitive upstream error headers/body | Only validated safe retry metadata escapes; no raw payload or secret reaches diagnostics. |
| Deadline or client abort between selection and fallback | Cancel in-flight work and make no new attempt; total wall time remains bounded. |
| Headers/body already committed (future streaming) | Never replay on another credential/provider, even after stream failure. |
| Concurrent requests and isolate restart | No claim of globally coordinated quota, durable affinity or cross-isolate cooldown. |
| Payload at/over 10 MiB; compression negotiation and WebSocket upgrade attempts | Enforce existing body/path bounds; no implicit compression or transport expansion. |

## Evidence limits

Inspected official source and configuration at the pinned revision, not every
provider adapter, transport or Home deployment. No live credentials, provider
requests, OAuth exchange, streaming replay experiment, account-limit measurement
or Workers benchmark was performed. The exact capability intersection must be
proven with Shunt Shim client fixtures and deployed smoke tests before adopting
a provider. Upstream defaults and behavior can change; use the pinned links when
reviewing these recommendations alongside [MVP](../MVP.md) and
[architecture](../ARCHITECTURE.md).
