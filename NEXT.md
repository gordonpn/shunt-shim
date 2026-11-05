# Project Execution Queue

Last Refined: 2026-11-02T19:30:00-05:00
Repository: gordonpn/shunt-shim
GitHub Backlog: https://github.com/gordonpn/shunt-shim/issues

## NOW - Recommended Next Task

### [#38: [Task] Add reproducible deployment and ingress verification for one target](https://github.com/gordonpn/shunt-shim/issues/38)

- **Priority:** P1
- **Effort:** S
- **Readiness:** IN PROGRESS
- **Why this task is next:** With Task #11 merged in PR #67 and Task #37 closed in PR #66, Task #38 is the final child task of Story #36. Delivering automated ingress verification, secret provisioning, rollback recipes, and operational runbook completes Story #36 and unblocks Task #40.
- **First implementation action:** Add scripts/verify-ingress.ts, scripts/generate-token.ts, Justfile recipes, and comprehensive operational procedures in docs/RUNBOOK.md.
- **Definition of Done:** Automated verification probes pass against local emulator and deployed ingress, secret provisioning and token generation recipes function reproducibly, rollback procedure is documented and scriptable, and platform bounds are verified.
- **Tasks it unblocks:** Unblocks [Task #40](https://github.com/gordonpn/shunt-shim/issues/40) and completes [Story #36](https://github.com/gordonpn/shunt-shim/issues/36).

## NEXT - Upcoming Work

1. **[#40: [Task] Prove all three deployed clients on each provider](https://github.com/gordonpn/shunt-shim/issues/40)**
   - **Priority:** P1 | **Effort:** M | **Readiness:** BLOCKED by #38
   - **Dependencies:** Parent Story #39, Task #38
   - **Reason:** Validates DeepSeek Review Action, OpenCodeReview, and PR-Agent end-to-end against deployed gateway ingress.

2. **[#41: [Subtask] Prove a deployed client completes a tool-use cycle against each provider](https://github.com/gordonpn/shunt-shim/issues/41)**
   - **Priority:** P1 | **Effort:** M | **Readiness:** BLOCKED by #40
   - **Dependencies:** Parent Story #39, Task #40
   - **Reason:** Executes tool-calling, tool-result execution, and final-response generation end-to-end with deployed ingress.

3. **[#42: [Task] Audit all MVP acceptance criteria and sign off release](https://github.com/gordonpn/shunt-shim/issues/42)**
   - **Priority:** P1 | **Effort:** S | **Readiness:** BLOCKED by #39, #41
   - **Dependencies:** Parent Story #39, Task #41
   - **Reason:** Validates all acceptance criteria across docs/MVP.md and seals the final MVP release.

## BLOCKERS

- None. Task #11 is closed in PR #67 and Task #37 is closed in PR #66. Execution moves directly through Task #38 to Task #40.

## LATER

All remaining roadmap tasks, client tool cycle fallback proofs, and release audit gates are tracked in the GitHub backlog:
https://github.com/gordonpn/shunt-shim/issues?q=is%3Aissue+is%3Aopen
