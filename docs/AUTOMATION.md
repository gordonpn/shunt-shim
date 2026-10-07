# Repository Automation

The workflows are adapted from [SnapTally's pinned workflow directory](https://github.com/gordonpn/snaptally/tree/2f8868ca935bd8deb88212e1f22bc509a1d14a94/.github/workflows).
This transfer does not select a gateway runtime or implement the gateway.

## Workflow quality gates

CI runs on main-branch pushes and pull requests. Workflow checks run immediately;
the pnpm test job waits for both package.json and pnpm-lock.yaml. When those files
exist, the project must provide typecheck, test, and test:coverage package scripts.
The imported Node 22/pnpm 10 settings apply only to that future pnpm project.
If another runtime is chosen, replace those gates as part of its bootstrap.

Reviewdog runs on pull requests. Actionlint review comments run for same-repository
PRs; read-only CI linting still covers forks. Biome reporting additionally waits
for biome.json or biome.jsonc and both pnpm project files. Its pipeline fails if
either Biome or reviewdog fails, including failures that produce no diagnostics.

Action references are pinned to checked commits. Verification tools are declared
in mise.toml; mise-action installs mise 2026.10.3. Biome is pinned to 2.5.14 and
reviewdog to v0.21.0. Node/pnpm retain the
source workflow's major versions and need exact project pins during bootstrap.

Install the declared local tools with `mise install`, then run
`mise exec -- just check-workflows`. The same Justfile recipe runs in CI. Run
`just review-workflows` for OCR coverage and rules before remote delivery.
Application tests remain inactive and unverified until implementation exists;
a passing workflow-lint job is not evidence that the gateway works.

## Coverage

Coverage runs on PRs and main pushes after both pnpm project files exist. The
test:coverage script must write coverage/lcov.info. Codecov uses the current
repository slug, with CODECOV_TOKEN when configured or its OIDC path otherwise.
Codecov upload errors remain non-blocking as in SnapTally; same-repository PRs
receive an LCOV report with an 80 percent minimum. Configure repository access
in Codecov before expecting successful uploads.

## CodeQL

CodeQL runs on PRs, main pushes, and Mondays at 06:00 UTC after it detects source
files with js, jsx, mjs, cjs, ts, tsx, mts, or cts extensions. Its analysis job has
security-events write permission. Before enabling private-repository analysis,
verify [CodeQL availability and permissions](https://github.com/github/codeql-action/blob/2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2/README.md#license)
and enable code scanning. This transfer does not change repository entitlements.
Neither coverage nor CodeQL currently validates gateway code.
