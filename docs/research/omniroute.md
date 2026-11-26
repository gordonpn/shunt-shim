# OmniRoute patterns for Shunt Shim

Research for [#64](https://github.com/gordonpn/shunt-shim/issues/64). Checked
2026-11-25 against OmniRoute commit
[`332e93b95be914b8258ff96f3514ee60b7788c4e`](https://github.com/cheaper-inference/OmniRoute/commit/332e93b95be914b8258ff96f3514ee60b7788c4e)
(`3.8.54`, MIT license). This is a source review complementing pending
[gateway survey audit PR #209](https://github.com/gordonpn/shunt-shim/pull/209),
[LiteLLM research PR #177](https://github.com/gordonpn/shunt-shim/pull/177),
and [CLIProxyAPI research PR #176](https://github.com/gordonpn/shunt-shim/pull/176)
without modifying their files. Keep #64 open.

**Recommendation:** retain Shunt Shim's stateless Cloudflare Workers runtime
and official API-key upstreams, and do not import `omniroute` as a runtime or
code dependency. Borrow selected stateless TypeScript patterns from its
`open-sse/` engine (bounded upstream JSON reading, explicit redirect refusal,
strict fail-closed free-tier eligibility filtering, response sanitization
allowlists, and separated search vs web-fetch capability contracts). Track
the concrete transport and normalization hardening identified for Shunt Shim's
completion path in [#236](https://github.com/gordonpn/shunt-shim/issues/236).

## Verified architecture and reusable patterns

### 1. Runtime, licensing, and state model

The [package manifest](https://github.com/cheaper-inference/OmniRoute/blob/332e93b95be914b8258ff96f3514ee60b7788c4e/package.json)
and [MIT license](https://github.com/cheaper-inference/OmniRoute/blob/332e93b95be914b8258ff96f3514ee60b7788c4e/LICENSE)
confirm OmniRoute is a Node.js (`>=22.22.2 <23 || >=24.0.0 <27`), Next.js,
CLI (`bin/omniroute.mjs`), and SQLite application with optional Electron and
Docker packaging. Its domain modules, such as
[`src/domain/fallbackPolicy.ts`](https://github.com/cheaper-inference/OmniRoute/blob/332e93b95be914b8258ff96f3514ee60b7788c4e/src/domain/fallbackPolicy.ts),
rely on module-level `Map` caches hydrated from SQLite (`../lib/db/domainState`).
That persistence and process model does not map to Cloudflare Workers'
stateless isolate architecture ([docs/ARCHITECTURE.md](../ARCHITECTURE.md)).

### 2. Guarded bounded-JSON outbound transport

In [`open-sse/services/usage/grokCli.ts`](https://github.com/cheaper-inference/OmniRoute/blob/332e93b95be914b8258ff96f3514ee60b7788c4e/open-sse/services/usage/grokCli.ts),
`readBoundedJson` reads successful Grok Build usage responses through
`response.body.getReader()`, rejects a declared content length above
`GROK_BUILD_MAX_RESPONSE_BYTES` (256 KiB), and cancels the reader when streamed
bytes exceed that ceiling. It then parses JSON through a schema, returning null
for invalid JSON/schema data. `fetchGrokBuildJson` uses `redirect: "error"` and
an explicit timeout; failures return null. This is a usage-fetch helper, not a
native decision endpoint or a general guarantee about every upstream call.

Separately, [`src/lib/providers/validation/headers.ts`](https://github.com/cheaper-inference/OmniRoute/blob/332e93b95be914b8258ff96f3514ee60b7788c4e/src/lib/providers/validation/headers.ts)
passes `allowRedirect: false` and `retry: false` to `safeOutboundFetch` for
provider-validation probes. These are reusable boundary ideas; Shunt Shim must
implement and test its own bounded completion reader, cancellation and safe
error mapping rather than importing these provider-specific helpers.

### 3. Strict zero-cost fail-closed filter and catalog hygiene

OmniRoute's [`open-sse/services/autoCombo/strictZeroCostFilter.ts`](https://github.com/cheaper-inference/OmniRoute/blob/332e93b95be914b8258ff96f3514ee60b7788c4e/open-sse/services/autoCombo/strictZeroCostFilter.ts)
and [`docs/reference/FREE_TIERS.md`](https://github.com/cheaper-inference/OmniRoute/blob/332e93b95be914b8258ff96f3514ee60b7788c4e/docs/reference/FREE_TIERS.md)
demonstrate useful invariants for free-tier aggregation without surprise spend:

- **Explicit hard-stop evidence:** `hardStopGuaranteed` is never defaulted to
  `true`; missing hard-stop evidence fails closed under strict mode rather than
  assuming free tiers refuse overages cleanly.
- **Pure synchronous eligibility filter:** `strictZeroCostFilter.ts` separates
  quota resolution from routing policy, accepting plain `FreeAccessState`
  (`"SAFE" | "EXHAUSTED" | "UNKNOWN"`) and treating stale timestamps
  (`maxStateAgeMs`) or missing usage states as `UNKNOWN` (excluded before
  ranking and dispatch). Multi-connection candidates rewrite `allowedConnectionIds`
  strictly to proven-safe connections, and keyless shortcuts apply only to the
  synthetic no-auth sentinel ID.
- **Counting vs deciding separation & pool deduplication:** Documentation and
  catalog math separate published recurring shared pools (counted once per shared
  pool rather than multiplied per model), one-time signup credits (excluded from
  steady recurring totals), and rate-limited uncapped tiers, while treating
  advisory ToS flags separately from hard routing gates.

### 4. OpenAI response sanitization and empty-completion detection

In [`open-sse/handlers/responseSanitizer.ts`](https://github.com/cheaper-inference/OmniRoute/blob/332e93b95be914b8258ff96f3514ee60b7788c4e/open-sse/handlers/responseSanitizer.ts),
OmniRoute maintains explicit field allowlists (`ALLOWED_USAGE_FIELDS`,
`ALLOWED_RESPONSES_USAGE_FIELDS`) and strips provider extensions (`x_groq`,
`usage_breakdown`, `service_tier`) known to trigger strict OpenAI Python SDK
Pydantic validation errors in downstream tools. Separately,
[`open-sse/services/errorClassifier.ts`](https://github.com/cheaper-inference/OmniRoute/blob/332e93b95be914b8258ff96f3514ee60b7788c4e/open-sse/services/errorClassifier.ts)
(`isEmptyContentResponse`) detects silent HTTP 200 empty shells while explicitly
exempting legitimate terminal stops (`length`, `tool_calls`, `content_filter`)
and recognizing alternative `reasoning` fields alongside `reasoning_content`.

### 5. Separated Search vs Web Fetch contracts and explicit-only gating

[`open-sse/handlers/search.ts`](https://github.com/cheaper-inference/OmniRoute/blob/332e93b95be914b8258ff96f3514ee60b7788c4e/open-sse/handlers/search.ts)
and [`open-sse/handlers/webFetch.ts`](https://github.com/cheaper-inference/OmniRoute/blob/332e93b95be914b8258ff96f3514ee60b7788c4e/open-sse/handlers/webFetch.ts)
keep search and content extraction cleanly separated:

- `search.ts` clamps per-provider timeouts inside a bounded whole-request budget
  (`clampSearchTimeoutMs` / `resolveGlobalTimeoutMs`) and stops automatic
  failover on `NON_RETRIABLE` client/auth statuses (`400`, `401`, `403`, `404`)
  ordinarily. `isFailoverStatus` permits those statuses when a configured
  SearXNG primary has `primaryWhenConfigured: true`; other failover gates
  still apply. This provider-specific exception is not a proposal to broaden
  Shunt Shim completion failover.
- `webFetch.ts` enforces compile-time exhaustiveness (`const _exhaustive: never`)
  across fetch executors and isolates specialized sources (such as `context7`)
  behind `EXPLICIT_ONLY_WEB_FETCH_PROVIDERS` so generic auto-fallback never
  dispatches to documentation-specific endpoints unintentionally.

## Adopt / defer / avoid

| Decision | OmniRoute pattern | Reason |
| :--- | :--- | :--- |
| Adopt | Bounded response body reader (`readBoundedJson` byte cap) on 2xx JSON | Prevents large or hostile upstream payloads from exhausting Worker memory before JSON parsing. |
| Adopt | Explicit `redirect: "error"` on outbound authenticated fetches | Prevents redirect responses from leaking upstream bearer keys or bypassing target URL expectations. |
| Adopt | Explicit `usage` field allowlist and plain-object check (`!Array.isArray`) | Prevents arbitrary provider-specific usage extensions from breaking strict OpenAI Python/Pydantic clients. |
| Adopt | Pure fail-closed quota filter (`SAFE \| EXHAUSTED \| UNKNOWN`, staleness TTL, `hardStopGuaranteed` never defaulted) | Fits Shunt Shim's strict `freeOnly` and testable pure-function standards for `src/search/quota/`. |
| Adopt | Separated search vs fetch contracts with explicit-only provider sets and provider-specific search failover policy | Directly informs [#235](https://github.com/gordonpn/shunt-shim/issues/235), [#231](https://github.com/gordonpn/shunt-shim/issues/231), and `src/search/router.ts`. |
| Defer | Additional free-tier LLM provider leads (`FREE_TIERS.md` catalog) | Useful discovery input for [#211](https://github.com/gordonpn/shunt-shim/issues/211), but every limit and ToS claim requires independent primary-source checks. |
| Avoid | Node.js/Next.js/SQLite/Electron runtime, `fallbackPolicy.ts` module-level mutable maps, OAuth scraping, and advisory-only ToS flags | Conflicts with Cloudflare Workers stateless isolates, zero-DB architecture, official API-key boundaries, and fail-closed policy. |
| Avoid | Prompt/output token compression (`RTK + Caveman`) | Mutating prompts or tool/diff payloads risks breaking deterministic code review fidelity and compatibility contracts. |

## Application to `shunt-shim` (`00ec75b`)

Checked [`src/upstream.ts`](https://github.com/gordonpn/shunt-shim/blob/00ec75b/src/upstream.ts)
against these patterns:

- **Already covered in `shunt-shim`:** `cancelErrorBody` cancels non-2xx error
  bodies cleanly (`src/upstream.ts:145-163`), `normalizeUpstreamResponse` strips
  unknown top-level provider fields such as `x_groq` and `service_tier` by
  constructing a fresh `NormalizedChatCompletion` object
  (`src/upstream.ts:421-427`), and `normalizeChoice` enforces valid
  `finish_reason` values and rejects null-content non-tool completions
  (`src/upstream.ts:308-388`).
- **Verified hardening gaps in `src/upstream.ts` (tracked in [#236](https://github.com/gordonpn/shunt-shim/issues/236)):**
  1. `primaryResponse.json()` (`src/upstream.ts:602`) and
     `fallbackResponse.json()` (`src/upstream.ts:822`) read 2xx bodies without a
     byte cap before parsing.
  2. Outbound `fetch` calls (`src/upstream.ts:517-525` and
     `src/upstream.ts:731-739`) omit `redirect: "error"`.
  3. `normalizeUpstreamResponse` forwards `record.usage` when
     `typeof record.usage === "object" && record.usage !== null` without
     `!Array.isArray(record.usage)` or field allowlisting (`src/upstream.ts:429-431`).
- **Search, quota, and client compatibility alignment:**
  - `strictZeroCostFilter.ts` and catalog pool-deduping rules reinforce fail-closed
    quota work in [#98](https://github.com/gordonpn/shunt-shim/issues/98),
    [#134](https://github.com/gordonpn/shunt-shim/issues/134), and
    [#216](https://github.com/gordonpn/shunt-shim/issues/216).
  - `search.ts` / `webFetch.ts` boundary design informs search/fetch separation
    in [#235](https://github.com/gordonpn/shunt-shim/issues/235) and routing in
    [#231](https://github.com/gordonpn/shunt-shim/issues/231).
  - Usage sanitization and non-200 failure behavior relate to reliability and
    client compatibility tracked in [#222](https://github.com/gordonpn/shunt-shim/issues/222)
    and [#218](https://github.com/gordonpn/shunt-shim/issues/218).

## Evidence and limitations

Inspected pinned source files via the GitHub API on 2026-11-25; corrected
version, transport citations and search failover semantics against the same
pinned source archive on 2026-11-26. Review targets are OmniRoute
commit `332e93b95be914b8258ff96f3514ee60b7788c4e` and Shunt Shim commit
`00ec75b`. No OmniRoute package, CLI binary, SQLite schema, or compression filter
was installed, executed, or benchmarked, and none of the third-party provider
quotas or ToS summaries listed in OmniRoute's `docs/reference/FREE_TIERS.md`
were independently re-verified against vendor pages.

## Recommended next action

Recommend **no dependency import or runtime change**. Keep this document as a
standalone source reference toward [#64](https://github.com/gordonpn/shunt-shim/issues/64)
until the parent comparison matrix reconciles LiteLLM ([#177](https://github.com/gordonpn/shunt-shim/pull/177)),
CLIProxyAPI ([#176](https://github.com/gordonpn/shunt-shim/pull/176)), and
source-identity checks ([#209](https://github.com/gordonpn/shunt-shim/pull/209)).
Implement the three verified `src/upstream.ts` hardening improvements separately
under [#236](https://github.com/gordonpn/shunt-shim/issues/236) (`P2`, `S`).
