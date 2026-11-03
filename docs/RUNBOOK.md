# Operational Runbook

This runbook documents setup, deployment, verification, monitoring, rollback, and incident response procedures for `shunt-shim`. The Worker service architecture is defined by [ARCHITECTURE.md](ARCHITECTURE.md), based on foundational decisions in [ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md).

Prerequisites: only Groq and Google AI Studio API keys and one random gateway secret are required. The MVP defers shared accounting and requires no KV namespace or database.

## 1. Prerequisites and Local Environment

Ensure the following tools are installed:
- `node` (v22+) and `pnpm` (v10+)
- `just` (command runner)
- `wrangler` (Cloudflare Workers CLI, available via `pnpm exec wrangler`)

Ensure active developer accounts and API keys from upstream providers:
- Google AI Studio API Key ([aistudio.google.com](https://aistudio.google.com))
- Groq Cloud API Key ([console.groq.com](https://console.groq.com))

## 2. Local Development Setup and Secret Generation

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

### Secret Rotation and Zero-Downtime Updates
To rotate gateway tokens without downtime:
1. Generate a new secret: `just generate-token`.
2. Update Cloudflare Workers secrets:
   ```bash
   GATEWAY_TOKENS="<new-token>" pnpm exec wrangler secret put GATEWAY_TOKENS
   ```
   Or update `.dev.vars` and run `just provision-secrets`.
3. Cloudflare Workers atomically propagates the new secret version across edge nodes within seconds.
4. Update downstream client configurations (DeepSeek Reviewer, OpenCodeReview, PR-Agent) with the new bearer token.

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

To roll back to a specific deployment version ID:
```bash
just rollback <deployment-id>
```

## 4. Verification and Smoke Testing

### Automated Ingress Verification Suite
Run the automated verification suite against local or deployed ingress:
```bash
# Verify local emulator
just verify-ingress http://127.0.0.1:8787

# Verify deployed worker
just verify-ingress https://shunt-shim.<subdomain>.workers.dev
```

If `GATEWAY_TOKENS` is not exported in the shell environment, pass the token explicitly:
```bash
just verify-ingress https://shunt-shim.<subdomain>.workers.dev <your-token>
```

To execute a live end-to-end chat completion against the primary upstream model through the ingress route:
```bash
just verify-ingress-live https://shunt-shim.<subdomain>.workers.dev <your-token>
```

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

#### Verify Unauthenticated Health Endpoints
```bash
curl -i -s "http://127.0.0.1:8787/health"
```
Expected response: HTTP 200 with `{"status":"ok","service":"shunt-shim"}`.

#### Verify Virtual Models Catalog
```bash
curl -s -X GET "http://127.0.0.1:8787/v1/models" \
  -H "Authorization: Bearer ${GATEWAY_SECRET}" | jq .
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
curl -s -X POST "http://127.0.0.1:8787/v1/chat/completions" \
  -H "Authorization: Bearer ${GATEWAY_SECRET}" \
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
curl -i -s -X POST "http://127.0.0.1:8787/v1/chat/completions" \
  -H "Authorization: Bearer ${GATEWAY_SECRET}" \
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
curl -i -X GET "http://127.0.0.1:8787/v1/models" \
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
| Ingress Proxy Timeout | 100 seconds (Cloudflare default) | Exceeds the gateway 60s total deadline, ensuring clean structured 504 timeouts before proxy aborts. |
| Upstream Connect Timeout | 5 seconds per attempt | Enforced via `AbortSignal.any` with `timeout(5000)` on upstream fetch. Triggers fallback on primary timeout. |
| Total Gateway Deadline | 60 seconds total request bound | Gateway aborts active requests and returns HTTP 504 `gateway_timeout`. |
| Client Disconnect | Immediate upstream cancellation | `compatibility_flags = ["enable_request_signal"]` links client TCP disconnect to `Request.signal`, immediately aborting active upstream fetch calls. |

## 7. Incident Handling and Diagnostics

### Upstream HTTP 429 (Rate Limit Tripped)
- Symptom: Real-time logs indicate upstream 429 from Groq.
- Action: Verify that fallback to Gemini was attempted before returning. If both providers are rate-limited, the gateway returns an explicit HTTP 429 error. Inspect provider limits in respective dashboards.

### Upstream Connection Timeout or Outage
- Symptom: Primary request exceeds 5s connection timeout or returns HTTP 503.
- Action: The gateway will automatically attempt fallback to Gemini. If the 60s total request deadline expires, the gateway returns HTTP 504 `gateway_timeout`.

### Client Disconnect
- Symptom: Client aborts the request before completion.
- Action: In-flight upstream fetches abort via linked `AbortController`. Zero attempts are recorded if aborted prior to dispatch.
