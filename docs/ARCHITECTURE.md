# Architecture and Design

This document details the system architecture, routing mechanics, protocol normalization, and operational decisions of `shunt-shim`.

Status: broader design proposal, not implemented. See [MVP scope](MVP.md) for the initial subset and deployment alternatives. Shared accounting and proactive quota enforcement are deferred; the MVP relies on upstream quota enforcement and bounded fallback.

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

For single-machine isolated development, a compiled Go binary running as a local daemon on `127.0.0.1:8080` is one option. A Cloudflare Worker is an alternative for managed public ingress. Language and deployment platform remain undecided; see [deployment options](MVP.md#deployment-options).

### Global Quota Synchronization
Free-tier providers enforce account-level constraints shared by all clients. A centralized ingress alone does not guarantee synchronized quota accounting. Cloudflare KV is eventually consistent and lacks atomic read-modify-write operations, so concurrent counter updates can overwrite each other and cannot reliably enforce global quotas. The MVP defers accounting. If strict coordination becomes necessary on Workers, evaluate Durable Objects with transactional storage rather than KV counters. See [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

### Distributed Ingress Without Private Mesh Overlays
Developer environments span laptops, local workstations, remote servers, and CI/CD pipelines. A local daemon on a laptop becomes unavailable the moment the laptop lid closes or disconnects from Wi-Fi. Running a daemon on a private home server requires remote clients to connect through Tailscale, SSH tunnels, or VPN configurations. A Cloudflare Worker exposes a public HTTPS endpoint (`https://api.yourdomain.com/v1`) accessible securely from any environment without mesh infrastructure.

### Multi-Tenant Virtual Tokens and Priority Degradation
An edge worker inspects custom bearer tokens (such as `sk-proj-aider` or `sk-proj-webhook`) to partition usage. When available quotas drop below defined thresholds (such as 10% daily quota remaining), the worker can degrade or pause non-critical background jobs while reserving remaining capacity for interactive coding sessions.

### Zero Host Maintenance
Cloudflare Workers run in V8 isolates with sub-millisecond cold starts, zero idle resource consumption, and no operating system dependencies or systemd daemons to maintain. Cloudflare's free tier provides 100,000 requests per day, which comfortably exceeds the combined daily allocations of upstream free model providers.

## 3. Request Pipeline Lifecycle

The broader proposed pipeline includes tenant and context routing, both deferred beyond the MVP. Neither the MVP nor this pipeline requires KV quota checks or accounting:

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
5. Protocol Transformation ----> [Convert OpenAI schema to upstream format]
       |
       v
6. Upstream Dispatch ----------> [Execute HTTP request]
       |
       +--> [On 429 / 503 / Connection Timeout] -> Try fallback before response commitment
       |
       v
7. Response Normalization -----> [Normalize SSE stream or JSON body to OpenAI]
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
If the primary provider returns HTTP 429 (rate limited), HTTP 503 (service unavailable), or a connection timeout before response commitment, the MVP attempts its one eligible fallback. Do not replay a request once streaming starts or conceal validation and credential errors behind fallback. If no eligible provider succeeds, return an explicit error; there is no pre-flight quota check.

### Stage 5: Protocol Normalization
Upstream responses are normalized to OpenAI specifications before returning to the client:
- Non-streaming responses return standard `chat.completion` JSON payloads.
- Streaming responses parse upstream Server-Sent Events (SSE) chunks, convert native text deltas into standard `data: {"choices":[{"delta":{"content":"..."}}]}` envelopes, and append the terminal `data: [DONE]` event.

### Deferred Accounting
The MVP does not maintain provider daily counters, minute counters, or project usage counters. Do not provision KV for quota enforcement. If strict coordination is later required, design atomic quota reservations and updates through a coordinating Durable Object; this is not part of the current request pipeline.

## 4. Upstream Quota Enforcement

Providers remain the source of truth for their account-specific limits:

| Provider | Quota Type | MVP Strategy |
| :--- | :--- | :--- |
| Google AI Studio | Account- and model-specific request and token limits | Handle upstream HTTP 429; return an explicit error if no eligible provider succeeds |
| Groq | Account- and model-specific rolling request and token limits | Attempt the Gemini fallback on upstream HTTP 429 before response commitment |
| OpenRouter (:free) | Shared free-model capacity and account limits | Deferred beyond the MVP |

### Deferred Circuit Breaking
No shared circuit-breaker state or locally predicted reset schedule is implemented or required for the MVP. Add coordinated accounting or circuit breaking only after actual usage demonstrates a need.

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
