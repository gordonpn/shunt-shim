# Search Gateway Operational Runbook

> [!NOTE]
> **Implementation Status and Scope:** This runbook defines the operational procedures, financial safety checks, smoke tests, diagnostic telemetry interpretation, and incident response playbooks for the `/v1/search` gateway subsystem (Stories `#113`, `#130`, `#138`, `#160`). It complements the existing OpenAI Chat Completions operational guide in [docs/RUNBOOK.md](RUNBOOK.md). While search runtime components are under active implementation, use this document as the canonical operational specification for search provider management.

---

## 1. Prerequisites and Search Provider Tiers

The `/v1/search` subsystem aggregates upstream web search APIs behind a single authenticated Cloudflare Worker ingress route. To prevent unattended billing charges from autonomous agents or CI loops, providers are categorized by their billing model:

| Provider | Phase | Secret Variable | Billing Model | Default Eligibility (`FREE_ONLY_POLICY=true`) |
| :--- | :--- | :--- | :--- | :--- |
| Tavily | Phase 1 (Default Primary) | `TAVILY_API_KEY` | Hard-capped free tier (no credit card required; 1,000 credits/month) | Eligible |
| Exa | Phase 1 (Default Fallback) | `EXA_API_KEY` | Hard-capped free tier (no credit card required; free starter credits) | Eligible |
| Linkup | Phase 1 (Optional) | `LINKUP_API_KEY` | Hard-capped free allowance | Eligible when configured |
| Brave Search | Phase 2 (Card-Backed) | `BRAVE_API_KEY` | Credit-card-backed ($5/month free credits; automatic paid overage if uncapped) | Quarantined |
| Parallel Search | Phase 2 (Card-Backed) | `PARALLEL_API_KEY` | Credit-card-backed (pay-per-query beyond promotional credits) | Quarantined |

---

## 2. Secret Provisioning and Financial Safety Checks

### Step 1: Configure Local Search Credentials

1. Copy `.env.example` to `.dev.vars` if not already present:
   ```bash
   cp .env.example .dev.vars
   ```

2. Populate `.dev.vars` with Phase 1 free-only search credentials alongside the gateway authentication secret:
   ```ini
   GATEWAY_TOKENS="<64-char-hex-secret>"
   TAVILY_API_KEY="tvly-..."
   EXA_API_KEY="exa-..."
   FREE_ONLY_POLICY="true"
   ```

3. Verify that card-backed provider secrets (`BRAVE_API_KEY`, `PARALLEL_API_KEY`) remain unset or empty in `.dev.vars` during Phase 1 operation.

### Step 2: Provision Cloudflare Worker Secrets

Upload configured search provider secrets to Cloudflare Workers using Wrangler:

```bash
printf "%s" "$TAVILY_API_KEY" | pnpm exec wrangler secret put TAVILY_API_KEY
printf "%s" "$EXA_API_KEY" | pnpm exec wrangler secret put EXA_API_KEY
```

Once the automated secret provisioning recipes from Story `#160` (`#162`) are active in `Justfile`, run:

```bash
just provision-secrets
```

To inspect which secrets are currently bound to the deployed Worker without exposing raw secret values:

```bash
pnpm exec wrangler secret list
```

### Step 3: Verify Financial Safety Guardrails (`FREE_ONLY_POLICY`)

Financial safety is a primary operational invariant (Story `#130`):

- **Default Enforcement (`FREE_ONLY_POLICY=true`):** The gateway defaults to `FREE_ONLY_POLICY=true` (fail-closed). Any provider marked with `requiresCreditCard: true` (such as Brave Search or Parallel Search) is quarantined before dispatch.
- **Explicit Request Quarantine:** If a client explicitly requests a card-backed provider (`"provider": "brave"` or `"provider": "parallel"`) while `FREE_ONLY_POLICY=true` is active, the gateway immediately rejects the request with HTTP 403 and error code `provider_quarantined_for_billing_safety` without contacting the upstream API.
- **Phase 2 Preconditions for Card-Backed Providers:** Operators must not set `FREE_ONLY_POLICY=false` or `ALLOW_CARD_BACKED_PROVIDERS=true` unless Phase 2 Durable Object atomic quota reservations and hard monthly spend caps are deployed and verified.

---

## 3. Smoke Testing Local and Deployed Search Endpoints

Export your gateway authentication secret in the active shell before running manual probes:

```bash
export GATEWAY_TOKENS="$(sed -n 's/^GATEWAY_TOKENS="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' .dev.vars)"
```

Set the target base URL for either the local Wrangler emulator or the deployed Cloudflare Worker:

```bash
# Local development server (just dev)
export GATEWAY_URL="http://127.0.0.1:8787"

# Or deployed Cloudflare Worker
# export GATEWAY_URL="https://shunt-shim.<subdomain>.workers.dev"
```

### Check 1: Unauthenticated Rejection (Expect HTTP 401 `invalid_api_key`)

Verify that `/v1/search` rejects unauthenticated calls or invalid tokens prior to payload validation or upstream dispatch:

```bash
curl -i -s -X POST "${GATEWAY_URL}/v1/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"cloudflare workers runtime limits"}'
```

Expected response: HTTP `401 Unauthorized` with:

```json
{
  "error": {
    "message": "Invalid or missing API token.",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}
```

### Check 2: Invalid Payload and Parameter Bounds (Expect HTTP 400 `invalid_parameter`)

Verify that the schema validator rejects empty queries, out-of-range `max_results` (allowed range: `1` to `20`), or unsupported `search_depth` values (allowed: `"basic"` or `"advanced"`):

```bash
curl -i -s -X POST "${GATEWAY_URL}/v1/search" \
  -H "Authorization: Bearer ${GATEWAY_TOKENS}" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "",
    "max_results": 50,
    "search_depth": "basic"
  }'
```

Expected response: HTTP `400 Bad Request` with:

```json
{
  "error": {
    "message": "Invalid 'query': must be a non-empty string between 1 and 500 characters.",
    "type": "invalid_request_error",
    "code": "invalid_parameter",
    "param": "query"
  }
}
```

### Check 3: Authenticated Search Smoke Probe (`Authorization: Bearer` and `x-api-key`)

Test a live search request using standard `Authorization: Bearer <token>` authentication:

```bash
curl -s -X POST "${GATEWAY_URL}/v1/search" \
  -H "Authorization: Bearer ${GATEWAY_TOKENS}" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Cloudflare Workers Hono routing",
    "max_results": 5,
    "search_depth": "basic"
  }' | jq .
```

Verify that the `x-api-key` header is equally accepted:

```bash
curl -s -X POST "${GATEWAY_URL}/v1/search" \
  -H "x-api-key: ${GATEWAY_TOKENS}" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Cloudflare Workers Hono routing",
    "max_results": 5,
    "search_depth": "basic"
  }' | jq .
```

Expected response: HTTP `200 OK` containing normalized search results, response `request_id`, and the serving `provider` (`"tavily"` or `"exa"`).

---

## 4. Interpreting Privacy-Preserving Search Diagnostic Logs

Stream live Worker execution logs during triage or verification:

```bash
just tail
# Or directly via Wrangler:
pnpm exec wrangler tail
```

### `SearchDiagnosticMetadata` Schema

Every completed `/v1/search` request emits a single structured JSON log line adhering to the `SearchDiagnosticMetadata` allowlist (Story `#160` / Task `#161`):

| Field | Type | Description |
| :--- | :--- | :--- |
| `type` | `"search"` | Discriminator distinguishing search telemetry from chat completion records. |
| `timestamp` | string | ISO 8601 UTC timestamp of request completion. |
| `requestId` | string | Correlation ID from inbound `x-request-id` header or generated UUID (also returned in response `x-request-id`). |
| `status` | number | Final HTTP response status code returned to the client. |
| `latencyMs` | number | Total end-to-end request duration in milliseconds. |
| `provider` | string | Upstream search provider that served the request (`"tavily"`, `"exa"`), or omitted on pre-dispatch rejections. |
| `searchDepth` | `"basic"` \| `"advanced"` | Requested search depth tier. |
| `resultCount` | number | Count of normalized search result items returned (`0` on error). |
| `fallbackOccurred` | boolean | `true` if the primary provider failed and the router failed over to a secondary provider. |
| `fallbackReason` | string (optional) | Low-cardinality reason for primary failure (`"rate_limit_exceeded"`, `"quota_exhausted"`, `"service_unavailable"`, `"connection_timeout"`, `"network_error"`). |

### Privacy and Security Guarantees

- **Zero Query or Content Logging:** Raw search strings (`query`), domain filters (`include_domains`, `exclude_domains`), returned result URLs, titles, and content snippets are never written to logs.
- **Zero Credential Logging:** Inbound client tokens (`Authorization`, `x-api-key`) and upstream API keys (`TAVILY_API_KEY`, `EXA_API_KEY`, `BRAVE_API_KEY`, `PARALLEL_API_KEY`) are never logged.

Example normal primary execution log:

```json
{"type":"search","timestamp":"2026-11-15T01:10:12.402Z","requestId":"9a8b7c6d-1234-4ef0-89ab-0123456789ab","status":200,"latencyMs":412,"provider":"tavily","searchDepth":"basic","resultCount":5,"fallbackOccurred":false}
```

Example fallback execution log (Tavily HTTP 429 failing over to Exa):

```json
{"type":"search","timestamp":"2026-11-15T01:11:04.819Z","requestId":"3f4e5d6c-5678-4ab1-9cde-fedcba987654","status":200,"latencyMs":1185,"provider":"exa","searchDepth":"basic","resultCount":5,"fallbackOccurred":true,"fallbackReason":"rate_limit_exceeded"}
```

---

## 5. Incident Response Playbooks

### Playbook A: Triage Provider Rate Limits (HTTP 429) and Monthly Credit Exhaustion (HTTP 402 / 429)

**Symptoms:**
- `just tail` shows elevated `fallbackOccurred: true` with `fallbackReason: "rate_limit_exceeded"` or `"quota_exhausted"`.
- Latency increases on requests that wait for a primary rejection before dispatching to the secondary provider.
- If all configured free providers are exhausted or rate-limited simultaneously, clients receive HTTP `429 Too Many Requests` or HTTP `503 Service Unavailable` (`no_eligible_free_providers`).

**Automated Gateway Behavior:**
1. When the primary provider (default: Tavily) returns HTTP 429 or HTTP 402/432 (credit exhaustion), the in-worker ephemeral tracker (`src/search/quota/tracker.ts`) records the failure and places that provider into cooldown within the isolate (honoring upstream `Retry-After` headers or applying exponential backoff: 30s, 60s, 120s).
2. The `SearchRouter` immediately dispatches the request to the next eligible free provider (default: Exa) within the 30-second total request deadline.
3. Subsequent requests arriving at the same warm Worker isolate bypass the cooled-down primary provider and route directly to the secondary provider until the cooldown expires.

**Operator Remediation Steps:**
1. **Inspect Live Telemetry:** Run `just tail` and filter for `"type":"search"` to determine whether failures are transient per-minute rate limits (`rate_limit_exceeded`) or persistent monthly quota depletion (`quota_exhausted`).
2. **Verify Provider Dashboards:**
   - **Tavily:** Check remaining monthly API credits at [app.tavily.com](https://app.tavily.com). Free accounts include 1,000 credits/month (`basic` search = 1 credit, `advanced` search = 2 credits).
   - **Exa:** Check remaining starter/free balance and rate limits at [dashboard.exa.ai](https://dashboard.exa.ai).
3. **Rotate Primary Provider if Tavily is Exhausted for the Month:** If Tavily's monthly allowance is depleted (`0` remaining credits), promote Exa to primary (`PRIMARY_SEARCH_PROVIDER=exa`, see Playbook B) so new Worker isolates do not spend an upstream attempt hitting Tavily first.
4. **Total Free-Pool Exhaustion:** If both Tavily and Exa free quotas are exhausted:
   - Do **not** set `FREE_ONLY_POLICY=false` or enable card-backed providers (`BRAVE_API_KEY`, `PARALLEL_API_KEY`) without approved spend caps and Phase 2 quota enforcement.
   - Provision a refreshed or secondary free-tier API key if permitted by provider terms of service, or allow the gateway to fail closed with HTTP 503 (`no_eligible_free_providers`) / HTTP 429 until the monthly quota reset window.

---

### Playbook B: Forcing Primary Provider Rotation (`PRIMARY_SEARCH_PROVIDER=exa`) or Disabling an Impaired Provider

When the default primary provider (Tavily) experiences a prolonged outage, high latency (>5s connection timeouts), or monthly quota exhaustion, rotate the primary search provider to Exa.

#### Option 1: Rotate Primary Search Provider to Exa

1. **Local Development (`.dev.vars`):**
   Update `.dev.vars` and restart `just dev`:
   ```ini
   PRIMARY_SEARCH_PROVIDER="exa"
   ```

2. **Deployed Cloudflare Worker (`wrangler.jsonc` or Wrangler CLI):**
   Set `PRIMARY_SEARCH_PROVIDER` in `wrangler.jsonc` under `"vars"` (or deploy with `--var`):
   ```bash
   pnpm exec wrangler deploy --var PRIMARY_SEARCH_PROVIDER:exa
   ```

3. **Verify Rotation:**
   Execute a smoke test against `/v1/search` and confirm via `just tail` that `provider: "exa"` and `fallbackOccurred: false` are reported on the first attempt.

#### Option 2: Temporarily Disable an Impaired Upstream Provider

If an upstream provider is returning malformed payloads, authentication errors (revoked API key), or persistent 5xx errors and you want to remove it from the candidate pool completely:

1. Delete its secret binding from the Cloudflare Worker so the router marks the provider unconfigured and skips it deterministically:
   ```bash
   # Example: temporarily disable Tavily so all traffic routes exclusively to Exa
   pnpm exec wrangler secret delete TAVILY_API_KEY
   ```
2. Verify via `curl` smoke probe (Section 3, Check 3) that `/v1/search` succeeds using the remaining healthy provider.
3. Once the upstream incident is resolved or a replacement key is generated, restore the secret:
   ```bash
   printf "%s" "$TAVILY_API_KEY" | pnpm exec wrangler secret put TAVILY_API_KEY
   ```

---

### Playbook C: Troubleshooting Error Codes and Escalation Reference

| HTTP Status | Error Code | Root Cause | Operator Remediation and Escalation |
| :--- | :--- | :--- | :--- |
| `400 Bad Request` | `invalid_json` / `invalid_parameter` | Client sent malformed JSON, empty `query`, `query` > 500 chars, `max_results` outside `1..20`, invalid `search_depth`, or > 20 domain filters. | Inspect client agent request payload. No gateway config change required; edge validation rejected the request before consuming upstream credits. |
| `401 Unauthorized` | `invalid_api_key` | Missing, empty, mismatched, or invalid `Authorization: Bearer` or `x-api-key` header from client. | Verify client secret matches `GATEWAY_TOKENS`. If rotating `GATEWAY_TOKENS`, follow Coordinated Secret Rotation in [docs/RUNBOOK.md](RUNBOOK.md). |
| `403 Forbidden` | `provider_quarantined_for_billing_safety` | Client or routing configuration attempted to dispatch to a card-backed provider (`brave`, `parallel`) while `FREE_ONLY_POLICY=true` is enforced. | **Billing Safety Alert:** Confirm no unauthorized change attempted to route to paid tiers. Instruct client to use `"provider": "auto"`, `"tavily"`, or `"exa"`. Never disable `FREE_ONLY_POLICY` without Phase 2 budget caps. |
| `413 Payload Too Large` | `payload_too_large` | Inbound `/v1/search` request body exceeded the 1 MB (1,048,576 bytes) limit. | Reduce request body size or domain filter list length on the calling client. |
| `429 Too Many Requests` | `rate_limit_exceeded` | Primary and fallback providers both returned HTTP 429 rate-limit or credit-exhaustion responses. | Follow **Playbook A**: inspect `just tail` for `fallbackReason`, check Tavily and Exa dashboards for remaining credits, and rotate `PRIMARY_SEARCH_PROVIDER=exa` if only Tavily is exhausted. |
| `502 Bad Gateway` | `upstream_error` | All attempted search providers returned upstream 5xx errors, invalid responses, or upstream authentication failures (such as a revoked upstream API key). | Check `just tail` for upstream status details. Verify `TAVILY_API_KEY` and `EXA_API_KEY` validity against provider dashboards. Re-provision secrets with `just provision-secrets` or disable the broken provider (Playbook B). |
| `503 Service Unavailable` | `no_eligible_free_providers` | No free-tier search provider has valid credentials configured, all free providers are in rate-limit cooldown, or only card-backed keys are present under `FREE_ONLY_POLICY=true`. | **Quota / Config Escalation:** Run `pnpm exec wrangler secret list` to confirm `TAVILY_API_KEY` and `EXA_API_KEY` are bound. If both free tiers depleted their monthly credits, wait for quota reset or provision a valid free-tier key. |
| `504 Gateway Timeout` | `gateway_timeout` | Upstream search attempts exceeded the 5s per-provider connection timeout and/or the 30s total search request deadline. | Inspect upstream status pages for Tavily and Exa latency incidents. Switch primary provider (`PRIMARY_SEARCH_PROVIDER=exa`) if the primary endpoint is hanging on connection establishment. |

---

### Playbook D: Deployment Rollback on Regression

If a recent Worker deployment introduces a regression in `/v1/search` routing, schema validation, or secret bindings:

1. Inspect recent Cloudflare Worker deployments:
   ```bash
   just deployments
   ```

2. Roll back immediately to the previous known-good deployment version:
   ```bash
   just rollback
   ```
   Or target a specific deployment ID:
   ```bash
   just rollback <deployment-id>
   ```

3. Re-run the `/v1/search` smoke tests in Section 3 and the ingress verification suite (`just verify-ingress https://shunt-shim.<subdomain>.workers.dev`) to confirm service recovery.
