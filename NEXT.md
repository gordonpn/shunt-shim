# Project Execution Queue

Last Refined: 2026-10-30T18:18:00-04:00
Repository: gordonpn/shunt-shim
GitHub Backlog: https://github.com/gordonpn/shunt-shim/issues

## NOW - Recommended Next Task

### [#11: [Task] Align configuration and setup documentation with the selected MVP](https://github.com/gordonpn/shunt-shim/issues/11)

- **Priority:** P2
- **Effort:** S
- **Readiness:** READY
- **Why this task is next:** With Task #37 closed in PR #66, Task #11 is the single remaining deliverable under Story #8 and Epic #2. Completing Task #11 aligns all setup and runtime documentation with the actual implementation and unblocks Task #38 (deployment).
- **First implementation action:** Update README.md, docs/ARCHITECTURE.md, docs/CONFIGURATION.md, docs/RUNBOOK.md, docs/COMPATIBILITY.md, and .env.example to prune obsolete proposals (OpenRouter, multi-tenant catalogs, KV counters, native Gemini REST translation) and accurately document single-token auth, the fast alias model pair, 5s connect timeout, 60s deadline, and HTTP 400 streaming rejection.
- **Definition of Done:** All configuration, architecture, and runbook documentation reflects the implemented MVP without referencing unbuilt or deferred components, and secret files match git check-ignore.
- **Tasks it unblocks:** Unblocks [Task #38](https://github.com/gordonpn/shunt-shim/issues/38) and closes [Story #8](https://github.com/gordonpn/shunt-shim/issues/8) and [Epic #2](https://github.com/gordonpn/shunt-shim/issues/2).

## NEXT - Upcoming Work

1. **[#38: [Task] Add reproducible deployment and ingress verification for one target](https://github.com/gordonpn/shunt-shim/issues/38)**
   - **Priority:** P1 | **Effort:** S | **Readiness:** BLOCKED by #11
   - **Dependencies:** Parent Story #36, Task #11, Task #37 (closed in PR #66)
   - **Reason:** Configures Cloudflare Workers deployment recipe (`just deploy`) and automated ingress smoke test verifying live 401 unauthenticated and 200 model catalog responses.

2. **[#40: [Task] Prove all three deployed clients on each provider](https://github.com/gordonpn/shunt-shim/issues/40)**
   - **Priority:** P1 | **Effort:** M | **Readiness:** BLOCKED by #38
   - **Dependencies:** Parent Story #39, Task #38
   - **Reason:** Validates DeepSeek Review Action, OpenCodeReview, and PR-Agent end-to-end against deployed gateway ingress.

3. **[#41: [Subtask] Prove a deployed client completes a tool-use cycle against each provider](https://github.com/gordonpn/shunt-shim/issues/41)**
   - **Priority:** P1 | **Effort:** M | **Readiness:** BLOCKED by #40
   - **Dependencies:** Parent Story #39, Task #40
   - **Reason:** Executes tool-calling, tool-result execution, and final-response generation end-to-end with deployed ingress.

4. **[#42: [Task] Audit all MVP acceptance criteria and sign off release](https://github.com/gordonpn/shunt-shim/issues/42)**
   - **Priority:** P1 | **Effort:** S | **Readiness:** BLOCKED by #39, #41
   - **Dependencies:** Parent Story #39, Task #41
   - **Reason:** Validates all acceptance criteria across docs/MVP.md and seals the final MVP release.

## BLOCKERS

- None. Task #37 is closed in PR #66. Execution moves directly through Task #11 to Task #38.

## LATER

All remaining roadmap tasks, client tool cycle fallback proofs, and release audit gates are tracked in the GitHub backlog:
https://github.com/gordonpn/shunt-shim/issues?q=is%3Aissue+is%3Aopen
