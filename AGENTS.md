# Project Instructions

- When maintaining imported automation, keep runtime-dependent jobs gated on their required project files. Importing SnapTally workflows does not select the gateway runtime.
- Verify workflow changes with `mise exec -- just check-workflows` and keep [automation prerequisites](docs/AUTOMATION.md) current.
- Keep reviewer credentials in repository secrets; both reviewers prefer `REVIEW_GATEWAY_TOKEN` (routing through `https://shunt-shim.gordon-pn.com/v1`), fall back to `DEEPSEEK_API_KEY` when `REVIEW_GATEWAY_TOKEN` is absent, and skip their review steps when both are absent.
