# Configuration Reference

This document describes configuration schemas, environment variables, edge secrets, and virtual aliases for `shunt-shim`. The Worker service is implemented under [ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md).

## MVP Configuration Constraints

The [client settings and canonical contract](COMPATIBILITY.md) govern the runtime. Configure one random gateway secret, one `fast` alias, Groq primary and Gemini fallback with fixed endpoints and account-verified models.

The `GATEWAY_TOKENS` secret contains only that one secret for the MVP; its plural name does not imply multi-tenant support. Direct provider model names are rejected with HTTP 404 `model_not_found`. Accept either Bearer or `x-api-key` against the same secret and reject conflicting headers. Provider keys are independent and never sent to clients.

The total request deadline covers both attempts, fits client timeouts, and remains below ingress timeouts. No database, KV namespace, multi-tenant token catalog, context router, or paid fallback is enabled by the MVP configuration.

## 1. Edge Secrets and Environment Variables

Upstream API keys and edge runtime configurations are managed via Cloudflare Worker bindings.

| Variable Name | Type | Description | Required | Example |
| :--- | :--- | :--- | :--- | :--- |
| `GEMINI_API_KEY` | Secret | API key for Google AI Studio | Yes | `AIzaSy...` |
| `GROQ_API_KEY` | Secret | API key for Groq Cloud | Yes | `gsk_...` |
| `GATEWAY_TOKENS` | Secret | Gateway authentication secret (single secret for MVP) | Yes | `<one-random-gateway-secret>` |
| `GATEWAY_ENV` | Variable | Runtime environment identifier | No | `production` (default: `development`) |
| `PORT` | Variable | Local development server port | No | `8787` (default: `8787`) |
| `GROQ_BASE_URL` | Variable | Groq API base URL override | No | `https://api.groq.com/openai/v1` |
| `GEMINI_BASE_URL` | Variable | Google AI Studio OpenAI-compatible base URL override | No | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `PRIMARY_MODEL` | Variable | Primary model name (restricted to `ALLOWED_PRIMARY_MODELS`: `qwen/qwen3.8-27b`) | No | `qwen/qwen3.8-27b` |
| `FALLBACK_MODEL` | Variable | Fallback model name (restricted to `ALLOWED_FALLBACK_MODELS`: `gemini-2.5-flash-lite`) | No | `gemini-2.5-flash-lite` |

> [!NOTE]
> `PRIMARY_MODEL` and `FALLBACK_MODEL` are validated against strict environment allowlists (`ALLOWED_PRIMARY_MODELS` and `ALLOWED_FALLBACK_MODELS`). For the MVP, only the verified models (`qwen/qwen3.8-27b` for primary Groq and `gemini-2.5-flash-lite` for fallback Gemini) are permitted. Configuring any other model string causes `validateEnvironment()` to reject the configuration with HTTP 500.

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

Validate configured secrets locally using the task runner:
```bash
just check-secrets
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

The `enable_request_signal` flag enables downstream client disconnect detection through `Request.signal` in the Workers runtime, allowing the gateway to abort in-flight upstream fetches via `AbortController` when clients close their connection. The MVP requires no KV namespace or database bindings.

## 3. Virtual Model Aliases and Routing Matrix

Client applications query virtual aliases rather than hardcoded provider models. The router evaluates fallbacks sequentially if the primary route encounters errors or quota exhaustion.

The MVP accepts exactly one virtual alias: `fast`.

| Virtual Alias | Primary Provider and Model | Fallback Provider and Model | Target Use Case |
| :--- | :--- | :--- | :--- |
| `fast` | Groq (`qwen/qwen3.8-27b`) | Google AI Studio (`gemini-2.5-flash-lite`) | Code review, tool calls, and automated PR analysis |

Direct provider model names and unknown aliases return HTTP 404 `model_not_found` prior to upstream dispatch. Additional aliases (`deep`, `reasoning`) and third-party providers (OpenRouter, Workers AI) are deferred beyond the MVP.

`qwen/qwen3.8-27b` is pinned as the primary model because it reliably supports all four `tool_choice` variants (`auto`, `required`, named, and `none`) without upstream failure. `gemini-2.5-flash-lite` serves as the fallback via Google AI Studio's OpenAI-compatible endpoint.

## 4. Request Bounds and Timeout Limits

The gateway enforces deterministic bounds across all requests:

| Parameter / Bound | Value | Enforcement Behavior |
| :--- | :--- | :--- |
| Inbound Request Body Limit | 10 MB (10,485,760 bytes) | Rejects oversized requests with HTTP 413 `payload_too_large` before JSON parsing. |
| Shared Context Window Ceiling | 128,000 tokens | Requests exceeding combined prompt and completion token limit return HTTP 400 `context_length_exceeded`. |
| Maximum Output Tokens | 8,192 tokens | Supported via `max_tokens` or `max_completion_tokens`. Normalized to single upstream parameter. |
| Upstream Connect Timeout | 5,000 ms (5 seconds) | Per-attempt connection deadline. Reaching 5s on primary triggers fallback. |
| Total Request Deadline | 60,000 ms (60 seconds) | Total wall-clock deadline across all attempts. Expiration returns HTTP 504 `gateway_timeout`. |

## 5. Streaming Request Rejection (Deferred Feature)

Streaming completions (`stream: true`) and stream configuration options (`stream_options`) are deferred to post-MVP. The gateway deterministically rejects streaming requests before upstream dispatch with HTTP 400 Bad Request:

```json
{
  "error": {
    "message": "Streaming is not currently supported in MVP",
    "type": "invalid_request_error",
    "code": "unsupported_parameter",
    "param": "stream"
  }
}
```

Client applications must configure non-streaming completions (`stream: false` or omitted).

## 6. Deferred Multi-Tenant Tokens and Accounting

The MVP accepts only one random bearer-token secret configured via `GATEWAY_TOKENS`. Multi-tenant token catalogs (`sk-proj-*`), priority tiers, context-based model switching, and shared usage counters are deferred beyond the MVP.

No KV namespace or database is provisioned. Upstream HTTP status codes (HTTP 429, HTTP 503) and connection timeouts drive bounded fallback directly.
