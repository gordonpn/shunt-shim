# Architecture and Design

This document details the system architecture, routing mechanics, protocol normalization, and operational decisions of `shunt-shim`. The Worker service is implemented under [ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md) and [ADR 0002](adr/0002-model-fallback-and-provider-adaptation-strategy.md).

The [compatibility contract](COMPATIBILITY.md) governs the MVP: DeepSeek Review, OpenCodeReview, and PR-Agent enter through one handler with two completion paths. The gateway authenticates one secret via Bearer or `x-api-key`, validates core fields, enforces request bounds, rejects streaming requests with HTTP 400, and dispatches to Groq's OpenAI-compatible endpoint with Google AI Studio's OpenAI-compatible endpoint as fallback.

## 1. System Overview

The MVP presents an OpenAI Chat Completions HTTP interface to client applications and dispatches requests through Groq (`https://api.groq.com/openai/v1/chat/completions`) and Google AI Studio (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`). Cloudflare Workers (TypeScript / Hono) is the sole runtime and deployment target.

```
+-------------------------------------------------------------+
|       DeepSeek Review / OpenCodeReview / PR-Agent           |
+------------------------------+------------------------------+
                               | OpenAI HTTP JSON
                               v
+-------------------------------------------------------------+
|              Cloudflare Worker (Hono Router)                |
|                                                             |
|  * GET  /v1/models (Catalog returning fast alias)           |
|  * POST /v1/chat/completions (Validation & dispatch)        |
|  * POST /chat/completions (Same handler)                    |
|  * Secret verification via Bearer or x-api-key              |
|  * Non-streaming JSON responses (streaming rejected 400)    |
|  * One fast alias, bounded 1-attempt fallback               |
+---------------+-----------------------------+---------------+
                |                             |
          OpenAI HTTP                   OpenAI HTTP
                v                             v
+-------------------------------+ +---------------------------+
|             Groq              | |     Google AI Studio      |
|   Primary: qwen/qwen3.8-27b   | |Fallback: gemini-2.5-flash |
+-------------------------------+ +---------------------------+
```

## 2. Platform Selection: Edge Worker vs Local Daemon

Cloudflare Workers (TypeScript / Hono) is selected as the sole deployment and runtime target for the MVP (see [ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md)). Edge deployment provides zero host maintenance, global HTTPS termination, and direct accessibility from GitHub Actions runners and CI environments without network mesh or tunnel dependencies.

### Global Quota Synchronization
Free-tier providers enforce account-level constraints. A centralized ingress alone does not guarantee synchronized quota accounting. Cloudflare KV is eventually consistent and lacks atomic read-modify-write operations, so concurrent counter updates can overwrite each other and cannot reliably enforce global quotas under concurrency. The MVP defers accounting and requires no KV namespace or database. Upstream provider responses (HTTP 429, HTTP 503) and connection timeouts drive bounded fallback directly.

### Distributed Ingress Without Private Mesh Overlays
Developer environments span laptops, workstations, and CI/CD pipelines. A Cloudflare Worker exposes a public HTTPS endpoint accessible securely from any environment without Tailscale, SSH tunnels, or VPN configurations.

### Zero Host Maintenance
Cloudflare Workers run in V8 isolates with sub-millisecond cold starts, zero idle resource consumption, and no operating system dependencies to maintain. Cloudflare's free tier provides 100,000 requests per day, comfortably exceeding upstream free allocations.

## 3. Request Pipeline Lifecycle

The request pipeline runs the following validation and routing steps:

```
[Inbound Request]
       |
       v
1. Path & Method Check --------> [404 if unknown path, 405 if method unsupported]
       |
       v
2. Request ID Correlation -----> [Extract or generate x-request-id]
       |
       v
3. Bearer/API Key Auth --------> [401 if token missing or invalid]
       |
       v
4. Body Size Enforcement ------> [413 if body > 10 MB]
       |
       v
5. Streaming Guard ------------> [400 unsupported_parameter if stream: true]
       |
       v
6. Schema & Model Validation --> [400 if malformed, 404 if model != fast, 400 if tokens > 128k]
       |
       v
7. Primary Dispatch (Groq) ----> [Attempt primary qwen/qwen3.8-27b with 5s connect timeout]
       |
       +--> [On 429 / 503 / Timeout / Network Error] -> Fallback to Gemini (gemini-2.5-flash-lite)
       |
       v
8. Response Normalization -----> [Normalize JSON body and extract usage/tools]
       |
       v
9. Diagnostic Emission --------> [Log allowlisted metadata: requestId, status, latency, provider]
       |
       v
[Client Response]
```

### Stage 1: Path and Method Verification
Incoming HTTP requests are routed through Hono. Supported routes are `GET /v1/models`, `POST /v1/chat/completions`, and `POST /chat/completions`. Unmatched paths return HTTP 404. Matched routes with unsupported methods return HTTP 405 with an `Allow` header.

### Stage 2: Correlation and Diagnostics Middleware
The `diagnosticsMiddleware` captures request timing, extracts an existing `x-request-id` header or generates a UUID, attaches it to the response header, and emits a structured JSON diagnostic event upon completion adhering to the safe allowlist.

### Stage 3: Authentication
The gateway validates credentials from either `Authorization: Bearer <token>` or `x-api-key: <token>`. Both headers must match the single random secret in `GATEWAY_TOKENS`. If both headers are supplied, they must match each other. Missing, empty, or invalid tokens return HTTP 401 Unauthorized. Provider keys are never sent to clients.

### Stage 4: Body Size Limit
Requests are read with a 10 MB limit (`10,485,760` bytes). Payloads exceeding this ceiling return HTTP 413 `payload_too_large` before JSON parsing.

### Stage 5: Streaming Guard
Streaming completions are deferred beyond the MVP. If the parsed request body contains `"stream": true` or `"stream_options"`, the gateway returns HTTP 400 Bad Request with code `unsupported_parameter` and param `stream`.

### Stage 6: Schema and Model Validation
The request must contain a non-empty `messages` array with valid roles (`system`, `user`, `assistant`, `tool`). Assistant messages with tool calls and tool responses with matching `tool_call_id` are validated. Unknown model strings return HTTP 404 `model_not_found`; only `fast` is accepted. Requests exceeding the 128,000-token context ceiling return HTTP 400 `context_length_exceeded`.

### Stage 7: Upstream Dispatch and Bounded Fallback
- **Attempt 1 (Primary):** Dispatches to Groq `qwen/qwen3.8-27b` using `https://api.groq.com/openai/v1/chat/completions`. A 5s connection timeout aborts stagnant handshakes.
- **Eligible Failures:** Upstream HTTP 429 (rate limit), HTTP 503 (service unavailable), connection timeout, or network fetch failure trigger fallback.
- **Attempt 2 (Fallback):** Dispatches to Google AI Studio `gemini-2.5-flash-lite` using `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`.
- **Wall-Clock Deadline:** The gateway enforces a strict 60s total request deadline across all attempts. If the deadline expires, in-flight fetches are aborted immediately, returning HTTP 504 `gateway_timeout`.
- **Pre-dispatch Rejections:** Pre-dispatch failures (HTTP 400, 401, 404, 405, 413) omit provider and model metadata rather than fabricating uncontacted provider names.

### Stage 8: Protocol Normalization
Both Groq and Google AI Studio provide standard OpenAI-compatible `/chat/completions` endpoints. Upstream JSON responses are parsed, validated, and normalized to ensure required completion IDs, created timestamps, choices, tool call arguments, finish reasons, and usage objects are well-formed before returning to the client.

## 4. Upstream Provider Selection

The MVP focuses on two high-capacity free-tier providers:

| Provider | Model | Quota Limits | Role |
| :--- | :--- | :--- | :--- |
| Groq | `qwen/qwen3.8-27b` | 1,000 RPD, 30 RPM, 8,000 TPM | Primary Route |
| Google AI Studio | `gemini-2.5-flash-lite` | 1,000 RPD, 15 RPM | Fallback Route |

`qwen/qwen3.8-27b` is pinned because it provides low-latency execution and reliably supports all four tool choice modes (`auto`, `required`, named, `none`) without upstream failure. `gemini-2.5-flash-lite` provides generous free token allowances and a massive context window as an automated backup.

## 5. Deferred Capabilities

The following proposals are deferred beyond the MVP:
- **Streaming Responses (SSE):** Incremental SSE relay is deferred to post-MVP. Requests specifying `stream: true` return HTTP 400.
- **Additional Aliases:** `deep` and `reasoning` virtual aliases are deferred.
- **Third-Party Providers:** OpenRouter, Cloudflare Workers AI, and Vercel AI Gateway are deferred.
- **Multi-Tenant Catalogs & Priority Tiers:** No multi-tenant token IDs (`sk-proj-*`) or background priority degradation are implemented.
- **Quota Storage:** No Cloudflare KV namespaces, Durable Objects, or external databases are used.
