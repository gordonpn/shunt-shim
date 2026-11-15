# Project Execution Queue

Last Refined: 2026-11-15T03:58:00Z
Repository: gordonpn/shunt-shim
GitHub Backlog: https://github.com/gordonpn/shunt-shim/issues
Snapshot: 99 open issues, 20 open PRs (Tier 1-2 PRs #94, #95, #180, #185, #200, #201, #202, #205 merged and deployed to production).
Recheck [GitHub](https://github.com/gordonpn/shunt-shim/issues) before claiming work.

## NOW - Live Gateway Proof and Remaining Open PRs

### 1. Live Dogfooding & Deployed Client Proof ([#86](https://github.com/gordonpn/shunt-shim/issues/86), [#40](https://github.com/gordonpn/shunt-shim/issues/40))

- **Priority:** P1 | **Effort:** M | **Readiness:** READY
- **What is in place:** Custom domain `shunt-shim.gordon-pn.com` is live (`#185`), production deployment retry/rollback (`#200`), production environment secret sync (`#201`), multi-token `GATEWAY_TOKENS` (`#202`), workflow gateway routing (`#205`), and an independent `REVIEW_GATEWAY_TOKEN` provisioned across Cloudflare, GitHub `production` environment, and repository Actions secrets (both primary and review tokens verified 11/11 ingress probes).
- **Next verification actions:**
  - Trigger `DeepSeek Review` / `PR-Agent` on a same-repo PR (`ready_for_review` or `@pr_agent` comment) and verify via `just tail` that only anonymized metadata is logged (`#86`).
  - Run and record live completions across Groq and Gemini plus all three pinned clients (`#40`), including live `just verify-ingress-live` evidence (`#36`, `#38`, `#84`).

### 2. Review and Merge Tier 3 Search Foundation PRs

All 6 foundation PRs are `MERGEABLE`, have 0 unresolved threads, and pass all automated CI checks:

| PR | Issue(s) | Scope |
| --- | --- | --- |
| [#188](https://github.com/gordonpn/shunt-shim/pull/188) | #111 | ADR 0003: unified search gateway architecture and boundaries |
| [#189](https://github.com/gordonpn/shunt-shim/pull/189) | #112 | Search MVP provider selection criteria and milestone gates |
| [#178](https://github.com/gordonpn/shunt-shim/pull/178) | #110 | Search provider free-tier economics and safeguard matrix |
| [#182](https://github.com/gordonpn/shunt-shim/pull/182) | #158 | Search security threat model and prompt-injection defenses |
| [#191](https://github.com/gordonpn/shunt-shim/pull/191) | #163 | Search gateway operations and troubleshooting runbook |
| [#181](https://github.com/gordonpn/shunt-shim/pull/181) | #148 | Offline 30-query technical search evaluation dataset |

## NEXT - Upcoming Work

1. **Merge Tier 4 Search Runtime Modules (#190, #194, #193, #195):**
   - [#190](https://github.com/gordonpn/shunt-shim/pull/190) (`#119`-`#121` registry), [#194](https://github.com/gordonpn/shunt-shim/pull/194) (`#130`-`#133` fail-closed quota policy), [#193](https://github.com/gordonpn/shunt-shim/pull/193) (`#144`-`#146` normalizer/URL dedup; satisfies `#196`), and [#195](https://github.com/gordonpn/shunt-shim/pull/195) (`#138`-`#140` fallback router; satisfies `#199`).
2. **[#197](https://github.com/gordonpn/shunt-shim/issues/197) + [#113](https://github.com/gordonpn/shunt-shim/issues/113) + [#122](https://github.com/gordonpn/shunt-shim/issues/122) + [#203](https://github.com/gordonpn/shunt-shim/issues/203): Reconcile and Wire `POST /v1/search`:**
   - **Priority:** P1 | **Readiness:** READY after Tier 3-4 merges
   - Unify parallel `src/search` types (`#197`), expose authenticated/validated `POST /v1/search` (`#113`-`#118`), implement Tavily and Exa adapters (`#122`-`#125`), and wire response provenance metadata (`#203`).
3. **[#41](https://github.com/gordonpn/shunt-shim/issues/41) -> [#42](https://github.com/gordonpn/shunt-shim/issues/42): Deployed Failover Tool Cycle and MVP Sign-Off:**
   - **Priority:** P1 | **Readiness:** BLOCKED by `#40`
   - Execute controlled primary failure with a deployed client tool-use cycle (`#41`), then audit all MVP acceptance criteria and publish the initial release (`#42`).
4. **Search Operations, MCP Integration, and Preview Safeguards:**
   - Merge Tier 5-6 docs/research PRs ([#187](https://github.com/gordonpn/shunt-shim/pull/187), [#184](https://github.com/gordonpn/shunt-shim/pull/184), [#192](https://github.com/gordonpn/shunt-shim/pull/192), [#176](https://github.com/gordonpn/shunt-shim/pull/176), [#177](https://github.com/gordonpn/shunt-shim/pull/177), [#179](https://github.com/gordonpn/shunt-shim/pull/179), [#172](https://github.com/gordonpn/shunt-shim/pull/172), [#173](https://github.com/gordonpn/shunt-shim/pull/173), [#174](https://github.com/gordonpn/shunt-shim/pull/174); close stale [#175](https://github.com/gordonpn/shunt-shim/pull/175) once this update merges).
   - Deliver MCP server (`#150`-`#152`) and mock agent tests (`#155`), search query privacy (`#156`-`#159`), telemetry/secret provisioning (`#160`-`#162`), offline eval runner (`#149`), and resolve preview compatibility before adopting `SearchQuotaCoordinator` Durable Objects (`#204`, `#134`-`#137`).
5. **[#211](https://github.com/gordonpn/shunt-shim/issues/211): Configurable Fallback Order and Optional Last-Resort DeepSeek Credit Fallback:**
   - **Priority:** P2 | **Effort:** M | **Readiness:** READY
   - Generalize `PRIMARY_PROVIDER` to an ordered provider chain (`FALLBACK_ORDER`) and accept optional `DEEPSEEK_API_KEY` strictly after free-tier providers fail or exhaust quota.

## BLOCKERS

- **Isolated PR previews (`#186`):** Intentionally held off to avoid consuming free-tier Workers/provider quota (`CLOUDFLARE_PREVIEW_*` and `PREVIEW_GATEWAY_TOKENS` unset; `deploy preview` skips safely). Revisit with a dedicated non-production account and `#204` before Durable Object rollout.
- **External bot review rate limits:** CodeRabbit, Sourcery, and Copilot are externally rate-limited/quota-exhausted; internal CI (`ci`, `coverage`, `CodeQL`, `reviewdog`) is unaffected and `DeepSeek Review` / `PR-Agent` are now backed by `REVIEW_GATEWAY_TOKEN`.
- **Deferred / operator-gated items:** `#82` requires operator Google AI Pro API credit verification; `#23`-`#25` (SSE streaming) and `#164`-`#167` (`POST /v1/fetch` crawling) remain deferred until after search MVP foundations land.

## LATER

All remaining epics, search phase-2 extensions, and deferred capabilities are tracked in GitHub Issues:
https://github.com/gordonpn/shunt-shim/issues?q=is%3Aissue+is%3Aopen
