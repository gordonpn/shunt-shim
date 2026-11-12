# Spotify shunt investigation

Research for [#170](https://github.com/gordonpn/shunt-shim/issues/170), checked on 2026-11-12. The issue had no comments when checked. Spotify sources below are pinned to [`aa252eb21df5bbf32b0beb45f84a2c03341ccad8`](https://github.com/spotify/portal-ai-plugins/commit/aa252eb21df5bbf32b0beb45f84a2c03341ccad8); the local comparison uses shunt-shim at `ee23573`.

## Finding

Spotify's shunt is an agent-side delegation plugin, while shunt-shim is an OpenAI-compatible HTTP gateway. Both try to make model use cheaper, but they act at different boundaries. Spotify decides which *work* should leave the main agent's context; shunt-shim dispatches an already constructed completion request to a provider and handles bounded fallback. Spotify's plugin is useful prior art, not a drop-in runtime or provider adapter for this repository.

## Purpose, interfaces, and execution

The [plugin README][readme] describes three layers: hooks enforce selected large-read routing, scripts package files and call AiKA, and skills suggest when to delegate. The [manifest][manifest] identifies version `0.2.0`, author Spotify, Apache-2.0 licensing, and `./skills/`. This shunt plugin targets Claude Code; the broader Portal marketplace's support for other agents does not establish shunt support there.

1. [PreToolUse registration][hooks] runs local Bash commands for Claude's `Read` and `Bash` tools using `CLAUDE_PLUGIN_ROOT`.
2. [check-file-size][read-hook] reads tool-input JSON from stdin with `jq`, counts newlines with `wc -l`, and emits an allow/block decision. It blocks full reads above 350 lines by default; supplying offset or limit, a missing path, or a small file allows the request. Invalid nonnumeric threshold configuration resets to 350.
3. [check-bash-read][bash-hook] heuristically detects leading `cat`, `head`, `tail`, `less`, or `more`, extracts the first candidate path, and applies the same threshold. It allows any command containing a pipe or `>` and does not parse shell syntax comprehensively. This is a token-saving nudge with known escape paths, not a security or file-access boundary. In particular, do not interpret the README's broad description of targeted flags as a complete parser contract: the implementation skips flags while looking for a path.
4. [bulk-read][bulk] accepts `--question` and `--paths`, rejects missing/unreadable files, streams file contents into a temporary message with XML-like path markers, and prints the returned answer to stdout. Its stderr token figure is a byte-count/4 estimate, not metered usage. The markers are context delimiters, not a guarantee against prompt injection or special characters in paths/content.
5. [code-write][write] requires `--spec` and an existing `--reference`, optionally accepts `--target`, removes every output line beginning with a Markdown fence, then prints or directly overwrites the target. It does not perform a code review, syntax check, atomic replacement, or diff approval. The [code-writer skill][writer-skill] explicitly asks the main agent to review generated output; the [bulk-reader skill][reader-skill] asks it to verify exact values before edits.

The shared [aika.sh transport][transport] builds JSON `{mode_name, message}` or `{mode_id, message}` with `jq`, then executes one `portal-cli actions aika:invoke-chat --json --timeout-seconds ... --input ...` call. It selects a configured command, an installed `portal-cli`, or `npx --yes @spotify/portal-cli`. CLI stderr is separated from the JSON stdout envelope. Failures include nonzero exit, malformed JSON, missing `.mode.name`, and empty `.text`. The applied-mode check requires a nonempty name; it does not compare the returned mode identity with the requested ID/name. No retry or provider fallback loop is implemented in this transport.

Every invocation is independent and sends its corpus again; no history is sent. The README and transport comments describe AiKA calls as ephemeral and server-side name resolution as case-insensitive, preferring the caller's modes, then group modes, then public modes, with ambiguity errors. Those backend behaviors are upstream claims, not independently verified here. The published plugin contains the client integration, not the AiKA backend implementation.

## Configuration and integration

The [README][readme] requires Bash tooling and `jq`, the Portal plugin/CLI authenticated to a Portal instance with AiKA, and `bulk-reader` / `code-writer` modes. Existing public modes can be used, or users can create private customized modes. Worker model choice and instructions belong to those modes; the scripts do not select a provider model themselves.

| Environment variable | Default / effect |
| --- | --- |
| `SHUNT_MIN_LINES` | 350; read routing threshold |
| `SHUNT_PORTAL_INSTANCE` | CLI default; instance passed to the action |
| `PORTAL_CLI_BIN` | Override command; otherwise installed CLI, then npx fallback |
| `SHUNT_MAX_PAYLOAD_BYTES` | 120000 on Linux, 400000 otherwise; serialized JSON byte ceiling |
| `SHUNT_TIMEOUT_SECONDS` | 180; forwarded CLI invocation timeout |
| `SHUNT_BULK_READER_MODE_ID` | Optional ID instead of bulk-reader name |
| `SHUNT_CODE_WRITER_MODE_ID` | Optional ID instead of code-writer name |

The payload limit exists because JSON travels in a command-line argument, with platform argv/environment constraints. Raising it does not remove those OS limits. File content leaves the local workspace for the configured Portal/AiKA service; avoiding the main agent's context does not make worker inference free or establish retention/privacy guarantees. The plugin does not supply this gateway's Bearer authentication, `/v1/models`, OpenAI `choices` envelope, tool-call round trip, or provider-key handling.

## Comparison with shunt-shim

The local evidence is [README](../../README.md), [configuration](../CONFIGURATION.md), [compatibility contract](../COMPATIBILITY.md), [architecture](../ARCHITECTURE.md), and [upstream adapter](../../src/upstream.ts).

| Concern | Spotify shunt | shunt-shim at comparison revision |
| --- | --- | --- |
| Execution boundary | Local Claude hooks, skills, Bash, Portal CLI | Cloudflare Worker, TypeScript/Hono, HTTP fetch |
| Public interface | Named script arguments and Portal action JSON | OpenAI-compatible non-streaming chat completions and `fast` model catalog |
| Routing decision | Large-read threshold or agent-selected boilerplate delegation | Explicit virtual alias with primary/fallback providers |
| Context handling | Sends local files to worker; returns summary or generated code | Forwards validated messages/tools; normalizes completion/tool-call responses |
| Reliability | One action call, size ceiling, CLI timeout, response guards | Request/context/output limits, cancellation, shared deadline, at most one eligible fallback |
| State / credentials | No conversation history in requests; Portal CLI authentication | No database/KV in MVP; gateway token and provider keys in Worker bindings |
| Side effects | Optional local target overwrite | Completion response; gateway does not execute generated tools or write workspace files |
| Cost evidence | README reports 82–94% main-context savings on selected bulk reads | Free-tier provider routing; no quota creation or uninterrupted-access guarantee |

There is no verified direct configuration that makes AiKA invoke-chat use shunt-shim as its model endpoint. Such a connection would require separately verified AiKA provider configuration or a new explicit adapter. Renaming a mode to `fast` or pointing the CLI at the gateway would not translate the contracts. Claude's filesystem hooks also cannot run inside the Worker runtime.

## Recommendations

| Decision | Pattern / feature | Reason and next evidence needed |
| --- | --- | --- |
| Adopt as engineering guidance | Deterministic transport fixtures; reject malformed success envelopes | The [transport evals][evals] separate response validation from live credentials. shunt-shim already validates upstream JSON and tool calls; preserve this approach when extending providers rather than importing Bash. |
| Adopt as engineering guidance | Separate protocol plumbing from task instructions | Keeps prompt-specific behavior outside the gateway's compatibility contract. Existing client integrations remain the place to choose review prompts and file selection. |
| Adopt as evaluation discipline | Measure main-context savings separately from worker cost and quality | Future experiments should record both models' tokens, latency, failures, and correctness against exact source, using representative review tasks. |
| Defer | Optional agent-side bulk-read/code-write companion | Requires demonstrated demand, supported agent hooks, privacy choices, and quality/cost benchmarks. It is a separate client project and does not belong in the current HTTP MVP. |
| Defer | Portal/AiKA provider integration | Requires public request/response and authentication contracts, access to an instance, explicit endpoint configurability, and tool-call/timeout compatibility evidence. The plugin alone does not prove them. |
| Avoid | Importing 350-line routing into provider dispatch | File lines are unavailable after clients construct requests and do not measure task complexity, tokenizer size, or provider quota. |
| Avoid | Copying shell parsing, raw failure-envelope output, and direct target overwrites into the gateway | Heuristic routing and shell-side effects do not fit an HTTP adapter. Keep existing no-payload diagnostic logging and bounded structured errors. |
| Avoid | Treating the reported 90% mean savings as gateway savings | Spotify measures selected summary-in-context scenarios; this does not establish total token cost, review accuracy, or free-tier throughput here. |

These recommendations propose no runtime or scope change. Any adoption beyond documentation needs its own issue and acceptance criteria.

## Licensing and attribution

The repository's [Apache License 2.0][license] and plugin manifest permit reuse subject to their terms; this is not a claim that Portal services or model access are included. If copying or modifying upstream source/documentation, retain applicable notices, distribute the license, mark modified files prominently, and carry applicable NOTICE attribution if present in the reused distribution (section 4). The inspected repository-root listing had no NOTICE file; check the complete distribution and any dependencies again before reuse. The license does not grant Spotify trademark rights beyond its stated exceptions.

This report links and paraphrases upstream behavior without importing implementation files. The local checkout has no tracked LICENSE/NOTICE file, so do not infer an outbound project license or treat a future source import as settled merely because the upstream license is permissive. Record exact source paths and pinned revisions for any future import and resolve distribution obligations then.

## Verification and limits

This was a static source comparison using the GitHub connector. The README, license, scripts, hooks, manifest, skills, and eval runner/transport fixtures were read at the pinned commit. No Portal authentication, AiKA mode invocation, benchmark reproduction, or end-to-end Claude hook run was performed. The [eval runner][runner] implements local hook/transport checks and opt-in live benchmarks; its existence is not evidence that those checks passed in this investigation. Its character-based estimates and code-write output weighting do not measure total billed usage, and benchmark call errors can be swallowed, so reported savings require independent validation.

Unknowns include actual deployed mode models/prices, backend retention and name-resolution guarantees, action availability across Portal instances, and compatibility with this gateway's tool-call clients. No production integration should depend on those unknowns without separate evidence.

[readme]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/plugins/shunt/README.md
[manifest]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/plugins/shunt/.claude-plugin/plugin.json
[hooks]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/plugins/shunt/hooks/hooks.json
[read-hook]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/plugins/shunt/hooks/check-file-size
[bash-hook]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/plugins/shunt/hooks/check-bash-read
[bulk]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/plugins/shunt/scripts/bulk-read
[write]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/plugins/shunt/scripts/code-write
[transport]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/plugins/shunt/scripts/lib/aika.sh
[reader-skill]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/plugins/shunt/skills/bulk-reader/SKILL.md
[writer-skill]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/plugins/shunt/skills/code-writer/SKILL.md
[evals]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/plugins/shunt/evals/transport-evals.sh
[runner]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/plugins/shunt/evals/run.sh
[license]: https://github.com/spotify/portal-ai-plugins/blob/aa252eb21df5bbf32b0beb45f84a2c03341ccad8/LICENSE
