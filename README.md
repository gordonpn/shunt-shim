# shunt-shim

Status: design proposal, not yet implemented. See [the proposed MVP and deployment options](docs/MVP.md) for the initial scope, acceptance criteria, and language/platform trade-offs. The capabilities and setup instructions below describe the broader planned design.

`shunt-shim` is a lightweight, edge-hosted OpenAI-compatible routing shim and quota-aware reverse proxy for always-free large language model (LLM) tiers. It multiplexes free developer allocations from Google AI Studio, Groq, OpenRouter, and Cloudflare Workers AI behind a unified `/v1/chat/completions` API endpoint.

Client tooling such as Aider, OpenCode, Continue, Raycast, and official OpenAI SDKs connect using standard `OPENAI_BASE_URL` and `OPENAI_API_KEY` configurations, while `shunt-shim` manages semantic aliases, context window routing, rate-limit waterfalls, and edge-coordinated quota tracking.

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

## Key Capabilities

- Drop-in OpenAI Compatibility: Exposes `/v1/chat/completions` and `/v1/models` supporting both non-streaming JSON and Server-Sent Events (SSE) streaming chunks.
- Semantic Model Aliasing: Route via functional aliases (`fast`, `deep`, `reasoning`) rather than fragile provider model identifiers.
- Global Quota Synchronization: Coordinates sliding rate limits (Groq RPM/TPM) and calendar-day limits (Google AI Studio 1,000 RPD) across all your machines via Cloudflare KV.
- Context-Aware Routing: Inspects payload size to direct short queries to ultra-low-latency LPU inference (Groq) and large repository dumps (>100k tokens) to 1M-token context models (Google Gemini Flash).
- Deterministic Fallback Waterfalls: Automatically diverts traffic upon encountering HTTP 429 status codes or nearing daily limits without failing downstream client requests.
- Multi-Tenant Virtual Tokens: Issues virtual project tokens (such as `sk-proj-aider` and `sk-proj-server`) with priority tiers so background batch jobs never starve interactive developer workflows.
- Zero Host Maintenance: Deploys as a Cloudflare Worker running in V8 isolates with zero idle memory usage, sub-millisecond cold starts, and zero operating system maintenance.

## Free-Tier Provider Summary

| Provider | Top Models | Free Quotas | Context | Primary Strength | Constraints |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Google AI Studio | Gemini 2.5 / 3.8 Flash, Flash-Lite, Pro | 1,000 RPD (Flash-Lite), 250-500 RPD (Flash) | 1,000,000 tokens | Massive token context, multimodal inputs | Quotas reset at 00:00 UTC; free tier prompts subject to model training |
| Groq | Llama 3.3 70B, Llama 3.1 8B | 14,400 RPD (8B), ~1,000 RPD (70B), ~30 RPM | 128,000 tokens | Ultra-low latency (250-300+ tok/s on 70B) | Enforces strict rolling per-minute token buckets (TPM) |
| OpenRouter (:free) | DeepSeek R1, Llama 3.3 70B, Qwen 2.5 72B | ~20 RPM, ~200 RPD | Up to 128k-1M tokens | Unified catalog for open-weight frontier models | Shared public capacity subject to queue latency |
| Cloudflare Workers AI | Llama 3.3 70B, Mistral 7B, DeepSeek Distill | 10,000 Neurons/day (~1,000 queries) | 8k-128k tokens | Native edge invocation without credential management | Lower context windows |

For a comprehensive catalog of always-free compute, storage, edge networks, and LLMs, consult [docs/FREE_TIERS.md](docs/FREE_TIERS.md).

## Quickstart

### 1. Prerequisites
- `bun` or `node`
- `just` task runner
- Cloudflare account with Workers enabled
- Free API keys from [Google AI Studio](https://aistudio.google.com), [Groq](https://console.groq.com), and optionally [OpenRouter](https://openrouter.ai)

### 2. Local Setup
Clone the repository and set up local development variables:
```bash
cp .env.example .dev.vars
```

Edit `.dev.vars` to include your provider keys:
```ini
GEMINI_API_KEY="AIzaSy..."
GROQ_API_KEY="gsk_..."
OPENROUTER_API_KEY="sk-or-v1-..."
GATEWAY_TOKENS="sk-proj-aider,sk-proj-server,sk-proj-local"
```

Start the local development server:
```bash
just dev
```
The gateway will start listening on `http://127.0.0.1:8787`.

### 3. Deploy to Cloudflare Workers
Provision KV storage and deploy to the edge:
```bash
# Provision Cloudflare KV namespace
bunx wrangler kv namespace create SHIMS_KV

# Store upstream credentials securely as edge secrets
bunx wrangler secret put GEMINI_API_KEY
bunx wrangler secret put GROQ_API_KEY
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler secret put GATEWAY_TOKENS

# Deploy to Cloudflare edge
just deploy
```

For detailed deployment procedures, refer to [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Client Integration

Configure client tools by pointing their base URL and API key to `shunt-shim`:

### Environment Variables
```bash
export OPENAI_BASE_URL="https://shunt-shim.<your-subdomain>.workers.dev/v1"
export OPENAI_API_KEY="sk-proj-aider"
```

### Aider
```bash
aider --openai-api-base "https://shunt-shim.<your-subdomain>.workers.dev/v1" \
      --openai-api-key "sk-proj-aider" \
      --model "openai/fast"
```

### OpenCode / Continue
In your `config.json`:
```json
{
  "models": [
    {
      "title": "Edge Fast (Groq 70B)",
      "provider": "openai",
      "model": "fast",
      "apiBase": "https://shunt-shim.<your-subdomain>.workers.dev/v1",
      "apiKey": "sk-proj-aider"
    },
    {
      "title": "Edge Deep Context (Gemini Flash 1M)",
      "provider": "openai",
      "model": "deep",
      "apiBase": "https://shunt-shim.<your-subdomain>.workers.dev/v1",
      "apiKey": "sk-proj-aider"
    }
  ]
}
```

### Python SDK
```python
from openai import OpenAI

client = OpenAI(
    base_url="https://shunt-shim.<your-subdomain>.workers.dev/v1",
    api_key="sk-proj-aider",
)

response = client.chat.completions.create(
    model="fast",
    messages=[
        {"role": "user", "content": "Explain raft consensus in three sentences."}
    ],
)
print(response.choices[0].message.content)
```

### cURL Verification
```bash
curl -s -X POST "https://shunt-shim.<your-subdomain>.workers.dev/v1/chat/completions" \
  -H "Authorization: Bearer sk-proj-aider" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fast",
    "messages": [
      {"role": "user", "content": "ping"}
    ]
  }' | jq .
```

## Documentation Roadmap

- [docs/MVP.md](docs/MVP.md): Proposed MVP scope, acceptance criteria, language choices, and deployment alternatives.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): Edge topology, multi-project synchronization, request lifecycle, context heuristics, and protocol translation.
- [docs/FREE_TIERS.md](docs/FREE_TIERS.md): Comprehensive inventory of always-free compute, storage, database, and LLM tiers.
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): Configuration variables, Wrangler settings, virtual aliases, tenant tokens, and KV schemas.
- [docs/RUNBOOK.md](docs/RUNBOOK.md): Setup instructions, deployment steps, smoke tests, observability, and incident diagnostics.
