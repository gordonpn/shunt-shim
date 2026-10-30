# Project Execution Queue

Last Refined: 2026-10-28T22:58:00-04:00
Repository: gordonpn/shunt-shim
GitHub Backlog: https://github.com/gordonpn/shunt-shim/issues

## NOW - Recommended Next Task

### [#37: [Task] Add diagnostics that exclude credentials and conversation content](https://github.com/gordonpn/shunt-shim/issues/37)

- **Priority:** P1
- **Effort:** S
- **Readiness:** READY
- **Why this task is next:** Now that Epic #27 and Story #32 are closed in PR #65, Task #37 is the critical-path runtime deliverable unblocking Story #36 and deployment verification (#38).
- **First implementation action:** Write unit tests asserting that structured diagnostic logs contain request IDs, provider, resolved model, HTTP status, latency, and fallback reasons while strictly excluding authorization headers, tokens, API keys, prompts, completions, and tool arguments.
- **Definition of Done:** Safe structured JSON logging implemented in gateway handlers with an explicit metadata allowlist and zero leaks of sensitive or conversation content.
- **Tasks it unblocks:** Unblocks [Task #38](https://github.com/gordonpn/shunt-shim/issues/38) and subsequent closure of [Story #36](https://github.com/gordonpn/shunt-shim/issues/36).

## NEXT - Upcoming Work

1. **[#11: [Task] Align configuration and setup documentation with the selected MVP](https://github.com/gordonpn/shunt-shim/issues/11)**
   - **Priority:** P2 | **Effort:** S | **Readiness:** READY
   - **Dependencies:** Parent Story #8, Task #5 (closed), Task #9 (closed)
   - **Reason:** Prunes obsolete references to multi-token tenant catalogs and un-deferred streaming; documents single-token `GATEWAY_TOKENS` and HTTP 400 streaming rejection. Closes Story #8 and Epic #2.

2. **[#38: [Task] Add reproducible deployment and ingress verification for one target](https://github.com/gordonpn/shunt-shim/issues/38)**
   - **Priority:** P1 | **Effort:** S | **Readiness:** BLOCKED by #11, #37
   - **Dependencies:** Parent Story #36, Task #11, Task #37
   - **Reason:** Configures Cloudflare Workers deployment recipe and automated ingress smoke test verifying live 401 unauthenticated and 200 model catalog responses.

3. **[#40: [Task] Prove all three deployed clients on each provider](https://github.com/gordonpn/shunt-shim/issues/40)**
   - **Priority:** P1 | **Effort:** M | **Readiness:** BLOCKED by #38
   - **Dependencies:** Parent Story #39, Task #38
   - **Reason:** Validates DeepSeek Review Action, OpenCodeReview, and PR-Agent end-to-end against deployed gateway ingress.

4. **[#41: [Subtask] Prove a deployed client completes a tool-use cycle against each provider](https://github.com/gordonpn/shunt-shim/issues/41)**
   - **Priority:** P1 | **Effort:** M | **Readiness:** BLOCKED by #40
   - **Dependencies:** Parent Story #39, Task #40
   - **Reason:** Executes tool-calling, tool-result execution, and final-response generation end-to-end with deployed ingress.

5. **[#42: [Task] Audit all MVP acceptance criteria and sign off release](https://github.com/gordonpn/shunt-shim/issues/42)**
   - **Priority:** P1 | **Effort:** S | **Readiness:** BLOCKED by #39, #41
   - **Dependencies:** Parent Story #39, Task #41
   - **Reason:** Validates all acceptance criteria across docs/MVP.md and seals the final MVP release.

## BLOCKERS

- None. Epic #27 and Story #32 are closed. Execution moves directly to Epic #35 and Story #8.

## LATER

All remaining roadmap tasks, client tool cycle fallback proofs, and release audit gates are tracked in the GitHub backlog:
https://github.com/gordonpn/shunt-shim/issues?q=is%3Aissue+is%3Aopen
