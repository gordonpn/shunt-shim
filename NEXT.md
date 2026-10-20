# Project Execution Queue

Last Refined: 2026-10-20T10:30:00-04:00
Repository: gordonpn/shunt-shim
GitHub Backlog: https://github.com/gordonpn/shunt-shim/issues

## NOW - Recommended Next Task

### [#34: [Subtask] Prove stream failures and cancellation never replay committed requests](https://github.com/gordonpn/shunt-shim/issues/34)

- **Priority:** P0
- **Effort:** S
- **Readiness:** READY
- **Why this task is next:** Test-driven development requires implementing the failing behavior test suite for downstream cancellation, connection timeouts, and overall request deadlines before implementing upstream timeout enforcement in sibling Task #33.
- **First implementation action:** Create `test/cancellation.test.ts` to assert that client disconnect (`request.signal`), 5-second upstream connect timeout, and 60-second overall request deadline terminate upstream dispatch and return HTTP 504 `gateway_timeout`.
- **Definition of Done:** Deterministic failing tests are written in `test/cancellation.test.ts` exercising client disconnect, connect timeout, and total deadline expiration boundaries.
- **Tasks it unblocks:** Unblocks implementation of [Task #33](https://github.com/gordonpn/shunt-shim/issues/33) and subsequent closure of [Story #32](https://github.com/gordonpn/shunt-shim/issues/32) and [Epic #27](https://github.com/gordonpn/shunt-shim/issues/27).

## NEXT - Upcoming Work

1. **[#33: [Task] Propagate cancellation and enforce the total request deadline](https://github.com/gordonpn/shunt-shim/issues/33)**
   - **Priority:** P0 | **Effort:** S | **Readiness:** BLOCKED by #34 test suite
   - **Dependencies:** Sibling Subtask #34
   - **Reason:** Implements `AbortSignal.any([clientSignal, deadlineSignal])`, passing `c.req.raw.signal` to `forwardChatCompletion` and attaching 5-second connection timeouts per attempt.

2. **[#11: [Task] Align configuration and setup documentation with the selected MVP](https://github.com/gordonpn/shunt-shim/issues/11)**
   - **Priority:** P2 | **Effort:** S | **Readiness:** READY
   - **Dependencies:** Parent Story #8, Task #5 (closed), Task #9 (closed)
   - **Reason:** Prunes obsolete references to multi-token tenant catalogs and un-deferred streaming; documents single-token `GATEWAY_TOKENS` and HTTP 400 streaming rejection. Closes Story #8 and Epic #2.

3. **[#37: [Task] Add diagnostics that exclude credentials and conversation content](https://github.com/gordonpn/shunt-shim/issues/37)**
   - **Priority:** P1 | **Effort:** S | **Readiness:** BLOCKED by Story #32 (#33, #34)
   - **Dependencies:** Parent Story #36, Task #31 (closed), Task #33
   - **Reason:** Implements safe structured JSON logging with strict metadata allowlist, omitting Authorization headers, API keys, prompts, and tool arguments.

4. **[#38: [Task] Add reproducible deployment and ingress verification for one target](https://github.com/gordonpn/shunt-shim/issues/38)**
   - **Priority:** P1 | **Effort:** S | **Readiness:** BLOCKED by #11, #37
   - **Dependencies:** Parent Story #36, Task #11, Task #37
   - **Reason:** Configures Cloudflare Workers deployment recipe and automated ingress smoke test verifying live 401 unauthenticated and 200 model catalog responses.

5. **[#40: [Task] Prove all three deployed clients on each provider](https://github.com/gordonpn/shunt-shim/issues/40)**
   - **Priority:** P1 | **Effort:** M | **Readiness:** BLOCKED by #38
   - **Dependencies:** Parent Story #39, Task #38
   - **Reason:** Validates DeepSeek Review Action, OpenCodeReview, and PR-Agent end-to-end against deployed gateway ingress.

## BLOCKERS

- None. Story #32 is ready for active execution following the merge of PR #63.

## LATER

All remaining roadmap tasks, client tool cycle fallback proofs, and release audit gates are tracked in the GitHub backlog:
https://github.com/gordonpn/shunt-shim/issues?q=is%3Aissue+is%3Aopen
