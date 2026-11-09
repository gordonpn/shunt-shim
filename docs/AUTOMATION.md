# Repository Automation

The workflows are adapted from [SnapTally's pinned workflow directory](https://github.com/gordonpn/snaptally/tree/2f8868ca935bd8deb88212e1f22bc509a1d14a94/.github/workflows).
This transfer does not select a gateway runtime or implement the gateway.

## Workflow quality gates

CI runs on main-branch pushes and pull requests. Workflow checks run immediately;
the pnpm test job executes because `package.json` and `pnpm-lock.yaml` are present.
The project provides `format:check`, `lint`, `typecheck`, `test`, `test:coverage`,
and `build` package scripts. Node 22 is configured via `actions/setup-node`, and
`pnpm/action-setup` automatically derives `pnpm@10.28.1` from `packageManager`.

Reviewdog runs on pull requests. Actionlint review comments run for same-repository
PRs; read-only CI linting still covers forks. Biome reporting additionally waits
for biome.json or biome.jsonc and both pnpm project files. Its pipeline fails if
either Biome or reviewdog fails, including failures that produce no diagnostics.

Action references are pinned to checked commits. Verification tools are declared
in mise.toml; mise-action installs mise 2026.10.3. Biome is pinned to 2.5.14 and
reviewdog to v0.21.0. The Cloudflare Worker bootstrap is active and tested,
with unit tests achieving full branch and statement coverage.

Install the declared local tools with `mise install`, then run
`mise exec -- just check-workflows`. The same Justfile recipe runs in CI. Run
`just review-workflows` for OCR coverage and rules before remote delivery.

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
actions read and security-events write permissions. Before enabling
private-repository analysis, verify [CodeQL availability and permissions](https://github.com/github/codeql-action/blob/2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2/README.md#license)
and enable code scanning. This transfer does not change repository entitlements.
Neither coverage nor CodeQL currently validates gateway code.

## Review actions

DeepSeek Review and PR-Agent run when a human marks a same-repository PR ready
for review. Both require the DEEPSEEK_API_KEY repository secret; without it their
review steps skip. Keep draft PRs as drafts while configuring automation.
PR-Agent also accepts created/edited comments on PRs from OWNER, MEMBER, or
COLLABORATOR authors, excluding bots. Its issue-comment workflow becomes usable
after merging to the default branch. Trusted commands may review fork PRs through
the GitHub API; neither reviewer checks out or executes PR code with its secret.

The workflows retain direct DeepSeek access. PR-Agent uses
deepseek/deepseek-v4-flash for primary and deepseek/deepseek-v4-pro for fallback;
DeepSeek Review uses its pinned action's default model. They do not exercise the
proposed shunt-shim endpoint. Store the provider key as DEEPSEEK_API_KEY in
repository secrets; no keys are copied from SnapTally. Both jobs are limited to
ten minutes.

The source PR-Agent action pulls a mutable github_action Docker tag even when
its action commit is pinned. This workflow uses that same action image pinned to
the [Docker Hub tag's image digest](https://hub.docker.com/r/pragent/pr-agent/tags?name=github_action),
checked on 2026-10-07 UTC. Refresh the digest deliberately when upgrading.
The [source action Dockerfile](https://github.com/The-PR-Agent/pr-agent/blob/1d01f24f455bb879c1d9c557ad7de3d72dcc7975/Dockerfile.github_action_dockerhub)
documents that image selection.

DeepSeek Review enforces skeptical correctness review focusing on boundary
conditions, runtime context, edge cases, and verifiable contract behavior.
PR-Agent reads repository configuration in `.pr_agent.toml` to enforce skeptical
architecture review, challenging unneeded complexity or abstractions against
documented repository architecture and structuring findings into its review
schema.

## Continuous deployment and preview environments

Continuous deployment runs via `.github/workflows/deploy.yml`. It requires `package.json`, `pnpm-lock.yaml`, and `wrangler.jsonc` before initiating deployment jobs.

### Required repository secrets

Configure the following secrets in repository settings:
- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with `Workers Scripts: Edit` and `Account Settings: Read` permissions.
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account identifier.
- `GATEWAY_TOKENS` (optional): Gateway bearer token for running all 11 authenticated ingress conformance probes after deployment. When omitted, the verifier runs the 5 unauthenticated health and error contract probes.

When credentials are not configured or on external fork pull requests, deployment jobs skip safely without failing CI checks or exposing secrets.

### Pull request preview deployments

For pull requests originating from the same repository, the workflow uploads an isolated Worker Version with `preview_urls: true` and alias `pr-<number>` (`just deploy-preview-ci <number>`). This exposes a deterministic preview URL (such as `https://pr-<id>-shunt-shim.<subdomain>.workers.dev`) without altering active production traffic. Post-deployment ingress verification runs against the preview URL. Concurrency group `deploy-preview-<number>` with `cancel-in-progress: true` automatically cancels superseded in-flight uploads.

#### Preview URL lifecycle and retention

Preview deployments are version-bound endpoints generated by Cloudflare `wrangler versions upload`:
- **Active pull requests**: Each push to an open pull request uploads a new version and reassigns the `pr-<number>` alias to that latest version. Earlier versions retain their immutable version preview URLs (`https://<version-id>-shunt-shim.<subdomain>.workers.dev`), while the alias URL immediately routes to the latest build.
- **Pull request closure**: When a pull request merges or closes, the preview alias remains pinned to the final version uploaded during the pull request. Preview deployments do not receive production traffic, do not affect production routes, and do not consume worker custom domain slots. Stale preview versions can be inspected via `pnpm exec wrangler versions list` and follow Cloudflare's account-level version retention limits.

### Production deployments and automated rollback

Pushes to the `main` branch trigger production deployment (`just deploy-production-ci`). The workflow runs local quality gates (formatting, linting, typechecking, tests, build) before deploying via `just deploy`. It then runs `just verify-ingress` against the deployed production endpoint. If post-deployment ingress verification fails, `just rollback` restores the prior working Worker version immediately and the job exits non-zero. Concurrency group `deploy-production` with `cancel-in-progress: false` serializes production releases.
