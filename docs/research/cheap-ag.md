# cheap-ag research

Research for [issue #169](https://github.com/gordonpn/shunt-shim/issues/169), checked
2026-11-12 against upstream commit
[`892de9c49bf670ca516933e1b2d9bd7ce533764d`](https://github.com/muaaz9329/cheap-ag/commit/892de9c49bf670ca516933e1b2d9bd7ce533764d)
(package version 1.4.1). The issue had no comments when checked. This is a static
source review, not an installation, benchmark reproduction, or compatibility certification.

## Recommendation

Use cheap-ag as a source of client-side workflow ideas. Do not add its job
orchestration to the gateway. A separate experiment could point cheap-ag's custom
OpenAI-compatible worker endpoint at shunt-shim, but compatibility is unproven.
The two projects solve different problems: cheap-ag delegates repository work;
shunt-shim forwards bounded HTTP completion requests.

## Architecture and execution

The [package manifest][package] requires Node >=20.11 and pins OpenCode and its SDK
to 1.19.0. The [MCP server][server] uses stdio and exposes delegation, read-only
research, job status/wait/cancel, replies to blocked jobs, explicit landing/discard,
and connectivity diagnostics. It runs on the developer machine with filesystem,
Git, and subprocess access; this is not a Worker-compatible execution service.

The execution path is host agent → MCP delegate → isolated Git worktree →
OpenCode worker session → server-run checks → apply a successful patch to the
host working tree, uncommitted. [jobs.ts][jobs] owns verification, repair,
escalation, stopping, and landing; [worker.ts][worker] consumes OpenCode events.
OpenCode's event stream here is a local SDK transport and does not by itself prove
which upstream HTTP completion mode is required.

[Plans][plan] contain steps with files and done-when conditions, optional
dependencies and difficulty. Group selection checks dependency order; file-path
overlap detection can identify conflicting groups. This is explicit task
orchestration, rather than a gateway inferring task intent from prompts.

## Planning models and worker routing

The frontier model stays in Claude Code or Codex and supplies the task/plan.
“Opus/Astra plans” describes that host role, not a built-in Opus/Astra API route.
The [server instructions][server] tell the host to delegate code edits and review
compact results. They are behavioral instructions; they do not prove every host
will obey or every line will come from the worker.

[Routing][routing] separates implement, research, escalation, and optional
medium/hard roles. Difficulty is a host-supplied hint, not a learned classifier.
Provider-specific defaults, presets, overrides, and allowed models determine the
route. Current source includes OpenCode Go/Zen, OpenRouter, DeepSeek, Command Code,
and a custom endpoint called local. Those listed models are upstream configuration
choices, not independently verified availability or free-tier entitlements.

Limit fallbacks continue an existing worker session on another allowed model;
transient errors can trigger a forked-session retry. [Worker event handling][worker]
stops long provider-limit retries so routing can react. [Job repair][jobs] allows
up to two self-fixes and one stronger-model escalation, subject to caps and
eligibility. This operates over a multi-turn coding job, unlike shunt-shim's
single pre-response fallback. It must not be copied as permission to replay
requests after response commitment.

[Configuration][config] defaults include 25 turns, 20 minutes, USD 0.50 per job,
and three parallel groups. These are local job controls, not authoritative
provider quota accounting or guarantees of zero spend.

## Acceptance and reliability limits

[verify.ts][verify] extracts shell commands from backticked done-when fragments,
otherwise uses test_cmd, otherwise returns no commands. The server runs selected
commands independently of the worker's claimed success, stops at the first
failure, bounds command time to five minutes, bounds retained output, and
supports cancellation. Environment failures are distinguished heuristically from
test failures to avoid spending repair attempts on missing tools.

Passing checks are useful evidence, but “tests decide what ships” has important
limits in [jobs.ts][jobs]:

- With no executable checks configured, verification can be empty; an OK outcome
  does not necessarily mean tests ran.
- The worker can modify tests. A passing selected command does not establish
  completeness, resistance to weakened assertions, or code quality.
- A reported reproduction can be rerun after setting aside non-test changes.
  However, a missing, disallowed, or unverified reproduction can produce a risk
  note and still land when normal checks pass. Fail-before/pass-after is not a
  universal hard gate.
- Automatic landing means changes applied uncommitted, not a commit, PR approval,
  deployment, or merge. Failed/partial work also has an explicit manual apply path.
- Commands execute through a shell with inherited environment. A worktree
  isolates Git changes; it is not an operating-system security sandbox.

The upstream [verification tests][verify-tests] exercise command extraction and
execution behavior. They were read, not run in this investigation.
The [benchmark methodology][bench] uses a small fixture, identical prompts,
hidden post-run tests, and token/cost estimates; it explicitly notes few runs,
behavior rather than quality grading, and subscription usage versus money.
The [README][readme] reports additional SWE-bench results and token reductions.
These are author-reported results, not independently reproduced evidence.
Neither the issue's “50x” description nor a USD 20 plan avoiding limits is a
supported general guarantee. Savings depend on task mix, host overhead, retries,
worker billing, and acceptance quality.

## Claude Code, Codex, and shunt-shim compatibility

[Installation code][install] generates a Claude Code plugin with hooks and
commands and registers its launcher separately from the plugin MCP file.
The [README][readme] documents Codex marketplace/plugin installation.
The [server][server] has host-specific instructions; Codex delegates asynchronously
and polls jobs, and its takeover behavior differs from Claude's. Integration is
more than exposing an HTTP inference endpoint: host hooks, tool discovery,
consent, local processes, credentials, and repository state matter.

[Custom endpoint configuration][config] accepts a hosted HTTPS base_url, model,
and an API key from a file or environment variable; it is user-level configuration,
not repository-controlled local configuration. [OpenCode configuration generation][opencode]
uses @ai-sdk/openai-compatible and supplies the base URL and key. This is the
plausible integration seam: cheap-ag remains the client/orchestrator, with
shunt-shim providing model fast and gateway authentication.

Against [MVP.md](../MVP.md) and [ARCHITECTURE.md](../ARCHITECTURE.md), checked at
shunt-shim ee23573:

| Concern | Assessment |
| :--- | :--- |
| Process/runtime | Keep Node, Git worktrees, subprocesses, job storage, MCP and hooks outside the Cloudflare Worker. |
| Protocol | shunt-shim implements Chat Completions JSON and tools; cheap-ag's SDK/provider chain needs a captured-request check before claiming compatibility. |
| Streaming | shunt-shim rejects stream:true and stream_options. This review did not establish an OpenCode configuration that forces non-streaming worker completions. Treat this as a blocking unknown for a pilot. |
| Models | Configure local/fast rather than upstream paid model names. Gateway model selection remains its explicit allowlist. |
| Time and context | Each inference call must fit the gateway's 60-second deadline and request/context bounds; cheap-ag's 20-minute job cap does not extend them. |
| Retries | OpenCode/cheap-ag retries can multiply gateway attempts and spend even though each gateway request permits only one fallback. Measure the combined behavior. |
| Privacy | cheap-ag reads repository content and sends model context; the gateway's metadata-only diagnostics do not prevent that upstream disclosure. Review consent and endpoint credentials separately. |
| Reliability | Preserve shunt-shim's mocked transport/failure acceptance and deployed-client smoke requirements. Agent test success cannot certify gateway compatibility. |

## Adopt, defer, avoid

These are recommendations and candidate follow-ups, not runtime changes or
commitments to expand the MVP.

| Decision | Idea | Follow-up and acceptance evidence |
| :--- | :--- | :--- |
| Adopt | Explicit checks and compact outcome records | Use workflow instructions that record commands actually run, failures, risks and changed files. Distinguish an empty check set from a pass. |
| Adopt | Separate routing intent from availability fallback | Preserve documented role/alias decisions separately from transport retry rules; keep current fast-only scope. |
| Defer | cheap-ag as a gateway client | First capture a synthetic, credential-redacted OpenCode request and establish non-streaming support. Then test tools/results, finish reasons, auth, timeouts, cancellation and primary/fallback independently against a deployed gateway. |
| Defer | Cost/usage optimization | Compare direct versus delegated tasks with identical inputs, independently held acceptance checks, repeats, host and worker usage, latency, failures and total HTTP attempts. Do not infer quota from token savings. |
| Defer | Additional aliases or task-aware routing | Require measured demand and an explicit new contract/ADR; the MCP role system is not justification alone. |
| Avoid | Embedding agent jobs or shell execution in the gateway | It requires a different trust boundary, storage and execution runtime and does not serve the present forwarding contract. |
| Avoid | Treating self-authored tests or risk-noted repro as proof | Keep independent acceptance checks and review the diff before commit; do not make benchmark or reliability guarantees from selected passing tests. |
| Avoid | Importing model prices, plan multipliers or provider defaults as facts | Reverify provider/account terms and actual model access for any proposed integration. |

## Evidence boundaries and open questions

No credentials were supplied to cheap-ag, no code-generation job was executed,
and no upstream provider, plugin installation, cost estimate, or security boundary
was validated at runtime. The key next question is whether OpenCode 1.19.0 can
operate this tool loop against shunt-shim's non-streaming contract. Also unresolved
are actual request extensions, token-limit mappings, context use over long jobs,
cancellation propagation, and total retry amplification. Resolve those in a
separate opt-in client experiment before adding cheap-ag to the compatibility list.

[package]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/package.json
[server]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/src/server.ts
[jobs]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/src/jobs.ts
[worker]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/src/worker.ts
[plan]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/src/plan.ts
[routing]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/src/routing.ts
[config]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/src/config.ts
[verify]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/src/verify.ts
[verify-tests]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/test/verify.test.ts
[bench]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/bench/README.md
[readme]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/README.md
[install]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/src/install.ts
[opencode]: https://github.com/muaaz9329/cheap-ag/blob/892de9c49bf670ca516933e1b2d9bd7ce533764d/src/opencode.ts
