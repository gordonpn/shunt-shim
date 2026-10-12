# Configuration Reference

This document describes configuration schemas, environment variables, edge secrets, and virtual aliases for `shunt-shim`. The Worker service is implemented under [ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md). The broader alias and multi-tenant priority proposals below are deferred beyond the [MVP](MVP.md); no KV binding or quota-accounting configuration is required for the MVP.

## MVP configuration constraints

The [client settings and canonical contract](COMPATIBILITY.md) take precedence over
the broader examples below. Configure one random gateway secret, one fast alias,
Groq primary and Gemini fallback with fixed endpoints and account-verified models.
The GATEWAY_TOKENS secret contains only that one secret for the MVP; its plural name
does not imply tenant support. Direct provider model names are rejected.
Accept either Bearer or x-api-key against the same secret and reject conflicting
headers. Provider keys are independent and never sent to clients.

Select and document body limits, core parameter bounds, approved extension mappings,
connect/total deadlines, and the shared context/output limits. The total deadline
covers both attempts, fits client timeouts, and remains below ingress timeouts.
No paid substitution, second fallback, context router, or reasoning guarantee is
enabled by the MVP configuration. PR-Agent needs an explicit shared context limit
and gateway-only model settings.

## 1. Edge Secrets and Environment Variables

Upstream API keys and edge runtime configurations are managed via Cloudflare Worker bindings.

| Variable Name | Type | Description | Required | Example |
| :--- | :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | Secret | API key for Google AI Studio | Yes | `AIzaSy...` |
| `GROQ_API_KEY` | Secret | API key for Groq Cloud | Yes | `gsk_...` |
| `GATEWAY_TOKENS` | Secret | Gateway authentication secret (single secret for MVP) | Yes | `<one-random-gateway-secret>` |
| `OPENROUTER_API_KEY` | Secret | API key for OpenRouter (deferred beyond MVP) | No | `sk-or-v1-...` |
| `GATEWAY_ENV` | Variable | Runtime environment identifier | No | `production` (default: `development`) |
| `CONTEXT_ROUTER_THRESHOLD` | Variable | Estimated token count that forces large-context routing (deferred beyond MVP) | No | `100000` |

### Secret Management Commands
Secrets must never be committed to source control. Set secrets in production using Wrangler:
```bash
pnpm exec wrangler secret put GEMINI_API_KEY
pnpm exec wrangler secret put GROQ_API_KEY
pnpm exec wrangler secret put GATEWAY_TOKENS
```

For local development, copy `.env.example` to `.dev.vars` (which is excluded by `.gitignore`):
```bash
cp .env.example .dev.vars
```

## 2. Wrangler Configuration (`wrangler.jsonc`)

The implemented Worker deployment configuration:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "shunt-shim",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-01",
  "compatibility_flags": [
    "enable_request_signal"
  ],
  "observability": {
    "enabled": true
  }
}
```

The `enable_request_signal` flag enables downstream client disconnect detection through `Request.signal` in the Workers runtime, allowing the gateway to abort in-flight upstream fetches via `AbortController` when clients close their connection.

## 3. Virtual Model Aliases and Routing Matrix

Client applications should query virtual aliases rather than hardcoded provider models. The router evaluates fallbacks sequentially if the primary route encounters errors or quota exhaustion.

| Virtual Alias | Primary Provider and Model | First Fallback | Second Fallback | Target Use Case |
| :--- | :--- | :--- | :--- | :--- |
| `fast` | Groq (`qwen/qwen3.8-27b`) | Google AI Studio (`gemini-2.5-flash-lite`) | OpenRouter (`meta-llama/llama-3.3-70b-instruct:free`) | Low-latency chat, terminal completions, interactive CLI |
| `deep` | Google AI Studio (`gemini-3.8-flash`) | OpenRouter (`meta-llama/llama-3.3-70b-instruct:free`) | Google AI Studio (`gemini-2.5-flash-lite`) | Large file analysis, repository context, document summarization |
| `reasoning` | OpenRouter (`deepseek/deepseek-r1:free`) | Google AI Studio (`gemini-2.5-pro`) | Groq (`openai/gpt-oss-120b`) | Architectural planning, complex debugging, code generation |

Direct provider model routing is a deferred proposal. The MVP accepts only fast;
an unknown alias returns HTTP 404 without an upstream call. `qwen/qwen3.8-27b` is pinned
as the primary model because it reliably supports all four `tool_choice` variants
(`auto`, `required`, named, and `none`) without upstream failure.

## 4. Deferred Multi-Tenant Project Tokens and Priority Levels

The MVP accepts only one random bearer-token secret configured via `GATEWAY_TOKENS`.
Multi-tenant partitioning and priority levels are deferred beyond the MVP:

| Token Identifier | Priority Tier | Behavior During Low Quota (<10% Remaining) |
| :--- | :--- | :--- |
| `sk-proj-aider` | `interactive` | Always processed. Given first claim on remaining quota. |
| `sk-proj-opencode` | `interactive` | Always processed. Given first claim on remaining quota. |
| `sk-proj-server` | `background` | Paused or diverted to low-priority fallback models when quota drops under 100 RPD. |
| `sk-proj-webhook` | `background` | Degraded to lightweight models (`gemini-2.5-flash-lite` or Workers AI). |
| `sk-proj-default` | `standard` | Normal waterfall routing without priority reservation. |

## 5. Deferred Quota Accounting

The MVP has no shared usage counters, circuit-breaker schema, or quota namespace. Cloudflare KV is eventually consistent and does not support atomic counter updates, so its read-modify-write counters cannot enforce global quotas under concurrency. If strict coordination becomes necessary on Workers, evaluate Durable Objects with transactional storage. See [the accounting decision](ARCHITECTURE.md#deferred-accounting).
