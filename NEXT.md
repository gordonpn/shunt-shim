# Project Execution Queue

Last refined: 2026-11-12 (UTC)
Repository: gordonpn/shunt-shim
Snapshot: 97 open issues and two existing open PRs before this research batch.
Recheck [GitHub](https://github.com/gordonpn/shunt-shim/issues) before claiming work.

## Recommended next work

1. Review [PR #94](https://github.com/gordonpn/shunt-shim/pull/94), which already
   implements #69, #72, #75, #76, and #77. Avoid duplicate implementation PRs.
   It is open, non-draft, and mergeable at this snapshot; that does not establish
   passing required checks or review approval.
2. Finish review of [PR #95](https://github.com/gordonpn/shunt-shim/pull/95).
   Open threads cover a redundant string escape, a test URL assertion flagged by
   CodeQL, setting `BASE_URL` before the documented probe, and recording the
   resource probe's request ID. Verify each against the current head before fixing.
   #95 adds probes and an evidence checklist; it does **not** complete #38.
3. Complete [#110](https://github.com/gordonpn/shunt-shim/issues/110), the
   official-source search-provider economics comparison. It unblocks #111
   (architecture ADR), then #112 (provider selection and release gates), completing
   the #109 foundation needed by search implementation.

The former queue entries #80, #81, and #85 are closed. Deployment automation is
implemented; deployed acceptance evidence remains a separate requirement.

## Unblocked independent research

These tracks can run concurrently with each other and with PR review. Research
does not require changing the production runtime or using provider credentials.

| Issue | Deliverable | Parallel ownership boundary |
| --- | --- | --- |
| [#110](https://github.com/gordonpn/shunt-shim/issues/110) | Current search-provider economics and capability matrix | `docs/FREE_TIERS.md` |
| [#96](https://github.com/gordonpn/shunt-shim/issues/96) | LiteLLM patterns, recommendations, and compatible follow-ups | Gateway comparison report |
| [#97](https://github.com/gordonpn/shunt-shim/issues/97) | CLIProxyAPI patterns, credential boundaries, and failure cases | Separate research report; coordinate the shared comparison index |
| [#169](https://github.com/gordonpn/shunt-shim/issues/169) | cheap-ag orchestration and usage optimization investigation | Separate research report |
| [#170](https://github.com/gordonpn/shunt-shim/issues/170) | Spotify Shunt implementation and licensing comparison | Separate research report |
| [#171](https://github.com/gordonpn/shunt-shim/issues/171) | InferX deployment, inference, operations, and integration investigation | Separate research report |
| [#168](https://github.com/gordonpn/shunt-shim/issues/168) | Decision-model API and free-provider feasibility spike | Separate research report; no endpoint implementation yet |

#96 and #97 contribute to #64; neither alone completes its broader research scope.
The new search initiative #98 explicitly proceeds independently of LLM dogfooding.
Treat issue pricing, quota, and compatibility claims as hypotheses until verified.

## Search implementation after the foundation

Issue dependencies use symbolic names: STORY-1.1 means #109, STORY-2.1 means
#113, STORY-3.1 means #119, STORY-3.2 means #122, and STORY-4.1 means #130.
Read parent prerequisites as well as a task's local blocker list.

| Wave | Work that can proceed in parallel | Gate or coordination requirement |
| --- | --- | --- |
| Foundation | #110 research; independent gateway investigations above | #111 follows #110; #112 follows #110 and #111 |
| Admission and spending policy | #113 ingress/validation/contracts and #130 fail-closed policy | #109 complete; agree canonical types before separate router/provider work |
| Provider foundation | #119 interface and credential-aware registry | #113 contract; #120 precedes #121 |
| Initial adapters | #123 Tavily and #124 Exa in separate modules | #119 complete; combine #125 contract evidence under #122 |
| Routing and normalization | #138 bounded fallback and #144 canonical result normalization | #122 complete; #138 also needs #130 |
| Integration and operations | #150 MCP, #156 privacy, #160 diagnostics/provisioning | Respect each story's ingress/routing prerequisites; coordinate `src/diagnostics.ts` edits |
| Later expansion | #134 atomic reservations; then card-backed provider rollout | #130 complete; verify concurrent reservation and uncertain-outcome handling before enabling paid risk |

Local “Blockers: None” does not make #114, #131, #135, #139, #145, #148,
#154, #157, #161, or #165 ready to ship: their parent story gates still apply.
The #148 benchmark corpus can be prepared separately, but its parent #147 is
blocked on adapters and normalization; do not describe the benchmark as working.
Fetch #164–#167 follows search ingress and MCP foundations; it is not a first wave.

## Live deployment and release blockers

| Work | What remains |
| --- | --- |
| #38 / #36 | Selected deployed Worker, authenticated ingress/resource evidence, CPU/memory observations, bounded cancellation/deadline checks, and rollback proof; #95 is partial preparation |
| #84 | Cloudflare zone/account access, custom domain routing and certificate provisioning, then live ingress verification |
| #40 / #39 | #38 acceptance, account-verified providers/models, and independent evidence for all three pinned clients |
| #41 | #40, then controlled primary failures with a deployed client tool cycle and real fallback |
| #86 | #84 plus deployed gateway credentials and client proof; #80 and #85 are already closed |
| #42 | #39 and #41 evidence, then full acceptance audit; do not infer release readiness from mocked tests |
| #82 | Account-specific Google subscription/API entitlement, billing, quota, and expiry verification; public documentation cannot prove the account's benefit |

The current task environment reports no configured deployment/provider secrets.
This blocks live acceptance work here, not the independent research tracks.

## Backlog reconciliation

Current `docs/MVP.md` and `docs/COMPATIBILITY.md` defer streaming and reject it
explicitly. Open #23–#25 and older initiative acceptance text still ask for SSE.
Reconcile those issues with the current contract before scheduling streaming or
closing umbrella #1, #26, or #35. Closed parents and checked child lists alone
are not evidence that their remaining acceptance criteria passed.

Keep story/subtask delivery boundaries from each issue: do not create separate
PRs for sibling work units when the story requires one focused PR. New research
reports can remain independent by owning separate files. OCR is referenced by
the task runner but is absent in this environment; disclose that review gap in
draft deliveries rather than claiming the review ran.
