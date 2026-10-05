# Configuration Reference

This document describes proposed configuration schemas, environment variables, edge secrets, and virtual aliases for `shunt-shim`. No gateway configuration is implemented yet. The broader alias and priority proposals below are deferred beyond the [MVP](MVP.md); no KV binding or quota-accounting configuration is required for the MVP.

## 1. Edge Secrets and Environment Variables

Upstream API keys and edge runtime configurations are managed via Cloudflare Worker bindings.

| Variable Name | Type | Description | Required | Example |
| :--- | :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | Secret | API key for Google AI Studio | Yes | `AIzaSy...` |
| `GROQ_API_KEY` | Secret | API key for Groq Cloud | Yes | `gsk_...` |
| `OPENROUTER_API_KEY` | Secret | API key for OpenRouter | Optional | `sk-or-v1-...` |
| `GATEWAY_TOKENS` | Secret | Comma-separated list of valid client bearer tokens | Yes | `sk-proj-aider,sk-proj-server` |
| `GATEWAY_ENV` | Variable | Runtime environment identifier | No | `production` (default: `development`) |
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

The following illustrative sample assumes a TypeScript Worker deployment. It is not a shipped configuration and does not provision quota storage:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "shunt-shim",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "GATEWAY_ENV": "production",
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

## 5. Deferred Quota Accounting

The MVP has no shared usage counters, circuit-breaker schema, or quota namespace. Cloudflare KV is eventually consistent and does not support atomic counter updates, so its read-modify-write counters cannot enforce global quotas under concurrency. If strict coordination becomes necessary on Workers, evaluate Durable Objects with transactional storage. See [the accounting decision](ARCHITECTURE.md#deferred-accounting).
