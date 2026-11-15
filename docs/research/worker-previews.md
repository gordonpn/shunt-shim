# Cloudflare Worker Previews Evaluation for Isolated Pull Request Deployments

**Issue**: [#183](https://github.com/gordonpn/shunt-shim/issues/183)
**Related Issues**: [#134](https://github.com/gordonpn/shunt-shim/issues/134), [#135](https://github.com/gordonpn/shunt-shim/issues/135), [#186](https://github.com/gordonpn/shunt-shim/issues/186)
**Status**: Evaluated (Retain GitHub Actions `wrangler versions upload --preview-alias` flow with `preview_urls: true` and dedicated preview-account isolation)

---

## 1. Recommendation Summary

**Recommendation**: Retain the existing GitHub Actions preview pipeline in `.github/workflows/deploy.yml` and `.github/scripts/deploy-preview.sh` (`wrangler versions upload --preview-alias pr-<number>` with `preview_urls: true` in `wrangler.jsonc`) as the primary gated preview mechanism, paired with the dedicated non-production Cloudflare preview account and credential separation tracked in [#186](https://github.com/gordonpn/shunt-shim/issues/186). Do **not** replace the GitHub Actions preview workflow with unmanaged Cloudflare Workers Builds automatic branch deployments.

### Rationale

1. **Deterministic Post-Deploy Ingress Verification**: Every preview deployment in `shunt-shim` must pass `just verify-ingress <preview-url>` (executing up to 11 conformance probes across `/`, `/health`, `/v1/models`, and `/v1/chat/completions`) before the pull request deployment check succeeds. Native Workers Builds only validates that the bundle compiles and uploads; it cannot natively gate the GitHub check status on the repository's custom `scripts/verify-ingress.ts` conformance suite.
2. **Explicit CI Prerequisite and Fork Gating**: `.github/workflows/deploy.yml` enforces strict repository-file readiness checks (`package.json`, `pnpm-lock.yaml`, `wrangler.jsonc`), credential presence checks, same-repository PR guards (`github.event.pull_request.head.repo.full_name == github.repository`), and per-PR concurrency cancellation (`deploy-preview-<number>`). Keeping orchestration in GitHub Actions guarantees a single auditable control plane alongside `just check-workflows`.
3. **Strict Non-Production Credential and State Isolation ([#186](https://github.com/gordonpn/shunt-shim/issues/186))**: Cloudflare Worker preview URLs (`<version-prefix>-<worker>.<subdomain>.workers.dev` and `<alias>-<worker>.<subdomain>.workers.dev`) execute as versions of a target Worker and share that Worker's secret bindings and account-level stateful bindings by default. Connecting Cloudflare Workers Builds directly to the production Worker would expose production secrets and future Durable Object quota state ([#134](https://github.com/gordonpn/shunt-shim/issues/134), [#135](https://github.com/gordonpn/shunt-shim/issues/135)) to untrusted or unreviewed pull request code.
4. **Native Preview Capabilities Already Enabled**: Because `wrangler.jsonc` already configures `"preview_urls": true` and `.github/scripts/deploy-preview.sh` already invokes `wrangler versions upload --preview-alias pr-<number>`, the repository already benefits from Cloudflare's native deterministic alias URLs, immutable version preview URLs, and version-scoped observability without surrendering CI orchestration to Workers Builds.

---

## 2. Comparison: Current `wrangler versions upload` Flow vs Native Worker Previews / Workers Builds

Cloudflare Worker Previews encompass two layers:
1. **Workers Version Previews (`preview_urls: true` + `wrangler versions upload --preview-alias`)**: The underlying runtime mechanism that exposes immutable version URLs and mutable alias URLs without shifting production traffic. This is already used by `.github/scripts/deploy-preview.sh`.
2. **Workers Builds (Git-connected automatic builds / `wrangler preview`)**: Cloudflare's managed CI/CD integration that automatically builds branches and uploads preview versions directly from GitHub push events.

| Dimension | Current GitHub Actions Flow (`wrangler versions upload --preview-alias pr-<number>`) | Native Workers Builds / Automatic Branch Previews | Assessment for `shunt-shim` |
| :--- | :--- | :--- | :--- |
| **Stable Branch / PR Alias URLs** | Deterministic per-PR alias URL: `https://pr-<number>-shunt-shim.<subdomain>.workers.dev`. Updated atomically on each `synchronize` event for the PR. | Deterministic branch alias URL: `https://<branch-alias>-shunt-shim.<subdomain>.workers.dev` (sanitized branch slug, truncated to label limits). | Current flow is superior for PR review and automation because `pr-<number>` is shorter, never collides on long branch names with slashes, and maps 1:1 to the GitHub PR number. |
| **Immutable Version URLs** | Every upload outputs an immutable version URL: `https://<version-prefix>-shunt-shim.<subdomain>.workers.dev`. Extracted as fallback by `.github/scripts/deploy-preview.sh`. | Every branch build also generates an immutable `https://<version-prefix>-shunt-shim.<subdomain>.workers.dev` URL. | Equivalent at the Cloudflare edge layer; both rely on `preview_urls: true`. |
| **Post-Deploy Verification** | Runs `just verify-ingress "${PREVIEW_URL}"` immediately after upload in the same job; fails the PR check if any health, auth, or contract probe fails. | No native hook to run `node --experimental-strip-types scripts/verify-ingress.ts` after edge propagation and fail the check on contract regression. | Current GitHub Actions flow is required to enforce the gateway ingress contract. |
| **Logs and Observability** | `observability.enabled: true` in `wrangler.jsonc` captures Workers Logs tagged by Version ID. Operators can filter by version in the dashboard or stream via `pnpm exec wrangler tail --version-id <id>`. | Same underlying Workers Logs and `wrangler tail` support per Version ID, plus direct build log links in the Cloudflare dashboard. | Equivalent runtime telemetry. Current flow keeps build and verification logs unified in GitHub Actions without requiring reviewers to log into Cloudflare. |
| **Lifecycle and Cleanup** | Concurrency group `deploy-preview-<number>` cancels superseded runs. Uploaded versions do not route production traffic or consume custom domain slots. Versions age out under Cloudflare's account retention policy; aliases remain pointed at the final PR version after merge/close. | Automatic branch builds upload a new version on every branch push (including non-PR branches unless filtered). Retention follows the same Cloudflare version history limits. | Current flow avoids wasted builds on unreferenced draft branches by triggering only on `pull_request` (`opened`, `synchronize`, `reopened`). |
| **Failure Behavior and Bootstrap Edge Case ([#186](https://github.com/gordonpn/shunt-shim/issues/186))** | If deployment credentials are absent, the job skips cleanly (`configured=false`). If the target Worker has never been created in the target account via `wrangler deploy`, `wrangler versions upload` fails with `You cannot upload a new version of a Worker that does not yet exist. Please run the deploy command first.` | Fails the GitHub check status if the Cloudflare build fails or if account bindings/Worker prerequisites are missing; cannot skip gracefully based on repository file readiness (`needs.project.outputs.ready`). | Current flow cleanly gates unconfigured repositories and fork PRs, provided the target preview account has had its initial `shunt-shim` Worker bootstrapped once from trusted code ([#186](https://github.com/gordonpn/shunt-shim/issues/186)). |

---

## 3. Scoping Bindings, Secrets, MCP Transport, and Ingress Verification

### 3.1 Runtime Secrets (`GATEWAY_TOKENS`, `GROQ_API_KEY`, `GEMINI_API_KEY`, and Future Search Keys)

- **Current MVP Secrets**: `shunt-shim` validates `GATEWAY_TOKENS`, `GROQ_API_KEY`, and `GEMINI_API_KEY` at request time (via `src/config.ts`).
- **Future Phase 2 Search Provider Secrets**: Upcoming search and MCP capabilities will introduce provider API keys (such as Brave Search, Parallel, Tavily, Exa, and Serper).
- **How Worker Previews Handle Secrets**:
  - `wrangler versions upload` uploads a new code bundle and configuration version, and inherits the target Worker's latest deployed secrets unless secret overrides are explicitly supplied.
  - Conversely, `wrangler secret put` creates and activates a new Worker version immediately on the target Worker.
  - Because all preview versions uploaded to a single Worker inherit that Worker's secrets, **preview deployments must never target the production Worker**. Under [#186](https://github.com/gordonpn/shunt-shim/issues/186), preview uploads authenticate with `CLOUDFLARE_PREVIEW_API_TOKEN` and `CLOUDFLARE_PREVIEW_ACCOUNT_ID` against a dedicated non-production Cloudflare account.
  - In the dedicated preview account, `GATEWAY_TOKENS` is provisioned to match the GitHub repository secret `PREVIEW_GATEWAY_TOKENS`, and upstream provider keys (`GROQ_API_KEY`, `GEMINI_API_KEY`, and future search keys) are provisioned with non-production, dummy, or strictly rate-limited sandbox keys so pull request code cannot exhaust production quotas or exfiltrate production keys.

### 3.2 Plaintext Environment Variables (`vars`)

- Plaintext configuration variables (`GATEWAY_ENV`, `PRIMARY_PROVIDER`, `PRIMARY_MODEL`, `FALLBACK_MODEL`, `GROQ_BASE_URL`, `GEMINI_BASE_URL`) are bundled per version when uploaded via `wrangler versions upload`.
- Preview uploads can safely test changes to non-secret variables in `wrangler.jsonc` on an isolated `pr-<number>` alias without affecting other versions, provided the upload targets the isolated preview Worker.

### 3.3 HTTP and Future MCP Transport Behavior on Preview URLs

- **OpenAI-Compatible HTTP Endpoints (`/v1/models`, `/v1/chat/completions`)**:
  - Preview alias URLs (`https://pr-<number>-shunt-shim.<subdomain>.workers.dev`) and immutable version URLs (`https://<version-prefix>-shunt-shim.<subdomain>.workers.dev`) terminate TLS at the Cloudflare edge and route standard HTTP/1.1, HTTP/2, and HTTP/3 requests directly to the uploaded Worker version.
  - Request body streaming, `Content-Length` enforcement (10 MB ceiling), and `Request.signal` disconnect propagation (`compatibility_flags = ["enable_request_signal"]`) behave identically on `*.workers.dev` preview URLs and custom domains.
- **MCP Transport Considerations (Streamable HTTP and Server-Sent Events)**:
  - Cloudflare Worker preview URLs fully support stateless HTTP POST JSON-RPC calls as well as streaming HTTP responses (`Transfer-Encoding: chunked` and `text/event-stream` SSE) within standard Workers wall-clock and CPU bounds.
  - **Subdomain Routing Constraint**: Preview alias URLs rely on the first DNS label under `<subdomain>.workers.dev` (`<alias>-<worker>.<subdomain>.workers.dev`). Wildcard custom domains do not automatically map to preview aliases without explicit custom routing logic. Keeping MCP and HTTP verification pointed at the `https://pr-<number>-shunt-shim.<subdomain>.workers.dev` base URL works out of the box with zero custom DNS setup.
  - **Session Affinity Caveat**: If a future stateful MCP transport relies on multi-request session state across separate HTTP connections, stateless Worker isolates alone do not guarantee isolate affinity on either preview or production URLs unless backed by a Durable Object.

### 3.4 Post-Deploy Ingress Verification (`just verify-ingress`)

- `.github/scripts/deploy-preview.sh` parses `Version Preview Alias URL:` (falling back to `Version Preview URL:`) from the `just deploy-preview "pr-${PR_NUMBER}"` output and invokes:
  ```bash
  just verify-ingress "${PREVIEW_URL}"
  ```
- `scripts/verify-ingress.ts` normalizes the preview URL and executes:
  - **Probes 1-5 (Unauthenticated)**: `GET /` (200 + `x-request-id`), `GET /health` (200), `GET /v1/models` without token (401 `invalid_api_key`), `GET /v1/models` with invalid token (401 `invalid_api_key`), and `POST /v1/chat/completions` without token (401 `invalid_api_key`).
  - **Probes 6-11 (Authenticated, when `GATEWAY_TOKENS` is set in the runner environment)**: `GET /v1/models` (200 with `fast` model), `POST /v1/models` (405 with `Allow: GET`), `POST /v1/chat/completions` with `stream: true` (400 `unsupported_parameter`), `POST /v1/chat/completions` with `stream_options` (400 `unsupported_parameter`), `POST /v1/chat/completions` with unknown model (404 `model_not_found`), and `POST /v1/chat/completions` exceeding 10 MB (413 `payload_too_large`).
- None of the 11 standard CI probes dispatch live traffic to Groq or Gemini (`--live` is omitted in CI), so preview ingress verification deterministically validates edge routing, middleware, authentication, and request bounds without consuming upstream LLM tokens.

---

## 4. Stateful Resource Isolation Risks (Durable Objects, KV, D1, R2, Queues, Workflows)

A critical architectural finding of this evaluation is that **Cloudflare Worker Preview URLs isolate code execution by version, but do NOT automatically isolate bound stateful resources within the same Cloudflare account and Worker configuration.**

### 4.1 Resource Isolation Matrix

| Resource / Binding Type | Current / Planned Usage in `shunt-shim` | Behavior Under Same-Account `wrangler versions upload` Preview | Isolation Risk if Previews Share the Production Account | Required Mitigation |
| :--- | :--- | :--- | :--- | :--- |
| **Durable Objects** | Planned in [#134](https://github.com/gordonpn/shunt-shim/issues/134) and [#135](https://github.com/gordonpn/shunt-shim/issues/135) (`SearchQuotaCoordinator` for atomic monthly credit reservations on card-backed providers). | Preview versions bind to the **exact same Durable Object namespace and storage instances** defined in `wrangler.jsonc` unless overridden. Furthermore, Durable Object class migrations cannot be applied via `wrangler versions upload` alone. | **Critical**: A PR preview could decrement, corrupt, or reset live `monthly_limits`, `current_spend`, or `active_reservations` in `SearchQuotaCoordinator`, causing financial budget overruns or false `QUOTA_EXHAUSTED` lockouts in production. | Deploy PR previews to a dedicated non-production Cloudflare account ([#186](https://github.com/gordonpn/shunt-shim/issues/186)) with its own isolated `SearchQuotaCoordinator` namespace. |
| **Workers KV** | None in MVP (deferred per `docs/CONFIGURATION.md`). | Shares the bound KV namespace ID unless a separate `preview_id` or environment binding is used. | **High**: Writes or deletions from preview requests mutate live keys. | Keep previews in a dedicated preview account ([#186](https://github.com/gordonpn/shunt-shim/issues/186)); never bind production KV namespace IDs in preview runs. |
| **D1 Databases** | None in MVP. | Shares the bound `database_id` across all versions of the Worker. | **Critical**: Schema migrations or test writes mutate production tables. | Use a separate Cloudflare account ([#186](https://github.com/gordonpn/shunt-shim/issues/186)) or distinct D1 database per environment. |
| **R2 Buckets** | None in MVP. | Shares the bound `bucket_name` across all versions of the Worker. | **High**: Object puts/deletes affect the shared bucket. | Isolate by Cloudflare account ([#186](https://github.com/gordonpn/shunt-shim/issues/186)) or bucket name. |
| **Queues & Workflows** | None in MVP. | Preview versions publishing to a bound Queue or triggering a Workflow enqueue messages into the shared account resource; consumer Workers process them using the active deployed consumer. | **High**: Preview producer traffic can inject test payloads into production consumers, and preview consumer code cannot be isolated on a shared queue. | Isolate by Cloudflare account ([#186](https://github.com/gordonpn/shunt-shim/issues/186)). |
| **Custom Domains & Routes** | Production uses `shunt-shim.gordon-pn.com` ([#84](https://github.com/gordonpn/shunt-shim/issues/84), PR [#185](https://github.com/gordonpn/shunt-shim/pull/185)). | `wrangler versions upload` does not modify active Custom Domain routes, which remain attached to the active production deployment. However, a token with `Zone` or `Workers Routes: Edit` in the production account could be abused by untrusted PR workflow changes if exposed to PR jobs. | **Critical**: If PR jobs hold a production token with route/DNS permissions, a modified PR script could run `wrangler deploy` instead of `wrangler versions upload` and hijack `shunt-shim.gordon-pn.com`. | Enforce [#186](https://github.com/gordonpn/shunt-shim/issues/186): preview jobs receive only `CLOUDFLARE_PREVIEW_API_TOKEN` scoped to a dedicated non-production account with zero DNS/zone permissions. |

### 4.2 Implications for `SearchQuotaCoordinator` ([#134](https://github.com/gordonpn/shunt-shim/issues/134) / [#135](https://github.com/gordonpn/shunt-shim/issues/135))

When `SearchQuotaCoordinator` is added to `wrangler.jsonc`:
1. **Storage Isolation**: Because `SearchQuotaCoordinator` uses `ctx.storage` keyed by provider and billing window (`"2026-11"`), running preview traffic in the dedicated preview Cloudflare account ([#186](https://github.com/gordonpn/shunt-shim/issues/186)) guarantees physical storage separation from production without requiring code-level key prefixing.
2. **Migration Bootstrap Constraint**: Cloudflare requires Durable Object migrations (`migrations` array in `wrangler.jsonc`) to be deployed via `wrangler deploy` when introducing or renaming a Durable Object class before `wrangler versions upload` can reference the new class binding. Operators (or a gated main-branch/bootstrap step) must run `wrangler deploy` once on the preview Worker when a new Durable Object migration is introduced.

---

## 5. Required Configuration, Secrets, Permissions, and Migration/Rollback Plan

### 5.1 Wrangler Configuration (`wrangler.jsonc`)

`wrangler.jsonc` already includes `"preview_urls": true` and `"observability": { "enabled": true }`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "shunt-shim",
  "main": "src/worker.ts",
  "compatibility_date": "2026-03-01",
  "compatibility_flags": [
    "enable_request_signal"
  ],
  "preview_urls": true,
  "observability": {
    "enabled": true
  }
}
```

When Custom Domain routing (`routes` with `custom_domain: true` for `shunt-shim.gordon-pn.com` and `workers_dev: true`, as introduced in PR [#185](https://github.com/gordonpn/shunt-shim/pull/185)) is active on `main`:
- `wrangler versions upload --preview-alias pr-<number>` ignores top-level `routes` / `custom_domain` attachments during version upload and publishes only the version and its `pr-<number>-shunt-shim.<subdomain>.workers.dev` preview alias.
- For the initial bootstrap of the `shunt-shim` Worker in the dedicated preview account ([#186](https://github.com/gordonpn/shunt-shim/issues/186)), the operator bootstraps the Worker without production custom-domain routes so the preview account requires no zone permissions on `gordon-pn.com`.

### 5.2 Secrets, Environments, and Permissions Architecture ([#186](https://github.com/gordonpn/shunt-shim/issues/186))

To maintain strict isolation between pull request previews, production deployments, and automated code reviewers (`AGENTS.md`):

| Credential Name | Storage Scope | Target Environment / Consumer | Required Permissions / Purpose |
| :--- | :--- | :--- | :--- |
| `CLOUDFLARE_PREVIEW_API_TOKEN` | GitHub Repository Secret | `preview` job in `.github/workflows/deploy.yml` (same-repo PRs) | Scoped **exclusively** to the dedicated non-production Cloudflare preview account: `Account -> Workers Scripts: Edit`, `Account -> Account Settings: Read`. **No** production account access, **no** `Zone` or `DNS` permissions. |
| `CLOUDFLARE_PREVIEW_ACCOUNT_ID` | GitHub Repository Secret | `preview` job in `.github/workflows/deploy.yml` | Account ID of the dedicated non-production Cloudflare preview account. |
| `PREVIEW_GATEWAY_TOKENS` | GitHub Repository Secret | `preview` job in `.github/workflows/deploy.yml` (`GATEWAY_TOKENS` env) | Non-production gateway bearer token matching the `GATEWAY_TOKENS` secret provisioned on the preview Worker; enables all 11 conformance probes in `just verify-ingress`. |
| `CLOUDFLARE_PRODUCTION_API_TOKEN` | GitHub Environment Secret (`production` environment, restricted to `main`) | `production` job in `.github/workflows/deploy.yml` | Scoped to the production Cloudflare account: `Account -> Workers Scripts: Edit`, `Account -> Account Settings: Read`, plus `Zone -> Zone: Read`, `Zone -> Workers Routes: Edit`, and `Zone -> DNS: Edit` for `gordon-pn.com`. Inaccessible to PR jobs. |
| `CLOUDFLARE_PRODUCTION_ACCOUNT_ID` | GitHub Environment Secret (`production` environment, restricted to `main`) | `production` job in `.github/workflows/deploy.yml` | Account ID of the production Cloudflare account. |
| `PRODUCTION_GATEWAY_TOKENS` | GitHub Environment Secret (`production` environment, restricted to `main`) | `production` job in `.github/workflows/deploy.yml` (`GATEWAY_TOKENS` env) | Production gateway bearer token for post-deploy verification on `main`. |
| `DEEPSEEK_API_KEY` | GitHub Repository Secret | `.github/workflows/deepseek-review.yml` and `.github/workflows/pr-agent.yml` | Retained in repository secrets per `AGENTS.md`. Both reviewer workflows skip cleanly when `DEEPSEEK_API_KEY` is absent and never check out or execute untrusted PR code with the secret. |

### 5.3 Preserving Workflow Prerequisite Gating

In accordance with `AGENTS.md` and `docs/AUTOMATION.md`:
1. **Runtime Project File Gate**: The `project` job in `.github/workflows/deploy.yml` checks `hashFiles('package.json') != '' && hashFiles('pnpm-lock.yaml') != '' && hashFiles('wrangler.jsonc') != ''` before any preview or production job can start.
2. **Credential Availability Gate**: If preview credentials (`CLOUDFLARE_PREVIEW_API_TOKEN` / `CLOUDFLARE_PREVIEW_ACCOUNT_ID`) are not configured, the preview prerequisite check outputs `configured=false` and the `preview` job skips cleanly without failing pull request checks. Additionally, `.github/scripts/deploy-preview.sh` exits `0` when credentials are empty in local or dry-run environments.
3. **Same-Repository Pull Request Gate**: The `preview` job requires `github.event.pull_request.head.repo.full_name == github.repository`, ensuring fork pull requests never receive preview deployment tokens.
4. **Workflow Verification**: Any future adjustments to `.github/workflows/deploy.yml` or `.github/scripts/deploy-preview.sh` must be verified with `mise exec -- just check-workflows` (which runs `actionlint`, `shellcheck`, `test-secrets`, `test-deploy-scripts`, `test-sync-secrets`, and `wrangler.jsonc` flag checks).

### 5.4 Operational Bootstrap, Migration, and Rollback Plan

#### Step 1: Dedicated Preview Account Bootstrap (Tracked in [#186](https://github.com/gordonpn/shunt-shim/issues/186))
Because `wrangler versions upload` cannot create a Worker that does not yet exist (`You cannot upload a new version of a Worker that does not yet exist. Please run the deploy command first`), perform a one-time bootstrap in the dedicated preview Cloudflare account from a trusted checkout:
1. Authenticate with the preview account credentials (`CLOUDFLARE_ACCOUNT_ID=<preview-account-id>` and `CLOUDFLARE_API_TOKEN=<preview-api-token>`).
2. Deploy the initial `shunt-shim` Worker to the preview account using a preview configuration without custom-domain routes (`workers.dev` and `preview_urls: true` enabled).
3. Provision non-production secrets on the preview Worker (`GATEWAY_TOKENS` set to the `PREVIEW_GATEWAY_TOKENS` value, plus non-production `GROQ_API_KEY` and `GEMINI_API_KEY`) via `just provision-secrets`.
4. Store `CLOUDFLARE_PREVIEW_API_TOKEN`, `CLOUDFLARE_PREVIEW_ACCOUNT_ID`, and `PREVIEW_GATEWAY_TOKENS` in GitHub repository secrets, and store production credentials in the branch-protected `production` GitHub environment.

#### Step 2: Standard Pull Request Preview Lifecycle
1. Opening or updating a same-repository pull request triggers `.github/workflows/deploy.yml` -> `just deploy-preview-ci <pr-number>`.
2. `wrangler versions upload --preview-alias pr-<number>` uploads the candidate bundle and updates `https://pr-<number>-shunt-shim.<preview-subdomain>.workers.dev`.
3. `just verify-ingress` runs all 11 conformance probes against the preview URL. Any contract failure fails the `runner / deploy preview` check before merge.

#### Step 3: Rollback and Fallback Procedures
- **Bad Preview Version on an Open PR**: Pushing a fix to the PR branch (or re-running `just deploy-preview pr-<number>` from a known-good commit) immediately reassigns the `pr-<number>` alias to the new version. Previous immutable version URLs (`https://<version-prefix>-shunt-shim.<preview-subdomain>.workers.dev`) remain accessible for bisecting regressions.
- **Disabling Previews During Cloudflare Preview Account Maintenance**: Clearing `CLOUDFLARE_PREVIEW_API_TOKEN` or `CLOUDFLARE_PREVIEW_ACCOUNT_ID` in repository secrets causes `needs.project.outputs.configured` (or `needs.project.outputs.preview_configured` post-[#185](https://github.com/gordonpn/shunt-shim/pull/185)) to evaluate to `false`, gracefully skipping the preview job across all open PRs without blocking CI quality gates (`check-format`, `lint`, `typecheck`, `test`, `build`, `check-workflows`).
- **Production Rollback Independence**: Because preview versions upload via `wrangler versions upload` in a separate preview account and never modify active traffic splits in the production account, preview failures cannot impact production traffic. Production deployments on `main` retain independent automatic rollback via `just rollback` in `.github/scripts/deploy-production.sh`.
