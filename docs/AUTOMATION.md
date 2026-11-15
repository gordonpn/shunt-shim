# Repository Automation

The workflows are adapted from [SnapTally's pinned workflow directory](https://github.com/gordonpn/snaptally/tree/2f8868ca935bd8deb88212e1f22bc509a1d14a94/.github/workflows).
This transfer does not select a gateway runtime or implement the gateway.

## Workflow quality gates

CI, CodeQL, and Reviewdog cancel superseded runs for the same pull request,
using separate concurrency groups per workflow and PR number. Push and scheduled
runs use unique run IDs and do not cancel each other. Deployment concurrency
continues to be controlled by the deployment workflow.

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
for review. Both prefer the `REVIEW_GATEWAY_TOKEN` repository secret to route
reviews through `https://shunt-shim.gordon-pn.com/v1` with model alias `fast`.
When `REVIEW_GATEWAY_TOKEN` is absent, both fall back to direct DeepSeek access
using `DEEPSEEK_API_KEY`; when both secrets are absent, their review steps
skip cleanly. Keep draft PRs as drafts while configuring automation.
PR-Agent also accepts created/edited comments on PRs from OWNER, MEMBER, or
COLLABORATOR authors, excluding bots. Its issue-comment workflow becomes usable
after merging to the default branch. Trusted commands may review fork PRs through
the GitHub API; neither reviewer checks out or executes PR code with its secret.

In gateway mode, PR-Agent sets `CONFIG__MODEL=openai/fast`,
`CONFIG__FALLBACK_MODELS=[]`, `CONFIG__MAX_MODEL_TOKENS=128000`,
`CONFIG__CUSTOM_MODEL_MAX_TOKENS=128000`, and
`OPENAI__API_BASE=https://shunt-shim.gordon-pn.com/v1` with `DEEPSEEK_API_KEY`
and `OPENAI_KEY` cleared from the step environment; DeepSeek Review sets
`base-url=https://shunt-shim.gordon-pn.com/v1` and `model=fast`. In fallback
mode (`REVIEW_GATEWAY_TOKEN` absent), PR-Agent uses `deepseek/deepseek-v4-flash`
with fallback `deepseek/deepseek-v4-pro` against `https://api.deepseek.com`,
and DeepSeek Review uses its action defaults (`https://api.deepseek.com` and
`deepseek-v4-flash`). No keys are copied from SnapTally, and `REVIEW_GATEWAY_TOKEN`
must be configured in `GATEWAY_TOKENS` as an independent token (separate from
`PRODUCTION_GATEWAY_TOKENS`) once multi-token support is deployed. Both jobs are
limited to ten minutes.

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

### Separate preview and production credentials

Production uses the `production` GitHub environment. Restrict that environment
with a deployment branch policy allowing only `main`, then configure these
**environment secrets**, never repository secrets:
- `CLOUDFLARE_PRODUCTION_API_TOKEN`: Account `Workers Scripts: Edit` and `Account Settings: Read`; Zone `gordon-pn.com` `Zone: Read`, `Workers Routes: Edit`, and `DNS: Edit` for Custom Domain provisioning.
- `CLOUDFLARE_PRODUCTION_ACCOUNT_ID`: Production account identifier.
- `PRODUCTION_GATEWAY_TOKENS`: Production gateway bearer token for all 11 authenticated probes; omission runs only 5 unauthenticated probes and is not full acceptance evidence.

Optional same-repository PR previews use separate repository secrets:
- `CLOUDFLARE_PREVIEW_API_TOKEN`: Workers-only token with no production account or zone permissions.
- `CLOUDFLARE_PREVIEW_ACCOUNT_ID`: A dedicated non-production Cloudflare account.
- `PREVIEW_GATEWAY_TOKENS`: A preview-only bearer token; never the production token.

PR code can read preview credentials. The dedicated account must contain no
production services, data, credentials, or bindings. Do not reuse the
zone-provisioning token for previews. Forks and previews without both preview
Cloudflare credentials skip deployment; ordinary CI checks still run.

Before enabling preview secrets, bootstrap `shunt-shim` in the preview account
from trusted code, with a preview-only config that has no production domain
routes, and provision dummy upstream provider keys so previews never consume
live free-tier quota. `wrangler versions upload` requires an existing Worker; PR
automation must not bootstrap production or modify production DNS to repair that
prerequisite. Standard preview ingress verification (`just verify-ingress`,
Probes 1-11) runs without `--live` and makes no upstream provider requests; if
testing completions against a preview Worker, override `GROQ_BASE_URL` and
`GEMINI_BASE_URL` to point to an `https://` mock responder instead of live
provider APIs.

Migration requires operator action: rotate and remove the legacy repository
`CLOUDFLARE_API_TOKEN` and production `GATEWAY_TOKENS` after provisioning the
restricted environment. Merely renaming workflow references does not revoke
repository secrets accessible to PR workflows. No live deployment or secret
migration is claimed by this PR.

### Legacy repository secret synchronization

The existing `just sync-github-secrets` helper writes legacy repository secrets;
**do not use it with production credentials**. It does not configure the new
production environment or preview secrets. Provision those through GitHub
environment/repository settings as described above.

For the legacy helper, install GitHub CLI (`gh`) and authenticate with `gh auth login` using an account
with permission to manage this repository's Actions secrets. In the repository
root, copy `.env.example` to `.dev.vars` if needed, then set
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `GATEWAY_TOKENS` there.
Keep this ignored file local; do not paste credential values into commands.

```bash
just sync-github-secrets
gh secret list
```

Just parses `.dev.vars` as dotenv data; it is not sourced as shell code. Existing
environment variables take precedence. The command requires the file and all
three nonempty values, even though deployment verification can otherwise omit
the gateway token. It validates CLI authentication and all required values
before writing any secrets to the repository selected by `gh` from this checkout.
Check the destination with `gh repo view` before running it.

Only those three named secrets are updated, individually through stdin; values
never appear in CLI arguments or command output. `GROQ_API_KEY` and
`GEMINI_API_KEY` are removed from the CLI's environment and never synchronized;
provision them only on the Worker with `just provision-secrets`. Other existing
repository secrets are left untouched. If a write fails, the command stops and
identifies the secret by name; earlier writes may already have succeeded. Fix
access and rerun to converge. `gh secret list` verifies names and update times
without revealing values.

The mock harness `just test-sync-secrets` exercises missing CLI/authentication,
missing file/values, stdin-only writes, the allowlist, redaction, and partial
failure. It also runs in `just check-workflows` without credentials or network.

### Pull request preview deployments

For pull requests originating from the same repository with the separate preview credentials and an existing preview Worker, the workflow uploads an isolated Worker Version with `preview_urls: true` and alias `pr-<number>` (`just deploy-preview-ci <number>`). This exposes a deterministic preview URL (such as `https://pr-<id>-shunt-shim.<subdomain>.workers.dev`) without altering active production traffic. Post-deployment ingress verification runs against the preview URL. Concurrency group `deploy-preview-<number>` with `cancel-in-progress: true` automatically cancels superseded in-flight uploads.

#### Preview URL lifecycle and retention

Preview deployments are version-bound endpoints generated by Cloudflare `wrangler versions upload`:
- **Active pull requests**: Each push to an open pull request uploads a new version and reassigns the `pr-<number>` alias to that latest version. Earlier versions retain their immutable version preview URLs (`https://<version-id>-shunt-shim.<subdomain>.workers.dev`), while the alias URL immediately routes to the latest build.
- **Pull request closure**: When a pull request merges or closes, the preview alias remains pinned to the final version uploaded during the pull request. Preview deployments do not receive production traffic, do not affect production routes, and do not consume worker custom domain slots. Stale preview versions can be inspected via `pnpm exec wrangler versions list` and follow Cloudflare's account-level version retention limits.

### Production deployments and automated rollback

Pushes to the `main` branch trigger production deployment (`just deploy-production-ci`). The workflow runs local quality gates (formatting, linting, typechecking, tests, build) before deploying via `just deploy`. It then runs `just verify-ingress` against both the deployed `workers.dev` endpoint and `https://shunt-shim.gordon-pn.com`. Both must pass; DNS or TLS propagation delays fail verification. After rollback, both endpoints are checked again. A Worker-version rollback may not repair DNS, route, or certificate configuration; persistent failures require operator intervention. If post-deployment ingress verification fails, `just rollback` restores the prior working Worker version immediately and the job exits non-zero. Concurrency group `deploy-production` with `cancel-in-progress: false` serializes production releases.

`wrangler.jsonc` also configures a Cloudflare Workers Custom Domain (`shunt-shim.gordon-pn.com`) alongside `workers.dev` and `preview_urls: true`. On deploy, Cloudflare automatically provisions the DNS record and TLS certificate on the active `gordon-pn.com` zone without affecting PR preview URLs. Verify the custom domain directly with `just verify-ingress https://shunt-shim.gordon-pn.com`.
