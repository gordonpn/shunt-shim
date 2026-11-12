# Gateway patterns comparison

This document records focused investigations for [#64](https://github.com/gordonpn/shunt-shim/issues/64).
It is not a completed survey of every project in that parent issue.

## LiteLLM: dedicated gateway engine and routing proxy

Research for [#96](https://github.com/gordonpn/shunt-shim/issues/96), checked
2026-11-12 against official documentation and source commit
[`7553c4f`](https://github.com/BerriAI/litellm/commit/7553c4f5015cbd49c8a288e299ca2d74e8d06a07).
Source links below are pinned to that revision; documentation links are mutable.
This is source analysis, not a deployed LiteLLM benchmark or a compatibility certification.
No LiteLLM dependency or runtime change is proposed.

### Comparison matrix

| Dimension | Verified LiteLLM pattern | Fit for Shunt Shim |
| :--- | :--- | :--- |
| Topology | Python-facing proxy and SDK; the inspected `Router` delegates to a Rust-backed core [L1, L2]. Production documentation describes containers, Postgres, optional Redis configuration, and migrations [L9]. | Architectural reference only. Keep the TypeScript Worker, no database, no background service. |
| Routing | `model_name` identifies a model group; deployment entries carry provider/model, credentials, and endpoint configuration. Strategies include shuffle, latency, usage, and cost selection [L1, L6]. | Keep one public `fast` alias and fixed primary/fallback ordering. Do not expose arbitrary deployment names. |
| Reliability | Separate retry policies, model-group fallbacks, context/content-policy fallbacks, per-deployment cooldowns, and optional weighted failover [L1, L6]. | Adopt explicit policy boundaries, not the broader failure eligibility or layered attempt budget. |
| Adapters | `BaseConfig` separates supported parameters, parameter mapping, environment validation, request/response transformation, error creation, and stream iteration [L3]. | Reuse the separation when necessary, without importing the framework. Both current providers already use OpenAI-compatible endpoints. |
| Streaming | `CustomStreamWrapper` emits normalized deltas, handles tool-call finish reasons and usage, and implements `close`/`aclose` [L4]. | Future reference only; MVP rejects streaming before dispatch. Retain cancellation and response-commitment rules. |
| Tools | Anthropic translation converts native `tool_use` id/name/input into an OpenAI function call with JSON-string arguments [L5]. | Preserve identifiers, string arguments, tool results, null tool-only content, and finish reasons in the existing shared subset. |
| Access and state | Virtual keys have model permissions, budgets and rate limits; their documented setup requires Postgres [L8]. `DualCache` supports local memory plus optional Redis [L7]. | Keep gateway authentication separate from provider secrets. No key database, spend ledger, or global quota inference. |
| Observability | Callback interfaces receive messages, request kwargs and response objects; request-level and per-deployment hooks are distinct [L10, L11]. | Use bounded metadata-only diagnostics. Never copy raw callback logging examples or export payloads. |

### Adapter and policy boundaries

The useful abstraction in `BaseConfig` is a narrow, testable mapping between a
validated OpenAI subset and one provider. Its `get_supported_openai_params`,
`map_openai_params`, `transform_request`, `transform_response`, and
`get_error_class` methods make those responsibilities visible [L3].
LiteLLM also has provider-specific role changes, schema-to-tool emulation, and
optional parameter dropping. Those are behaviors to verify per model, not
universal compatibility guarantees. Shunt Shim should keep explicit allowlisted
field mapping in [upstream.ts](../../src/upstream.ts), with validation in
[validation.ts](../../src/validation.ts), rather than building a provider plugin
registry for two compatible endpoints.

Native Anthropic translation is an example, not a proposal to add Anthropic:
`convert_tool_use_to_openai_format` preserves the tool id and name and serializes
native input with `json.dumps` [L5]. A future native adapter would need fixtures
in both directions, including multiple calls and their matching result ids.
Do not silently repair malformed tool arguments, execute tools in the gateway,
or invent usage/reasoning fields. Existing JSON normalization remains governed
by [COMPATIBILITY.md](../COMPATIBILITY.md).

### Routing, retry and lifecycle limits

LiteLLM exposes independent `num_retries`, `max_fallbacks`, timeout,
`RetryPolicy`, `AllowedFailsPolicy`, model-group retries, and dedicated fallback
lists [L1]. Its routing documentation distinguishes LiteLLM retries from provider
SDK `max_retries`, which it says are disabled for router calls [L6]. This is a
useful warning about multiplicative retries, not evidence that Shunt Shim should
copy defaults. Deployment ordering can consume retries at each order before
cross-group fallbacks; context-window and content-policy recovery broaden policy
beyond the MVP. Weighted selection and fallback are also separate concerns [L6].

Keep the [MVP contract](../MVP.md): at most two serial upstream calls, with one
fallback only for primary 429, 503, connect/header timeout, or network fetch
failure within the remaining 60-second total deadline. Keep the 5-second
connect/header bound, cancel active work on disconnect/deadline, and do not retry
400, 401/403, 500/502, malformed success payloads, or a failed fallback. No
backoff timer, callback, adapter, or SDK may add a hidden third call. Normalize
errors into safe OpenAI envelopes without leaking upstream response bodies or
credentials; retain the contract's distinct quota, availability, and timeout
outcomes and safe retry headers.

LiteLLM cooldowns track deployment health, not whole model-group health [L6].
`DualCache` demonstrates that local memory and Redis coordination are different
consistency choices [L7]; not every LiteLLM router requires a database. For this
MVP neither cross-request cooldowns nor shared quota counters are necessary.
If later evaluated, isolate-local cooldowns must remain best-effort hints and
must not claim global free-tier capacity. Shared state requires a separate ADR.

The inspected router explicitly offers opt-in
`enable_mid_stream_fallback_continuation`, default false, using assistant prefill
after plain text was emitted; tool/thinking/constrained output is excluded [L1].
Shunt Shim must avoid this behavior. Once downstream headers are committed,
provider selection is locked even if no text delta reached the client.
`sent_first_chunk` inside a library is not proof that an HTTP response remains
uncommitted. Future SSE work may adapt delta normalization and explicit iterator
cleanup [L4], but must preserve backpressure, bounded buffering, cancellation,
tool-call indices and argument fragments, terminal finish reasons, and optional
usage without retaining a full completion merely for logging.

Auto routing is a distinct feature from reliability routing. Current official
documentation supports heuristic/keyword selection as well as LLM or external
classifiers, semantic embedding calls, tier pools and optional session affinity
[L12]. Some variants add calls and prompt disclosure; even local heuristics add
unneeded policy for one alias. Defer all of them, retaining explicit configured
models and no classifier request on the completion path.

### Authentication, privacy and operations

LiteLLM's virtual-key management is a control plane with stored permissions,
spend and rotation schedules [L8]. It is not required for the useful concept of
separating an ingress credential from server-held provider credentials. Preserve
Shunt Shim's one secret via Bearer or `x-api-key`, including conflict rejection,
authentication before dispatch, and fixed outbound authorization. Caller extras
must never select an endpoint, paid model, provider key, or authorization header.

Guardrails and caching are independent choices: neither intrinsically requires
Postgres. LiteLLM's overview describes content filters/PII masking and request/
response policy hooks [L13], while its cache can be local or Redis-backed [L7].
Defer policy plugins, semantic/response caches and spend tracking because they
expand processing, retention or coordination beyond this MVP. Schema validation
and body bounds remain mandatory and do not establish a content-safety claim.

`CustomLogger` methods receive messages/kwargs and response objects [L10].
Official callback examples print kwargs and completion responses, and the
routing guide even discusses tracking API keys [L6, L11]. These are unsuitable
defaults for this project. Keep [diagnostics.ts](../../src/diagnostics.ts)'s
allowlist: request id, timestamp, status, latency, provider, actual model,
attempt count and fallback reason. Exclude raw exceptions, URLs with secrets,
request headers, prompts, completions, tool arguments and credential hashes.
Distinguish logical-request metrics from attempt metrics if adding counters,
so fallback does not double-count client success; do not add network callbacks.

Translate only operational practices that fit Workers: pin reviewed releases,
keep configuration versioned and secrets in the platform secret store, test
provider paths independently, and verify cancellation through deployed ingress.
LiteLLM's production topology, database migrations, containers and Redis are not
a drop-in Workers deployment [L9]. This research makes no CPU, memory, latency,
or free-tier quota claims about LiteLLM or a port of its core.

### Adopt, defer, avoid

| Decision | Pattern | Concrete constraint |
| :--- | :--- | :--- |
| Adopt / retain | Separate validated input, provider mapping, response/error normalization, routing policy and transport lifecycle. | Small functions and provider fixtures; keep the existing compatible REST endpoints. |
| Adopt / retain | Explicit alias-to-deployment mapping and one owner of attempt accounting. | `fast`, two serial calls maximum, fixed eligibility, remaining-deadline check, no replay after commitment. |
| Adopt / retain | Metadata-only diagnostics and explicit cleanup. | Existing allowlist; no payload callback, secret propagation or unbounded retained chunks. |
| Defer | SSE normalization and native provider adapters. | Post-MVP contract and independent client/provider certification required; current stream rejection remains. |
| Defer | Cooldowns, session affinity, adaptive/cost/latency routing and classifiers. | No new cross-request state or extra inference calls in the MVP. |
| Defer | Virtual keys, budgets, spend ledger, guardrail plugins and response/semantic caches. | No database, ORM, control plane, content retention or additional service. |
| Avoid | Layering provider retries, per-group retries and fallback chains; hedged/mirrored calls. | Never multiply the request's fixed attempt or quota budget. |
| Avoid | Midstream continuation, permissive client endpoint/key overrides and raw callback logging. | Preserve commitment, credential isolation and privacy boundaries. |

### Compatible follow-up candidates

These are proposed scopes for review, not newly created issues or changes made
by this research. First compare existing tests to avoid duplicating coverage.

1. Audit retry ownership with mocked fetches: count calls for each eligible and
   ineligible primary failure, failed fallback, malformed 200, deadline and
   disconnect. Assert at most two calls and zero dispatch after cancellation;
   cover cancellation during body parsing and cleanup, not only header wait.
2. Extend provider normalization fixtures only where gaps exist: multiple tool
   calls and matching results, null tool-only content, truncation/filter finish
   reasons, optional usage/reasoning, and rejection of malformed upstream shapes.
   Run both configured providers independently through the same contract.
3. Audit diagnostic coverage on every terminal path using sentinel secrets,
   prompt text, tool arguments and raw errors. Assert the exact allowlist and
   one logical-request outcome. Existing [diagnostics tests](../../test/diagnostics.test.ts)
   already cover many of these cases and should be extended only for gaps.

Streaming, new providers and stateful controls are not MVP-compatible follow-up
issues from this investigation. Revisit them only under separately approved
post-MVP work.

### Sources

- [L1: Router surface and explicit reliability/continuation options](https://github.com/BerriAI/litellm/blob/7553c4f5015cbd49c8a288e299ca2d74e8d06a07/litellm/router.py).
- [L2: RouterCore delegation and Rust core construction](https://github.com/BerriAI/litellm/blob/7553c4f5015cbd49c8a288e299ca2d74e8d06a07/litellm/router_core.py).
- [L3: BaseConfig adapter boundary](https://github.com/BerriAI/litellm/blob/7553c4f5015cbd49c8a288e299ca2d74e8d06a07/litellm/llms/base_llm/chat/transformation.py).
- [L4: Stream wrapper, normalization and cleanup](https://github.com/BerriAI/litellm/blob/7553c4f5015cbd49c8a288e299ca2d74e8d06a07/litellm/litellm_core_utils/streaming_handler.py).
- [L5: Anthropic tool translation](https://github.com/BerriAI/litellm/blob/7553c4f5015cbd49c8a288e299ca2d74e8d06a07/litellm/llms/anthropic/chat/transformation.py#L724-L746).
- [L6: Routing, retries, fallbacks and cooldown documentation](https://docs.litellm.ai/docs/routing).
- [L7: DualCache local/optional Redis implementation](https://github.com/BerriAI/litellm/blob/7553c4f5015cbd49c8a288e299ca2d74e8d06a07/litellm/caching/dual_cache.py).
- [L8: Virtual keys, Postgres setup, spend and rotation](https://docs.litellm.ai/docs/proxy/virtual_keys).
- [L9: Production deployment and secret management](https://docs.litellm.ai/docs/proxy/deploy).
- [L10: CustomLogger callback interfaces](https://github.com/BerriAI/litellm/blob/7553c4f5015cbd49c8a288e299ca2d74e8d06a07/litellm/integrations/custom_logger.py).
- [L11: Custom callbacks and request versus attempt hooks](https://docs.litellm.ai/docs/observability/custom_callback).
- [L12: Current auto-routing documentation](https://docs.litellm.ai/docs/proxy/auto_routing).
- [L13: Gateway overview and guardrails](https://docs.litellm.ai/docs/simple_proxy).

The issue's `/docs/auto_routing` and `/docs/observability` URLs returned HTTP 404
when checked. L12 and L11 were discovered separately as current pages; the
original URLs were not treated as evidence. Source inspection used GitHub's
connector because direct shell GitHub access was unavailable.
