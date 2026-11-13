# Operational Runbook

This runbook documents setup, deployment, verification, monitoring, rollback, and incident response procedures for `shunt-shim`. The Worker service architecture is defined by [ARCHITECTURE.md](ARCHITECTURE.md), based on foundational decisions in [ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md).

Live-completion prerequisites: Groq and Google AI Studio API keys and one random gateway secret are required. Local health probes and mocked quality gates need no provider credentials. The MVP defers shared accounting and requires no KV namespace or database.

## 1. Prerequisites and Local Environment

Ensure the following tools are installed:
- Node.js 22 (v22.12.0+) and `pnpm` 10.28.1 (pinned in `package.json`)
- `just` (command runner)
- `wrangler` (Cloudflare Workers CLI, available via `pnpm exec wrangler`)

Ensure active developer accounts and API keys from upstream providers:
- Google AI Studio API Key ([aistudio.google.com](https://aistudio.google.com))
- Groq Cloud API Key ([console.groq.com](https://console.groq.com))

## 2. Local Development Setup and Secret Generation

### Clean-checkout verification (no provider credentials)

Install dependencies before invoking the project scripts:

```bash
just install-ci
just check-format
just lint
just typecheck
just build
just test
just dev
```

After Wrangler reports ready, run `curl --fail http://127.0.0.1:8787/health`
in another terminal and expect `{"status":"ok","service":"shunt-shim"}`.
Stop the server with Ctrl-C. Tests mock upstream calls; the dry-run build does
not deploy. For workflow checks, install `mise.toml` tools with `mise install`
and run `mise exec -- just check-workflows`.

The following steps configure live provider calls. Skip them for mocked tests
and the local health probe.

### Step 1: Generate Gateway Secret
Generate a cryptographically secure 32-byte hex secret (64 lowercase hex characters):
```bash
just generate-token
```

### Step 2: Configure Local Environment
1. Copy the environment template:
   ```bash
   cp .env.example .dev.vars
   ```

2. Populate `.dev.vars` with real API credentials:
   ```ini
   GEMINI_API_KEY="AIzaSy..."
   GROQ_API_KEY="gsk_..."
   GATEWAY_TOKENS="<generated-token-from-step-1>"
   ```

3. Validate required environment secrets:
   ```bash
   just check-secrets
   ```

4. Run local test suite and quality gates:
   ```bash
   just typecheck
   just test
   ```

5. Start the local worker emulator:
   ```bash
   just dev
   ```
   The local edge server listens by default at `http://127.0.0.1:8787`.

### Coordinated Secret Rotation
Because the MVP enforces single-token authentication via exact string comparison in `authMiddleware`, rotating the gateway secret causes active clients presenting the old token to receive HTTP 401 until their configuration is updated. Overlapping multi-token support is deferred to post-MVP.

To execute a coordinated token rotation:
1. Generate a new secret: `just generate-token`.
2. Prepare updated client configurations in downstream runners (for example, repository secrets for DeepSeek Reviewer, OpenCodeReview, or PR-Agent).
3. Update the Cloudflare Workers secret:
   ```bash
   pnpm exec wrangler secret put GATEWAY_TOKENS
   ```
   Enter the new token at Wrangler's prompt, or update `.dev.vars` and run `just provision-secrets`.
4. Immediately apply the new bearer token to downstream client configurations.
5. Verify ingress connectivity and authentication with the new credential:
   ```bash
   just verify-ingress https://shunt-shim.<subdomain>.workers.dev
   ```

## 3. Production Deployment to Cloudflare Workers

### Step 1: Authenticate with Cloudflare
```bash
pnpm exec wrangler login
```

### Step 2: Provision Edge Secrets
Automated provisioning from `.dev.vars` / environment:
```bash
just provision-secrets
```
This pipes each credential from the local environment into `wrangler secret put` non-interactively without leaking values in shell history or process arguments.

### Step 3: Deploy Worker
Deploy the bundle to Cloudflare Workers:
```bash
just deploy
```
The deployed worker URL will be displayed in the terminal output (for example, `https://shunt-shim.<your-subdomain>.workers.dev`).

### Step 4: Inspect Deployments and Rollback
List deployment history with versions, timestamps, and deployment IDs:
```bash
just deployments
```

To roll back immediately to the previous deployment if an issue arises:
```bash
just rollback
```

To roll back to a specific Worker version ID (not the deployment ID):
```bash
just rollback <worker-version-id>
```

### Step 5: Preview Deployments and Automated Delivery

#### Pull Request Previews
To deploy an isolated Worker version with a preview alias locally:
```bash
just deploy-preview pr-80
```
This uploads a Worker Version with `preview_urls: true` and generates a deterministic endpoint (for example, `https://pr-80-shunt-shim.<subdomain>.workers.dev`) without shifting production traffic.

Preview URL lifecycle:
- Each push reassigns the `pr-<number>` alias URL to the newest version.
- Closed or merged pull requests leave the preview endpoint pinned to the last uploaded version until pruned per Cloudflare version retention limits.
- Preview deployments never impact production routes or traffic.

#### Continuous Delivery Pipeline
The GitHub Actions deployment workflow (`.github/workflows/deploy.yml`) automates both preview and production releases:
- Pull requests from the same repository upload a version with `--preview-alias pr-<number>` and run `just verify-ingress`.
- Merges to `main` run quality checks, execute `just deploy`, verify ingress, and automatically trigger `just rollback` if post-deploy verification fails.
- Required repository secrets: `CLOUDFLARE_API_TOKEN` (permissions: `Workers Scripts: Edit`, `Account Settings: Read`) and `CLOUDFLARE_ACCOUNT_ID`. Set `GATEWAY_TOKENS` to enable authenticated conformance checks.

## 4. Verification and Smoke Testing

### Automated Ingress Verification Suite
Run the automated verification suite against local or deployed ingress:
```bash
# Verify local emulator
just verify-ingress http://127.0.0.1:8787

# Verify deployed worker
just verify-ingress https://shunt-shim.<subdomain>.workers.dev
```

The recipes load `GATEWAY_TOKENS` from `.dev.vars`; do not pass it as a command-line argument.

To execute a live end-to-end chat completion against the primary upstream model through the ingress route:
```bash
just verify-ingress-live https://shunt-shim.<subdomain>.workers.dev
```

### Maximum-body and deployment evidence

```bash
# Set the actual URL printed by deployment before running these probes.
export BASE_URL="https://shunt-shim.<your-subdomain>.workers.dev"
just verify-ingress-resource "$BASE_URL"
```

This opt-in probe parses an exact 10 MB JSON body and expects streaming rejection
before upstream dispatch. It does not consume provider quota. Record live probe,
resource, disconnect/deadline, and rollback outcomes using the
[deployment evidence checklist](DEPLOYMENT_EVIDENCE.md). Do not mark #38 complete
from mocked tests or health checks alone. SSE streaming remains outside the MVP.

### Automated Ingress Probes Executed
The `verify-ingress` script executes the following checks:
1. `GET /`: Unauthenticated root probe returns HTTP 200 `{ status: "ok", service: "shunt-shim" }` and verifies `x-request-id` response header presence.
2. `GET /health`: Unauthenticated health probe returns HTTP 200 `{ status: "ok", service: "shunt-shim" }`.
3. `GET /v1/models` (unauthenticated): Returns HTTP 401 with error code `invalid_api_key`.
4. `GET /v1/models` (invalid credentials): Returns HTTP 401 with error code `invalid_api_key`.
5. `POST /v1/chat/completions` (unauthenticated): Returns HTTP 401 with error code `invalid_api_key`.
6. `GET /v1/models` (authenticated): Returns HTTP 200 list containing virtual model `fast`.
7. `POST /v1/models` (method constraint): Returns HTTP 405 with `Allow: GET, OPTIONS` and error code `method_not_allowed`.
8. `POST /v1/chat/completions` (stream rejected): Requests with `"stream": true` return HTTP 400 with code `unsupported_parameter` and param `stream`.
9. `POST /v1/chat/completions` (stream_options rejected): Requests with `"stream_options"` return HTTP 400 with code `unsupported_parameter` and param `stream_options`.
10. `POST /v1/chat/completions` (unknown model routing): Requests for unmapped models return HTTP 404 with code `model_not_found`.
11. `POST /v1/chat/completions` (payload size limit): Payloads exceeding 10 MB return HTTP 413 with code `payload_too_large`.
12. `POST /v1/chat/completions` (live completion, optional via `--live`): Confirms end-to-end upstream model generation returning valid OpenAI-compatible JSON.

### Manual Smoke Testing via curl

Set the actual URL printed by deployment and enter the gateway token without
saving it in shell history (Bash):
```bash
export BASE_URL="https://shunt-shim.<your-subdomain>.workers.dev"
read -rsp 'Gateway token: ' GATEWAY_TOKENS; echo
export GATEWAY_TOKENS
```

The examples below use this deployed URL; set `BASE_URL=http://127.0.0.1:8787`
to test locally. They use the gateway token, never upstream provider keys.

#### Verify Unauthenticated Health Endpoints
```bash
curl -i -s "${BASE_URL}/health"
```
Expected response: HTTP 200 with `{"status":"ok","service":"shunt-shim"}`.

#### Verify Virtual Models Catalog
```bash
curl -s -X GET "${BASE_URL}/v1/models" \
  -H "Authorization: Bearer ${GATEWAY_TOKENS}" | jq .
```
Expected response:
```json
{
  "object": "list",
  "data": [
    {"id": "fast", "object": "model", "owned_by": "shunt-shim"}
  ]
}
```

#### Test Non-Streaming Chat Completion (`fast` alias)
```bash
curl --max-time 65 -sS -X POST "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${GATEWAY_TOKENS}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fast",
    "messages": [
      {"role": "user", "content": "Respond in five words or fewer: system check."}
    ]
  }' | jq .
```
Expected response: HTTP 200 with OpenAI-compatible JSON completion.

#### Verify Streaming Request Rejection (`stream: true`)
Streaming is deferred to post-MVP. Verify that requests with `stream: true` are rejected with HTTP 400 Bad Request:
```bash
curl -i -s -X POST "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${GATEWAY_TOKENS}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fast",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```
Expected response: HTTP 400 Bad Request with:
```json
{
  "error": {
    "message": "Streaming is not supported by this gateway. Please omit 'stream' or set 'stream': false.",
    "type": "invalid_request_error",
    "code": "unsupported_parameter",
    "param": "stream"
  }
}
```

#### Verify Authentication Enforcement
```bash
curl -i -X GET "${BASE_URL}/v1/models" \
  -H "Authorization: Bearer invalid-token"
```
Verify that the server rejects the request with HTTP `401 Unauthorized`.

## 5. Observability and Monitoring

### Real-Time Log Streaming
Tail edge execution logs live:
```bash
just tail
```

### Safe Structured Diagnostics
Every request emits a single structured JSON line upon completion. To safeguard user privacy and security, diagnostic records strictly adhere to an explicit metadata allowlist:

| Field | Type | Description |
|---|---|---|
| `timestamp` | string | ISO 8601 UTC timestamp of request completion. |
| `requestId` | string | Correlation identifier from `x-request-id` header or generated UUID. |
| `status` | number | HTTP response status code. |
| `latencyMs` | number | Total request execution duration in milliseconds. |
| `provider` | string (optional) | Upstream provider serving the request (`groq` or `gemini`). Omitted on pre-dispatch rejections. |
| `model` | string (optional) | Concrete upstream model name. Omitted on pre-dispatch rejections. |
| `fallbackReason` | string (optional) | Reason triggering fallback dispatch (`rate_limit_exceeded`, `service_unavailable`, `connection_timeout`, `network_error`). |
| `attempts` | number (optional) | Count of upstream dispatch attempts executed (`0`, `1`, or `2`). |

**Privacy Controls and Credential Exclusion:**
- Payloads, user prompts, system prompts, assistant completions, tool arguments, and tool results are never logged.
- Client credentials (`Authorization`, `x-api-key`) and upstream secrets (`GROQ_API_KEY`, `GEMINI_API_KEY`) are strictly excluded.
- Pre-dispatch rejections (such as HTTP 400, 401, 404, 405, 413) omit provider and model rather than fabricating placeholder values.
- Downstream clients receive the correlation identifier in the `x-request-id` HTTP response header for tracking.

Example diagnostic log entry:
```json
{"timestamp":"2026-10-29T21:44:57.285Z","requestId":"7be65a03-4510-4139-9175-12e3eceab564","status":200,"latencyMs":142,"provider":"groq","model":"qwen/qwen3.8-27b","attempts":1}
```

Example fallback log entry:
```json
{"timestamp":"2026-10-29T21:44:57.285Z","requestId":"c3a10d92-2310-4f51-b856-02e48aa12d09","status":200,"latencyMs":328,"provider":"gemini","model":"gemini-2.5-flash-lite","fallbackReason":"rate_limit_exceeded","attempts":2}
```

### Quota Diagnostics
The MVP has no shared quota counters or circuit-breaker state to inspect. Use upstream status codes, rate-limit headers when available, and provider dashboards as the source of truth.

## 6. Platform Limits and Resource Bounds

The service operates within defined platform and gateway constraints:

| Boundary | Limit / Specification | Enforcement Mechanism |
|---|---|---|
| Inbound Body Size | 10 MB (10,485,760 bytes) | Inspected via `Content-Length` and stream byte count in `src/validation.ts`. Returns HTTP 413 `payload_too_large`. |
| Workers CPU Limit | 10 ms CPU time per request (Free tier) | Non-blocking asynchronous I/O (network wait time is unmetered by Cloudflare Workers). |
| Workers Request Quota | 100,000 requests per day (Free tier) | Cloudflare edge enforcement. Rate limits return HTTP 429 when exhausted. |
| Upstream Attempt Timeout | 5 seconds per attempt | Covers connection setup and the wait for response headers. A timer aborts the upstream fetch through AbortSignal.any. Triggers fallback with connection_timeout. |
| Total Gateway Deadline | 60 seconds total request bound | Gateway aborts active requests and returns HTTP 504 `gateway_timeout`. |
| Client Disconnect | Request-signal propagation | `compatibility_flags = ["enable_request_signal"]` links client TCP disconnect to `Request.signal`; confirm deployed cancellation before relying on it operationally. |

## 7. Incident Handling and Diagnostics

### Upstream HTTP 429 (Rate Limit Tripped)
- Symptom: Real-time logs indicate upstream 429 from Groq.
- Action: Verify that fallback to Gemini was attempted before returning. If both providers are rate-limited, the gateway returns an explicit HTTP 429 error. Inspect provider limits in respective dashboards.

### Upstream Connection Timeout or Outage
- Symptom: Primary request exceeds 5s connection timeout or returns HTTP 503.
- Action: The gateway will automatically attempt fallback to Gemini. If the 60s total request deadline expires, the gateway returns HTTP 504 `gateway_timeout`.

### Client Disconnect
- Symptom: Client aborts the request before completion.
- Operational Verification:
  1. In one terminal, run `just tail` to stream real-time logs from the deployed Worker (or inspect stdout when testing locally via `just dev`).
  2. In a second terminal, execute a request against the deployed endpoint with an explicit `x-request-id` header for correlation and abort it before completion:
     ```bash
     curl -s -X POST "https://<worker>.<subdomain>.workers.dev/v1/chat/completions" \
       -H "Authorization: Bearer ${GATEWAY_TOKENS}" \
       -H "Content-Type: application/json" \
       -H "x-request-id: disconnect-probe-01" \
       -d '{"model":"fast","messages":[{"role":"user","content":"write a long story"}]}' \
       --max-time 0.2
     ```
  3. Inspect `just tail` output for the matching `requestId` (`disconnect-probe-01`). The diagnostic record only correlates the probe with a completion entry. Its `latencyMs` and `status` do not show that upstream work was cancelled, because `DiagnosticRecord` has no abort field. Do not treat this step as proof of cancellation. Confirm cancellation with a deterministic deployed check before relying on it.
- Invariants: The unit suites (`test/index.test.ts` and `test/cancellation.test.ts`) verify that the linked `AbortController` aborts active upstream work when the request signal fires. Cloudflare Workers propagation requires `enable_request_signal` in `wrangler.jsonc`.
