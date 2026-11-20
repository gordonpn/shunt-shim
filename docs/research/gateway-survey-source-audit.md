# Gateway landscape: source identity and runtime audit

Checked 2026-11-15 for [#64](https://github.com/gordonpn/shunt-shim/issues/64).
This is a focused correction to the survey inputs, not the full cross-project
architecture survey. It complements pending [LiteLLM research PR #177](https://github.com/gordonpn/shunt-shim/pull/177)
and [CLIProxyAPI research PR #176](https://github.com/gordonpn/shunt-shim/pull/176)
without changing their files. Keep #64 open.

## Findings that affect the comparison lanes

| Issue reference | Inspected evidence | Result and implication |
| --- | --- | --- |
| `notnotnotnoone/flexrouter`, labeled an edge/serverless Workers router | [pyproject.toml at b960295](https://github.com/notnotnotnoone/flexrouter/blob/b9602952ad067513c39b89a6dcc240fc2b0334c2/pyproject.toml) | Version 2.3.2 requires Python >=3.11 and FastAPI, Uvicorn, httpx, watchdog, Textual and related packages. Treat this revision as a Python service/CLI reference. This manifest does not establish a deployable Cloudflare Workers implementation. |
| `cheaper-inference/OmniRoute`, labeled a Cloudflare Workers router | [package.json at f79a54a](https://github.com/cheaper-inference/OmniRoute/blob/f79a54a49178a037fefac74c496acb395cb021f0/package.json) | Version 3.8.54 specifies Node >=22.22.2 <23 or >=24 <27, Next 16.4.2, Node CLI entrypoints and standalone build scripts. Its package alone does not demonstrate Workers deployment. Verify the actual deployment path before counting it as an edge-runtime implementation. |
| `mulkymalikuldhrs/ProxyGateLLM` | [Requested repository](https://github.com/mulkymalikuldhrs/ProxyGateLLM); authenticated GitHub repository API returned HTTP 404 | Identity/access remains unresolved. A 404 does not distinguish private, renamed or deleted repositories. Do not substitute an unrelated similarly named project or repeat its claimed provider count as verified. |
| `openrouter-ai/openrouter` | [Requested repository](https://github.com/openrouter-ai/openrouter); authenticated GitHub repository API returned HTTP 404 | The specified source repository is unavailable to this audit. Hosted OpenRouter documentation can be a separate architectural reference, but is not evidence that this named repository is an accessible open-source implementation. |

Both manifest revisions were resolved through the official repositories' commit
API and read by exact SHA. These are narrow source observations: a package
manifest establishes declared runtime dependencies, not complete deployment
support, licensing suitability, production reliability or measured performance.
No upstream code was installed, executed or imported.

## How to complete the parent survey

1. Reconcile source identity before comparing functionality. Record accessible
   canonical repositories, exact revisions, licenses, and any rename/alias
   relationship; count one implementation once. Mark unavailable references
   explicitly rather than inventing source-backed coverage; for the two HTTP 404
   references (`mulkymalikuldhrs/ProxyGateLLM` and `openrouter-ai/openrouter`),
   ask the issue author on #64 to confirm canonical URLs or repository access
   before substituting or dropping them.
2. Classify by observed deployment footprint, separately from functional fit:
   free-tier aggregation, edge/serverless, daemon/hosted gateway, and client/UI
   integration are different axes. Do not preserve a Workers label merely because
   it appears in the issue.
3. Evaluate the remaining projects listed in #64 against runtime, routing,
   adapters, streaming, tools, auth, diagnostics and bounded failure behavior.
   Incorporate the focused LiteLLM and CLIProxyAPI reports after review, then
   produce the shared comparison matrix and roadmap.
4. Adopt only patterns fitting the existing Workers contract: explicit provider
   mappings, pre-dispatch validation, two-attempt maximum, cancellation and
   metadata-only diagnostics. Native service processes, local persistence and
   background schedulers require a separate architectural decision, not a direct
   dependency import.

The current evidence does not select a new gateway dependency or runtime. It
removes unsupported runtime assumptions from the research starting point while
leaving source-by-source architecture review and the parent synthesis incomplete.
