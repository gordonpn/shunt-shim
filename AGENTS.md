# Project Instructions

- When maintaining imported automation, keep runtime-dependent jobs gated on their required project files. Importing SnapTally workflows does not select the gateway runtime.
- Verify workflow changes with `mise exec -- just check-workflows` and keep [automation prerequisites](docs/AUTOMATION.md) current.
- Keep reviewer credentials in repository secrets; both imported reviewers require DEEPSEEK_API_KEY and skip their review steps when it is absent.
