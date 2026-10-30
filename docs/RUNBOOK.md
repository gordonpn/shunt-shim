# Operational Runbook

This runbook documents setup, deployment, verification, monitoring, and incident response procedures for `shunt-shim`. The Worker service architecture is defined by [ARCHITECTURE.md](ARCHITECTURE.md), based on foundational decisions in [ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md).

Prerequisites: only Groq and Google AI Studio API keys and one random gateway secret are required. The MVP defers shared accounting and requires no KV namespace or database.

## 1. Prerequisites and Local Environment

Ensure the following tools are installed:
- `node` (v22+) and `pnpm` (v10+)
- `just` (command runner)
- `wrangler` (Cloudflare Workers CLI, available via `pnpm exec wrangler`)

Ensure active developer accounts and API keys from upstream providers:
- Google AI Studio API Key ([aistudio.google.com](https://aistudio.google.com))
- Groq Cloud API Key ([console.groq.com](https://console.groq.com))

## 2. Local Development Setup

1. Copy the environment template:
   ```bash
   cp .env.example .dev.vars
   ```

2. Populate `.dev.vars` with real API credentials:
   ```ini
   GEMINI_API_KEY="AIzaSy..."
   GROQ_API_KEY="gsk_..."
   GATEWAY_TOKENS="<one-random-gateway-secret>"
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

## 3. Production Deployment to Cloudflare Workers

### Step 1: Authenticate with Cloudflare
```bash
pnpm exec wrangler login
```

### Step 2: Provision Edge Secrets
Store credentials securely in Cloudflare:
```bash
pnpm exec wrangler secret put GEMINI_API_KEY
pnpm exec wrangler secret put GROQ_API_KEY
pnpm exec wrangler secret put GATEWAY_TOKENS
```

### Step 3: Deploy Worker
```bash
just deploy
```
The deployed worker URL will be displayed in the terminal output (for example, `https://shunt-shim.<your-subdomain>.workers.dev`).

## 4. Verification and Smoke Testing

Export the configured gateway secret and target base URL for smoke tests:
```bash
GATEWAY_SECRET="<one-random-gateway-secret>"
GATEWAY_BASE_URL="http://127.0.0.1:8787"
```

Run the following test commands against your local server or production URL.

### Verify Virtual Models Catalog
```bash
curl -s -X GET "${GATEWAY_BASE_URL}/v1/models" \
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

### Test Non-Streaming Chat Completion (`fast` alias)
```bash
curl -s -X POST "${GATEWAY_BASE_URL}/v1/chat/completions" \
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

### Verify Streaming Request Rejection (`stream: true`)
Streaming is deferred to post-MVP. Verify that requests with `stream: true` are rejected with HTTP 400 Bad Request:
```bash
curl -i -s -X POST "${GATEWAY_BASE_URL}/v1/chat/completions" \
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

### Verify Authentication Enforcement
```bash
curl -i -X GET "${GATEWAY_BASE_URL}/v1/models" \
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

## 6. Incident Handling and Diagnostics

### Upstream HTTP 429 (Rate Limit Tripped)
- Symptom: Real-time logs indicate upstream 429 from Groq.
- Action: Verify that fallback to Gemini was attempted before returning. If both providers are rate-limited, the gateway returns an explicit HTTP 429 error. Inspect provider limits in respective dashboards.

### Upstream Connection Timeout or Outage
- Symptom: Primary request exceeds 5s connection timeout or returns HTTP 503.
- Action: The gateway will automatically attempt fallback to Gemini. If the 60s total request deadline expires, the gateway returns HTTP 504 `gateway_timeout`.

### Client Disconnect
- Symptom: Client aborts the request before completion.
- Action: In-flight upstream fetches abort via linked `AbortController`. Zero attempts are recorded if aborted prior to dispatch.
