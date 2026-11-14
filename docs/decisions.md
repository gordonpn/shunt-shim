# Implementation Decisions Log

This document records non-obvious engineering and implementation decisions made in Shunt Shim, ordered newest first. Architectural or hard-to-reverse decisions are promoted to formal Architecture Decision Records under `docs/adr/` where adopted.

## 2026-11-10: Constant-time gateway token comparison via SHA-256 digests

- Decision: Hash both compared values with SHA-256 and compare their equal-length 32-byte digests with Cloudflare Workers' native `crypto.subtle.timingSafeEqual` for both dual-header consistency checks and `GATEWAY_TOKENS` validation, supplying Node's `timingSafeEqual` only in unit-test setup.
- Rationale: Replace plain string inequality checks in gateway authentication while preserving existing header parsing, trimming, and HTTP 401 behavior; unit tests supply Node's comparator because Node Web Crypto lacks the Workers extension.
- Rejected alternatives: Not recorded in the source.
- Source: [#93 fix(auth): use native constant-time gateway token comparison (#68)](https://github.com/gordonpn/shunt-shim/pull/93), [#68 Constant-time gateway token comparison](https://github.com/gordonpn/shunt-shim/issues/68)

## 2026-11-10: Cancel failed upstream response bodies bounded by request deadline

- Decision: Cancel unconsumed response bodies on failed upstream HTTP responses and await cleanup bounded by the total request deadline and client disconnect signal, ensuring cleanup rejection never replaces the original provider error and stalled cleanup returns HTTP 504 without starting another attempt after cancellation.
- Rationale: Prevent failed upstream HTTP responses from leaving unconsumed bodies open when falling back or returning errors, while preserving status/error mapping and `Retry-After` handling.
- Rejected alternatives: Not recorded in the source.
- Source: [#92 fix: cancel failed upstream response bodies (#71)](https://github.com/gordonpn/shunt-shim/pull/92), [#71 Cancel failed upstream response bodies](https://github.com/gordonpn/shunt-shim/issues/71)

## 2026-11-10: Distinguish missing or blank model parameters from unknown models

- Decision: Return HTTP 400 `missing_required_parameter` with `param=model` for omitted, null, non-string, empty, or whitespace-only `model` values, while keeping HTTP 404 `model_not_found` for unknown non-blank model strings and accepting `fast` without trimming or normalization.
- Rationale: Align invalid required field reporting with OpenAI-compatible request validation without altering unknown-model or alias behavior.
- Rejected alternatives: Returning HTTP 404 `model_not_found` for omitted, null, or blank model fields (the pre-fix behavior replaced by this change).
- Source: [#90 fix(api): return HTTP 400 for missing or invalid model (#74)](https://github.com/gordonpn/shunt-shim/pull/90), [#74 Missing or invalid model returns HTTP 400](https://github.com/gordonpn/shunt-shim/issues/74)

## 2026-11-10: Synchronize allowlisted GitHub Actions secrets while quarantining provider keys

- Decision: Provide `just sync-github-secrets` to push only `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `GATEWAY_TOKENS` from `.dev.vars` to GitHub Actions via `gh secret set` over stdin, keeping `GROQ_API_KEY` and `GEMINI_API_KEY` restricted to Cloudflare Worker runtime secrets.
- Rationale: Eliminate manual copy-paste into the GitHub web UI, prevent plaintext secret exposure in process arguments or console output, and quarantine upstream provider keys from CI.
- Rejected alternatives: Manual copying into the GitHub web UI.
- Source: [#88 feat: synchronize allowlisted GitHub Actions secrets (#85)](https://github.com/gordonpn/shunt-shim/pull/88), [#85 Add secret synchronization recipe for GitHub and Cloudflare credentials](https://github.com/gordonpn/shunt-shim/issues/85)

## 2026-11-10: Export a handler-only Worker entrypoint

- Decision: Export only the Worker handler from the runtime entrypoint instead of exporting application constants alongside it.
- Rationale: Workerd in `just dev` interpreted exported non-handler constants as Worker entrypoints, causing clean checkouts to build but fail local startup.
- Rejected alternatives: Not recorded in the source.
- Source: [#87 fix: make clean-checkout development and verification pass (#8)](https://github.com/gordonpn/shunt-shim/pull/87), [#8 Run development and verification from a clean checkout](https://github.com/gordonpn/shunt-shim/issues/8)

## 2026-10-30: Enforce allowlisted private diagnostics with dual-header authentication and request bounds

- Decision: Emit diagnostic logs using an explicit metadata allowlist (`DIAGNOSTIC_ALLOWLIST`) correlated by `x-request-id` without logging bodies or secrets, reject bodies above 10 MB (`HTTP 413`) before JSON parsing and prompts above 128k estimated tokens (`HTTP 400`), and accept either `Authorization: Bearer` or `x-api-key` while allowing identical dual headers and rejecting conflicting ones with HTTP 401.
- Rationale: Provide per-request provider, attempt, and fallback telemetry safely while protecting credentials and enforcing shared upstream bounds.
- Rejected alternatives: Bundling heavy WASM TikToken/BPE tokenizers in edge isolates (replaced by a lightweight character/byte heuristic per ADR 0002).
- Source: [#66 feat: operate one deployment with private diagnostics (#36)](https://github.com/gordonpn/shunt-shim/pull/66), [#59 feat: validate core requests while tolerating client extensions (#15)](https://github.com/gordonpn/shunt-shim/pull/59), [#58 feat: authenticate API routes and expose exact fast catalog (#13)](https://github.com/gordonpn/shunt-shim/pull/58)

## 2026-10-30: MVP runtime amendments for non-streaming JSON, Google OpenAI-compatible endpoint, and 60s deadline

- Decision: Defer SSE streaming (rejecting `stream: true` and `stream_options` with HTTP 400 `unsupported_parameter`), route Google AI Studio fallback (`gemini-2.5-flash-lite`) via its official OpenAI-compatible endpoint (`/v1beta/openai/chat/completions`), tighten upstream connect/header timeout to 5s and total gateway deadline to 60s, and use Groq `qwen/qwen3.8-27b` as primary after verifying `llama-3.3-70b-versatile` returns HTTP 404 on the target free tier.
- Rationale: Keep the MVP bounded and stateless on verified free-tier endpoints while ensuring edge HTTP 504 delivery within review client and Cloudflare Workers timeouts.
- Rejected alternatives: Using `llama-3.3-70b-versatile` on Groq (unavailable on tier), shipping a native Google REST translator in MVP (deferred post-MVP in ADR 0002), and keeping bootstrap mock SSE streaming.
- Source: [#62 feat: reject streaming requests with HTTP 400 (#61)](https://github.com/gordonpn/shunt-shim/pull/62), [#67 docs: align configuration and setup documentation with MVP runtime (#11)](https://github.com/gordonpn/shunt-shim/pull/67), [#53 feat: verify Groq and Gemini capabilities and request contract (#3)](https://github.com/gordonpn/shunt-shim/pull/53), [ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md), [ADR 0002](adr/0002-model-fallback-and-provider-adaptation-strategy.md)

## 2026-10-13: Cloudflare Workers runtime and bounded fallback architecture

- Decision: Deploy on Cloudflare Workers using TypeScript and Hono, enforce a single downstream response commitment point, abort upstream fetches via linked `AbortSignal.any()` signals with `enable_request_signal`, and pair bounded primary-fallback routing in MVP with an isolate-local dynamic circuit breaker roadmap.
- Rationale: Meet zero-hosting-spend and global HTTPS requirements while avoiding upstream quota multiplication and slow KV synchronization windows.
- Rejected alternatives: Google Cloud Run, Fly.io Machines, always-on servers, local daemons, hedged request racing, and Cloudflare KV or Durable Objects for initial health state.
- Source: [ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md), [ADR 0002](adr/0002-model-fallback-and-provider-adaptation-strategy.md), [#52 feat: agree runtime target and supported request bounds (#3)](https://github.com/gordonpn/shunt-shim/pull/52), [#57 docs: record model fallback strategy and native gemini rest adapter (ADR 0002) (#56)](https://github.com/gordonpn/shunt-shim/pull/57)
