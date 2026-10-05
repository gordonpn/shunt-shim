# Operational Runbook

This runbook documents setup, deployment, verification, monitoring, and incident response procedures for `shunt-shim`.

Status: proposed Cloudflare workflow, not currently runnable. The Worker entrypoint and Wrangler configuration do not exist. The [MVP](MVP.md) defers shared accounting and requires no KV namespace; deployment platform selection remains open.

## 1. Prerequisites and Local Environment

Ensure the following tools are installed:
- `bun` (v1.1+ recommended) or `node` (v20+)
- `just` (command runner)
- `wrangler` (Cloudflare Workers CLI, available via `bunx wrangler`)

Ensure active developer accounts and API keys from upstream providers:
- Google AI Studio API Key ([aistudio.google.com](https://aistudio.google.com))
- Groq Cloud API Key ([console.groq.com](https://console.groq.com))
- OpenRouter API Key ([openrouter.ai](https://openrouter.ai)) (optional, for DeepSeek fallback)

## 2. Local Development Setup

1. Copy the environment template:
   ```bash
   cp .env.example .dev.vars
   ```

2. Populate `.dev.vars` with real API credentials:
   ```ini
   GEMINI_API_KEY="AIzaSy..."
   GROQ_API_KEY="gsk_..."
   OPENROUTER_API_KEY="sk-or-v1-..."
   GATEWAY_TOKENS="sk-proj-aider,sk-proj-server,sk-proj-dev"
   ```

3. Start the local worker emulator:
   ```bash
   just dev
   ```
   The local edge server listens by default at `http://127.0.0.1:8787`.

## 3. Production Deployment to Cloudflare Workers

### Step 1: Authenticate with Cloudflare
```bash
bunx wrangler login
```

### Step 2: Provision Edge Secrets
Store credentials securely in Cloudflare:
```bash
bunx wrangler secret put GEMINI_API_KEY
bunx wrangler secret put GROQ_API_KEY
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler secret put GATEWAY_TOKENS
```

### Step 3: Deploy Worker
```bash
just deploy
```
The deployed worker URL will be displayed in the terminal output (for example, `https://shunt-shim.<your-subdomain>.workers.dev`).

## 4. Verification and Smoke Testing

Run the following test commands against your local server (`http://127.0.0.1:8787`) or production URL.

### Verify Virtual Models Catalog
```bash
curl -s -X GET "http://127.0.0.1:8787/v1/models" \
  -H "Authorization: Bearer sk-proj-aider" | jq .
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
curl -s -X POST "http://127.0.0.1:8787/v1/chat/completions" \
  -H "Authorization: Bearer sk-proj-aider" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fast",
    "messages": [
      {"role": "user", "content": "Respond in five words or fewer: system check."}
    ]
  }' | jq .
```

### Test Streaming Chat Completion (`stream: true`)
```bash
curl -N -X POST "http://127.0.0.1:8787/v1/chat/completions" \
  -H "Authorization: Bearer sk-proj-aider" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fast",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Count from 1 to 5."}
    ]
  }'
```
Verify that standard `data: {"choices":[{"delta":{"content":"..."}}]}` SSE events stream followed by `data: [DONE]`.

### Verify Authentication Enforcement
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

### Quota Diagnostics
The MVP has no shared quota counters or circuit-breaker state to inspect. Use upstream status codes, rate-limit headers when available, and provider dashboards as the source of truth. See [deferred accounting](ARCHITECTURE.md#deferred-accounting) before introducing quota storage; KV counters cannot reliably enforce global quotas under concurrency.

## 6. Incident Handling and Diagnostics

### Upstream HTTP 429 (Rate Limit Tripped)
- Symptom: Real-time logs indicate upstream 429 from Groq or Google AI Studio.
- Action: Verify that the one eligible fallback was attempted before response commitment. If both providers are rate-limited, expect an explicit HTTP 429 error. Inspect provider limits and retry guidance rather than local KV counters.

### Google AI Studio Quota Exhaustion
- Symptom: The provider reports quota exhaustion, for example through HTTP 429.
- Action: Check the configured account and model's limits in the provider dashboard. The MVP has no proactive daily counter or predicted reset schedule. If the Gemini fallback is exhausted too, surface the quota error rather than claiming guaranteed failover.

### Upstream Schema or Protocol Drift
- Symptom: Streaming chunks fail to parse or return empty responses.
- Diagnostics: Inspect raw upstream chunks using `just tail`.
- Resolution: Update response normalization mappings in `src/normalizers/` to reflect any changes in upstream response shapes.
