# Configuration Reference

This document describes configuration schemas, environment variables, edge secrets, virtual aliases, and Cloudflare KV bindings for `shunt-shim`.

## 1. Edge Secrets and Environment Variables

Upstream API keys and edge runtime configurations are managed via Cloudflare Worker bindings.

| Variable Name | Type | Description | Required | Example |
| :--- | :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | Secret | API key for Google AI Studio | Yes | `AIzaSy...` |
| `GROQ_API_KEY` | Secret | API key for Groq Cloud | Yes | `gsk_...` |
| `OPENROUTER_API_KEY` | Secret | API key for OpenRouter | Optional | `sk-or-v1-...` |
| `GATEWAY_TOKENS` | Secret | Comma-separated list of valid client bearer tokens | Yes | `sk-proj-aider,sk-proj-server` |
| `GATEWAY_ENV` | Variable | Runtime environment identifier | No | `production` (default: `development`) |
| `RATE_LIMIT_GROQ_RPM` | Variable | Maximum requests per minute before Groq circuit trips | No | `25` (default: `25`) |
| `DAILY_LIMIT_GEMINI_RPD` | Variable | Maximum requests per day before Gemini circuit trips | No | `980` (default: `980`) |
| `CONTEXT_ROUTER_THRESHOLD` | Variable | Estimated token count that forces large-context routing | No | `100000` (default: `100000`) |

### Secret Management Commands
Secrets must never be committed to source control. Set secrets in production using Wrangler:
```bash
bunx wrangler secret put GEMINI_API_KEY
bunx wrangler secret put GROQ_API_KEY
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler secret put GATEWAY_TOKENS
```

For local development, copy `.env.example` to `.dev.vars` (which is excluded by `.gitignore`):
```bash
cp .env.example .dev.vars
```

## 2. Wrangler Configuration (`wrangler.jsonc`)

The following sample illustrates the required bindings, compatibility settings, and KV namespace mappings:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "shunt-shim",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "kv_namespaces": [
    {
      "binding": "SHIMS_KV",
      "id": "production_kv_namespace_id",
      "preview_id": "preview_kv_namespace_id"
    }
  ],
  "vars": {
    "GATEWAY_ENV": "production",
    "RATE_LIMIT_GROQ_RPM": "25",
    "DAILY_LIMIT_GEMINI_RPD": "980",
    "CONTEXT_ROUTER_THRESHOLD": "100000"
  }
}
```

## 3. Virtual Model Aliases and Routing Matrix

Client applications should query virtual aliases rather than hardcoded provider models. The router evaluates fallbacks sequentially if the primary route encounters errors or quota exhaustion.

| Virtual Alias | Primary Provider and Model | First Fallback | Second Fallback | Target Use Case |
| :--- | :--- | :--- | :--- | :--- |
| `fast` | Groq (`llama-3.3-70b-versatile`) | Google AI Studio (`gemini-2.5-flash-lite`) | OpenRouter (`meta-llama/llama-3.3-70b-instruct:free`) | Low-latency chat, terminal completions, interactive CLI |
| `deep` | Google AI Studio (`gemini-2.5-flash`) | OpenRouter (`meta-llama/llama-3.3-70b-instruct:free`) | Google AI Studio (`gemini-2.5-flash-lite`) | Large file analysis, repository context, document summarization |
| `reasoning` | OpenRouter (`deepseek/deepseek-r1:free`) | Google AI Studio (`gemini-2.5-pro`) | Groq (`llama-3.3-70b-versatile`) | Architectural planning, complex debugging, code generation |

Direct provider model names can also be passed verbatim. When an explicit model name is passed (for example, `gemini-2.5-flash`), the router skips alias expansion and routes directly to that model.

## 4. Multi-Tenant Project Tokens and Priority Levels

Tokens passed in the HTTP `Authorization: Bearer <token>` header partition usage and assign execution priority:

| Token Identifier | Priority Tier | Behavior During Low Quota (<10% Remaining) |
| :--- | :--- | :--- |
| `sk-proj-aider` | `interactive` | Always processed. Given first claim on remaining quota. |
| `sk-proj-opencode` | `interactive` | Always processed. Given first claim on remaining quota. |
| `sk-proj-server` | `background` | Paused or diverted to low-priority fallback models when quota drops under 100 RPD. |
| `sk-proj-webhook` | `background` | Degraded to lightweight models (`gemini-2.5-flash-lite` or Workers AI). |
| `sk-proj-default` | `standard` | Normal waterfall routing without priority reservation. |

## 5. Cloudflare KV Key Schema

The `SHIMS_KV` namespace stores usage counters and circuit breaker state:

| Key Pattern | Value Type | TTL | Description |
| :--- | :--- | :--- | :--- |
| `usage:daily:<provider>:YYYY-MM-DD` | Integer string | 172,800 seconds (2 days) | Daily cumulative request count for provider |
| `usage:minute:<provider>:YYYY-MM-DD-HH-MM` | Integer string | 300 seconds (5 minutes) | Sliding minute request count for provider |
| `breaker:<provider>` | JSON object | Variable (cooldown window) | Provider health state (`HEALTHY`, `THROTTLED`, `EXHAUSTED`) |
| `tenant:daily:<token_id>:YYYY-MM-DD` | Integer string | 172,800 seconds (2 days) | Daily consumption per tenant token |

### Circuit Breaker JSON Schema
```json
{
  "status": "THROTTLED",
  "reason": "HTTP 429 received from upstream",
  "tripped_at": 1759665600,
  "cooldown_until": 1759665660
}
```
