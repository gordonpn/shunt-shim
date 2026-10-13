# Architecture and Design

This document details the system architecture, routing mechanics, protocol normalization, and operational decisions of `shunt-shim`.

Status: broader design proposal, not implemented. See [MVP scope](MVP.md) for the initial subset and deployment alternatives. Shared accounting and proactive quota enforcement are deferred; the MVP relies on upstream quota enforcement and bounded fallback.

The [compatibility contract](COMPATIBILITY.md) governs the MVP: DeepSeek Review,
OpenCodeReview, and PR-Agent enter through one handler with two completion paths.
Authenticate one secret via Bearer or x-api-key, validate core fields, retain
extensions, map approved parameters, and dispatch to Groq's OpenAI-compatible
endpoint or Gemini's native Google REST API via a dedicated bidirectional translation
adapter. Normalize JSON metadata and relay SSE/tool/usage events with cancellation.
The topology and tenant/context proposals below are deferred design alternatives.

## 1. System Overview

The MVP presents an OpenAI Chat Completions HTTP interface to three review clients
and dispatches through Groq (OpenAI-compatible REST API) and Google Gemini (native Google REST API).
The runtime and deployment target is agreed as Cloudflare Workers (TypeScript / Hono)
(see [ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md)). The model fallback architecture
and provider adaptation strategy are agreed as an Adaptive Capability Matrix with Dynamic Circuit
Breakers and native Google REST adaptation (see [ADR 0002](adr/0002-model-fallback-and-provider-adaptation-strategy.md));
the extended tenant/context pipeline later in this document is deferred. In extended architectures
beyond the zero-cost MVP, exhausting free allowances can optionally route to a funded
DeepSeek API balance as an emergency safety net to prevent workflow interruption.

```
+-------------------------------------------------------------+
|       DeepSeek Review / OpenCodeReview / PR-Agent            |
+------------------------------+------------------------------+
                               | OpenAI HTTP JSON / SSE
                               v
+-------------------------------------------------------------+
|              Cloudflare Worker (Hono Router)                |
|                                                             |
|  * /v1/models (Virtual alias catalog)                       |
|  * /v1/chat/completions (Request adapter & SSE streaming)   |
|  * /chat/completions (Same handler)                         |
|  * Secret verification via Bearer or x-api-key              |
|  * One fast alias, circuit breaker, bounded fallback        |
+---------------+-----------------------------+---------------+
                |                             |
          OpenAI HTTP / SSE           Native Google REST / SSE
                v                             v
+-------------------------------+ +---------------------------+
|             Groq              | |     Google AI Studio      |
| (Verified free-tier model)    | | (Verified free-tier model)|
+-------------------------------+ +---------------------------+
```

## 2. Platform Selection: Edge Worker vs Local Daemon

Cloudflare Workers (TypeScript / Hono) is selected as the sole deployment and runtime target for the MVP (see [ADR 0001](adr/0001-runtime-target-and-shared-request-bounds.md)). For single-machine isolated development, a compiled Go binary running as a local daemon on `127.0.0.1:8080` was evaluated as an alternative, but edge deployment was selected for zero host maintenance, global HTTPS termination, and direct accessibility from GitHub Actions. See [deployment options](MVP.md#deployment-options).

### Global Quota Synchronization
Free-tier providers enforce account-level constraints shared by all clients. A centralized ingress alone does not guarantee synchronized quota accounting. Cloudflare KV is eventually consistent and lacks atomic read-modify-write operations, so concurrent counter updates can overwrite each other and cannot reliably enforce global quotas. The MVP defers accounting. If strict coordination becomes necessary on Workers, evaluate Durable Objects with transactional storage rather than KV counters. See [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

### Distributed Ingress Without Private Mesh Overlays
Developer environments span laptops, local workstations, remote servers, and CI/CD pipelines. A local daemon on a laptop becomes unavailable the moment the laptop lid closes or disconnects from Wi-Fi. Running a daemon on a private home server requires remote clients to connect through Tailscale, SSH tunnels, or VPN configurations. A Cloudflare Worker exposes a public HTTPS endpoint (`https://api.yourdomain.com/v1`) accessible securely from any environment without mesh infrastructure.

### Multi-Tenant Virtual Tokens and Priority Degradation (Deferred)
In extended proposals beyond the MVP, an edge worker could inspect custom bearer tokens (such as `sk-proj-aider` or `sk-proj-webhook`) to partition usage and prioritize interactive traffic. The MVP defers multi-tenant tokens and accepts only one random gateway secret.

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

### Stage 4: Waterfall Fallback and Circuit Breaker Execution
The gateway applies an Adaptive Capability Matrix bounded by Dynamic Circuit Breakers
(see [ADR 0002](adr/0002-model-fallback-and-provider-adaptation-strategy.md)). Candidate models are
filtered by requested capabilities (tools, JSON response format, context ceiling) before evaluating
health state (in MVP, context filtering validates against the shared 128k context ceiling using the
conservative token density heuristic). In isolate-local memory, endpoints track `Healthy`, `Open`
(cooling down), and `Half-Open` (canary test) states. Eligible fallback triggers before downstream response
commitment are strictly: HTTP 429, HTTP 503, connect failure / 5s connect timeout, and 60s Attempt 1
execution timeout (if remaining total gateway deadline permits). HTTP 500, 502, and non-retryable 4xx
errors are ineligible. If an eligible failure occurs, the primary circuit trips for the normalized
cooldown window (or bounded exponential backoff with jitter if headers are absent) and execution cascades
to the next eligible healthy candidate (Gemini). During concurrent failure bursts, cascading requests
evaluate the fallback endpoint's health and rate limits; if the fallback is also tripped, the gateway
returns the primary error immediately rather than flooding the backup. If Attempt 1 times out at 60s,
the upstream fetch aborts immediately via linked abort signals; any uncancelled inference accepted
upstream before abort propagation is recognized as an accepted trade-off to deliver client completions.
Do not replay a request once streaming starts or conceal validation and credential errors behind fallback.
If no eligible provider succeeds, return an explicit error. In extended post-MVP routing, exhausting
free-tier candidates can optionally trigger a final fallback to a paid DeepSeek account balance before
returning an error to the client.

### Stage 5: Protocol Normalization
Groq uses native OpenAI-compatible pass-through. Google Gemini uses a dedicated bidirectional adapter
translating between OpenAI Chat Completions payloads and the native Google REST API (`:generateContent` and
`:streamGenerateContent?alt=sse`). Preserve completion IDs, string text, tool IDs and JSON-string arguments,
finish reasons, usage, and optional reasoning metadata. Relay incremental SSE including indexed tool deltas
and final usage events. Never append a successful terminator to an incomplete upstream stream.

### Deferred Accounting
The MVP does not maintain provider daily counters, minute counters, or project usage counters. Do not
provision KV for quota enforcement. Best-effort isolate-local memory provides zero-latency cooldown tracking
for initial iterations. If strict cross-instance coordination is later required, evaluate Cloudflare KV or
coordinating Durable Objects; this is not part of the initial request pipeline.

## 4. Upstream Quota Enforcement

Providers remain the source of truth for their account-specific limits:

| Provider | Quota Type | Strategy |
| :--- | :--- | :--- |
| Google AI Studio | Account- and model-specific request and token limits | Native REST adapter; trip circuit breaker on HTTP 429 and return explicit error if exhausted |
| Groq | Account- and model-specific rolling request and token limits | OpenAI REST adapter; trip circuit breaker on HTTP 429 and attempt Gemini fallback before commitment |
| OpenRouter (:free) | Shared free-model capacity and account limits | Deferred beyond the MVP |
| DeepSeek (API balance) | Prepaid token balance | Optional emergency fallback when all free-tier quotas are exhausted (deferred beyond MVP) |

### Circuit Breaker State Management
Initial iterations implement best-effort isolate-local circuit breakers with timestamp-based single-probe
canary gates (see [ADR 0002](adr/0002-model-fallback-and-provider-adaptation-strategy.md)). Cooldown
timestamps are stored in epoch milliseconds (`cooldown_until: number`). In the `Half-Open` state, when
`cooldown_until <= Date.now()`, the first arriving request atomically claims the probe slot (`probing = true`).
Concurrent requests arriving while a probe is in flight observe `probing === true` and treat the circuit
as `Open`, bypassing directly to fallback. Circuit transitions track an integer `generation` counter so
that only a probe matching the active generation can transition the circuit to `Healthy` and clear `probing`;
earlier in-flight successes cannot clear a newer cooldown opened by a subsequent request. If the canary probe
fails, the circuit returns to `Open`, calculates an incremented backoff cooldown, and clears `probing`.
Rate limit headers (`Retry-After`, `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`) are normalized
into a unified `cooldown_until` timestamp in epoch milliseconds by taking the latest (maximum) reported
reset deadline. For HTTP 429 without headers, HTTP 503, connect timeouts, and execution timeouts, bounded
exponential backoff with jitter (`min(300, 2^attempt * 5) +/- jitter` in seconds, stored as epoch milliseconds)
is enforced. Distributed KV or Durable Object state management is evaluated as a post-MVP evolutionary path.

## 5. Schema Normalization Details

### Provider Adaptation
- **Groq**: Direct OpenAI Chat Completions REST API pass-through with field validation.
- **Google Gemini**: Dedicated bidirectional translation adapter converting OpenAI request bodies into
  native Google REST content objects (`contents`, `generationConfig`, `tools`, `functionDeclarations`,
  `systemInstruction`, and `toolConfig.functionCallingConfig`), and streaming response chunks back into
  OpenAI-compatible SSE events.
  - **System Instructions**: OpenAI messages with role `system` do not map to `contents` (which accepts only
    `user` and `model` roles), but map directly to Gemini's top-level `systemInstruction` field
    (`{ parts: [{ text: ... }] }`).
  - **Tool Choice Mapping**: Translate OpenAI `tool_choice` into Gemini's `toolConfig.functionCallingConfig`:
    `"auto"` maps to `mode: "AUTO"`; `"none"` maps to `mode: "NONE"`; `"required"` maps to `mode: "ANY"`;
    and named tool choices (`{"type": "function", "function": {"name": "xyz"}}`) map to `mode: "ANY"` with
    `allowedFunctionNames: ["xyz"]`. Omitted or default `tool_choice` maps to `mode: "AUTO"`.
Map `max_tokens`/`max_completion_tokens` to the selected upstream's verified output-limit field. Extension
mappings are explicit per provider; unknown extras are ignored without overriding model, auth, or endpoint.
Preserve tool history and provider-required tool metadata through approved mappings. Anthropic adapters
and a general multi-provider intermediate representation remain deferred.
