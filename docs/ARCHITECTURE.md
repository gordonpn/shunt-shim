# Architecture and Design

This document details the system architecture, routing mechanics, protocol normalization, and operational decisions of `shunt-shim`.

## 1. System Overview

`shunt-shim` is a lightweight, edge-hosted API gateway and intelligent routing shim for free-tier large language model (LLM) allowances. It presents an OpenAI-compatible HTTP interface (`/v1/chat/completions` and `/v1/models`) to client tools while multiplexing upstream calls across Google AI Studio, Groq, OpenRouter, and Cloudflare Workers AI.

```
+-------------------------------------------------------------+
|    Client Tooling (Aider, OpenCode, Continue, Raycast)      |
+------------------------------+------------------------------+
                               | Standard OpenAI JSON-RPC / SSE
                               v
+-------------------------------------------------------------+
|              Cloudflare Worker Gateway (Edge)               |
|                                                             |
|  * /v1/models (Virtual alias catalog)                       |
|  * /v1/chat/completions (Request adapter and SSE streaming) |
|  * Bearer token authentication and project tenant tags      |
|  * Centralized quota tracking and sliding windows via KV    |
|  * Payload-aware context size routing                       |
|  * Deterministic fallback waterfalls                        |
+---------------+-----------------------------+---------------+
                |                             |
     Native REST (Gemini format)              | OpenAI REST / SSE
                v                             v
+-------------------------------+ +---------------------------+
|       Google AI Studio        | |    Groq / OpenRouter      |
| (Gemini 2.5/3.8 Flash, 1M ctx)| | (Llama 3.3 70B, DeepSeek) |
+-------------------------------+ +---------------------------+
```

## 2. Platform Selection: Edge Worker vs Local Daemon

For single-machine isolated development, a compiled Go binary running as a local daemon on `127.0.0.1:8080` provides high speed and low memory usage. However, when multiple projects or distributed nodes share the same upstream free allowances, a Cloudflare Worker at the edge is the superior architecture.

### Global Quota Synchronization
Free-tier providers enforce strict account-level constraints (for example, Google AI Studio's 1,000 requests per day or Groq's sliding per-minute token buckets). Multiple disconnected local daemons cannot coordinate usage. If a background ingestion job running on a home server consumes 400 requests, an interactive terminal session on a laptop will encounter an uncoordinated HTTP 429 error. An edge worker centralizes request accounting in Cloudflare KV, coordinating quotas across all clients.

### Distributed Ingress Without Private Mesh Overlays
Developer environments span laptops, local workstations, remote servers, and CI/CD pipelines. A local daemon on a laptop becomes unavailable the moment the laptop lid closes or disconnects from Wi-Fi. Running a daemon on a private home server requires remote clients to connect through Tailscale, SSH tunnels, or VPN configurations. A Cloudflare Worker exposes a public HTTPS endpoint (`https://api.yourdomain.com/v1`) accessible securely from any environment without mesh infrastructure.

### Multi-Tenant Virtual Tokens and Priority Degradation
An edge worker inspects custom bearer tokens (such as `sk-proj-aider` or `sk-proj-webhook`) to partition usage. When available quotas drop below defined thresholds (such as 10% daily quota remaining), the worker can degrade or pause non-critical background jobs while reserving remaining capacity for interactive coding sessions.

### Zero Host Maintenance
Cloudflare Workers run in V8 isolates with sub-millisecond cold starts, zero idle resource consumption, and no operating system dependencies or systemd daemons to maintain. Cloudflare's free tier provides 100,000 requests per day, which comfortably exceeds the combined daily allocations of upstream free model providers.

## 3. Request Pipeline Lifecycle

Each incoming request proceeds through sequential, deterministic stages:

```
[Inbound Request]
       |
       v
1. Bearer Token Auth ----------> [Reject 401 if token invalid]
       |
       v
2. Tenant & Priority Resolution
       |
       v
3. Payload Inspection ---------> [Estimate prompt token count]
       |
       v
4. Model Alias & Waterfall ----> [Map virtual alias to provider ladder]
       |
       v
5. KV Quota & Circuit Check ---> [Check sliding RPM and daily RPD]
       |
       v
6. Protocol Transformation ----> [Convert OpenAI schema to upstream format]
       |
       v
7. Upstream Dispatch ----------> [Execute HTTP request]
       |
       +--> [On 429 / 5xx / Quota Exceeded] -> Advance to next waterfall step
       |
       v
8. Response Normalization -----> [Normalize SSE stream or JSON body to OpenAI]
       |
       v
9. KV Accounting --------------> [Increment daily and minute usage counters]
       |
       v
[Client Response]
```

### Stage 1: Authentication and Tenant Resolution
The worker extracts the HTTP `Authorization: Bearer <token>` header and verifies it against the configured project token catalog. Requests with invalid or missing tokens are rejected immediately with HTTP 401. Valid tokens identify the caller for priority classification and rate limiting.

### Stage 2: Payload Inspection and Context Routing
The worker inspects the `messages` array in the request body to estimate prompt token volume. For queries exceeding 100,000 tokens, the router bypasses models with smaller context limits (such as Groq's 128,000-token ceiling) and directs the payload directly to models supporting large context windows (such as Google Gemini Flash with 1,000,000 tokens).

### Stage 3: Virtual Model Aliasing
Clients request semantic aliases instead of brittle provider-specific model strings:
- `fast`: Low-latency interactive tasks (default: Groq Llama 3.3 70B; fallback: Google Gemini Flash-Lite).
- `deep`: High-context analysis and long documents (default: Google Gemini Flash; fallback: OpenRouter :free).
- `reasoning`: Complex logic and code generation (default: OpenRouter DeepSeek R1 :free; fallback: Google Gemini Pro).

### Stage 4: Waterfall Fallback Execution
If the primary provider returns an HTTP 429 (rate limited), HTTP 503 (service unavailable), or if the pre-flight KV check indicates an exhausted daily quota, the worker immediately dispatches the request to the next provider in the alias waterfall ladder without returning an error to the client.

### Stage 5: Protocol Normalization
Upstream responses are normalized to OpenAI specifications before returning to the client:
- Non-streaming responses return standard `chat.completion` JSON payloads.
- Streaming responses parse upstream Server-Sent Events (SSE) chunks, convert native text deltas into standard `data: {"choices":[{"delta":{"content":"..."}}]}` envelopes, and append the terminal `data: [DONE]` event.

### Stage 6: Centralized KV Accounting
Upon successful dispatch, the worker updates the shared Cloudflare KV store:
- Increments the provider daily counter (`usage:YYYY-MM-DD:<provider>`).
- Increments the sliding minute counter (`usage:YYYY-MM-DD-HH-MM:<provider>`).
- Updates project-specific consumption metrics (`tenant:<token_id>:usage`).

## 4. Quota Mechanics and Circuit Breaking

Upstream free tiers fall into two distinct quota patterns:

| Provider | Quota Type | Reset Mechanism | Circuit Breaker Strategy |
| :--- | :--- | :--- | :--- |
| Google AI Studio | Fixed Daily Volume | Resets at 00:00 UTC | Track daily counts in KV. Divert traffic when count reaches 980 of 1,000 RPD to preserve headroom. |
| Groq | Sliding Rate Window | Rolling per-minute buckets | Track minute window in KV. Divert when requests exceed 25 RPM or when an HTTP 429 is received. |
| OpenRouter (:free) | Community Pool | Capacity and load dependent | Fast-fail on HTTP 429 or queue timeouts exceeding 10 seconds. |

### Circuit Breaker States
Each upstream provider has a dynamic state maintained in KV:
- `HEALTHY`: Normal routing active.
- `THROTTLED`: Sliding rate limit reached. Re-evaluated every 60 seconds.
- `EXHAUSTED`: Daily quota depleted. Locked until 00:00 UTC.

## 5. Schema Normalization Details

### OpenAI to Google AI Studio (Gemini REST)
Google AI Studio requires a distinct structure from the standard OpenAI message schema:
- OpenAI `system` messages are extracted and mapped to `systemInstruction.parts[].text`.
- OpenAI `user` and `assistant` messages are mapped to `contents[].role` (`user` or `model`) and `contents[].parts[].text`.
- Temperature, top-p, and max tokens are mapped into `generationConfig`.

### Streaming SSE Chunk Transformation
When streaming is requested (`"stream": true`), Gemini returns chunks formatted as `data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}`. The worker extracts the incremental text and repackages it into the OpenAI chunk schema:
```json
data: {"id":"chatcmpl-edge","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"..."},"finish_reason":null}]}
```
When the stream completes, the worker emits the terminal completion event followed by `data: [DONE]`.
