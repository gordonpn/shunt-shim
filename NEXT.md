# Project Execution Queue

Last Refined: 2026-11-09T10:30:00-05:00
Repository: gordonpn/shunt-shim
GitHub Backlog: https://github.com/gordonpn/shunt-shim/issues

## NOW - Recommended Next Task

### [#80: [CI-CD] Add automated production deployment on push to main and preview deployments on PRs](https://github.com/gordonpn/shunt-shim/issues/80)

- **Priority:** P1
- **Effort:** M
- **Readiness:** IN PROGRESS
- **Why this task is next:** PR #79 delivered reproducible local deployment, secret provisioning, and ingress verification. Task #80 builds on this foundation by automating continuous delivery and pull request preview environments in GitHub Actions with post-deployment ingress checks and automated rollback.
- **First implementation action:** Add `"preview_urls": true` to `wrangler.jsonc`, `deploy-preview` recipes in `Justfile`, deployment runner scripts in `.github/scripts/`, and `.github/workflows/deploy.yml`.
- **Definition of Done:** Same-repo pull requests upload an isolated Worker version with preview alias and verify ingress, pushes to `main` deploy production with automated rollback on verification failure, and external forks/unconfigured environments skip cleanly without failing CI.
- **Tasks it unblocks:** Unblocks [Task #81](https://github.com/gordonpn/shunt-shim/issues/81) and [Task #40](https://github.com/gordonpn/shunt-shim/issues/40).

## NEXT - Upcoming Work

1. **[#81: [Testing] Reuse ingress verification in pipeline integration tests and canaries](https://github.com/gordonpn/shunt-shim/issues/81)**
   - **Priority:** P2 | **Effort:** S | **Readiness:** READY
   - **Dependencies:** Task #80
   - **Reason:** Reuses `verify-ingress` for canary deployments and pipeline integration checks.

2. **[#40: [Task] Prove all three deployed clients on each provider](https://github.com/gordonpn/shunt-shim/issues/40)**
   - **Priority:** P1 | **Effort:** M | **Readiness:** READY
   - **Dependencies:** Parent Story #39, Task #38, Task #80
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

- None. Task #38 deployment automation merged in PR #79. Execution proceeds through Task #80 to Task #81 and Task #40.

## LATER

All remaining roadmap tasks, client tool cycle fallback proofs, and release audit gates are tracked in the GitHub backlog:
https://github.com/gordonpn/shunt-shim/issues?q=is%3Aissue+is%3Aopen
