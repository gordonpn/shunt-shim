# shunt-shim

Status: design proposal, not yet implemented. See [the proposed MVP and deployment options](docs/MVP.md) for the initial scope, acceptance criteria, and language/platform trade-offs. The capabilities and setup instructions below describe the broader planned design.

`shunt-shim` is a proposed OpenAI-compatible routing shim for free-tier large language model (LLM) providers. The MVP would expose one `/v1/chat/completions` endpoint backed by Groq with Google AI Studio as fallback. No gateway capabilities are implemented yet; language and deployment platform remain undecided.

The goal is to let existing coding clients use one endpoint without manually switching providers when the primary is rate-limited. Compatibility must be verified with a real client's streaming and tool-call workflows.

```
Client -> Proposed gateway -> Groq
                          -> Google AI Studio (fallback)
```

## Proposed MVP Capabilities

- OpenAI-compatible `/v1/chat/completions` and `/v1/models` endpoints.
- One `fast` alias routing to explicitly allowed free-tier models on Groq and Google AI Studio.
- Non-streaming JSON, incremental SSE, tool calls, and tool-result messages.
- One bounded fallback attempt on upstream HTTP 429, HTTP 503, or a connection timeout, only before committing the downstream response.
- One randomly generated bearer token, request validation, body limits, deadlines, and cancellation.
- Diagnostics that exclude prompts, completions, and credentials.

If all eligible providers are exhausted, the gateway must return an explicit error. It cannot guarantee uninterrupted access or additional quota.

Shared accounting, proactive quota checks, tenant priorities, context routing, `deep` and `reasoning` aliases, OpenRouter, and Workers AI are deferred. Cloudflare KV is eventually consistent and lacks atomic counter updates, so it cannot reliably enforce global quotas under concurrency. If strict coordination becomes necessary on Workers, evaluate Durable Objects instead.

## Free-Tier Provider Summary

| Provider | Top Models | Free Quotas | Context | Primary Strength | Constraints |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Google AI Studio | Gemini 2.5 / 3.8 Flash, Flash-Lite, Pro | 1,000 RPD (Flash-Lite), 250-500 RPD (Flash) | 1,000,000 tokens | Massive token context, multimodal inputs | Quotas reset at 00:00 UTC; free tier prompts subject to model training |
| Groq | Llama 3.3 70B, Llama 3.1 8B | 14,400 RPD (8B), ~1,000 RPD (70B), ~30 RPM | 128,000 tokens | Ultra-low latency (250-300+ tok/s on 70B) | Enforces strict rolling per-minute token buckets (TPM) |
| OpenRouter (:free) | DeepSeek R1, Llama 3.3 70B, Qwen 2.5 72B | ~20 RPM, ~200 RPD | Up to 128k-1M tokens | Unified catalog for open-weight frontier models | Shared public capacity subject to queue latency |
| Cloudflare Workers AI | Llama 3.3 70B, Mistral 7B, DeepSeek Distill | 10,000 Neurons/day (~1,000 queries) | 8k-128k tokens | Native edge invocation without credential management | Lower context windows |

For a comprehensive catalog of always-free compute, storage, edge networks, and LLMs, consult [docs/FREE_TIERS.md](docs/FREE_TIERS.md).

## Planned Cloudflare Quickstart

These examples are not runnable yet: the Worker entrypoint and Wrangler configuration do not exist. Use them only after implementation and if Cloudflare is the selected deployment platform. The MVP requires no KV namespace.

### 1. Prerequisites
- `bun` or `node`
- `just` task runner
- Cloudflare account with Workers enabled
- Free API keys from [Google AI Studio](https://aistudio.google.com) and [Groq](https://console.groq.com)

### 2. Local Setup
Clone the repository and set up local development variables:
```bash
cp .env.example .dev.vars
```

Edit `.dev.vars` to include your provider keys:
```ini
GEMINI_API_KEY="AIzaSy..."
GROQ_API_KEY="gsk_..."
GATEWAY_TOKENS="sk-proj-aider,sk-proj-server,sk-proj-local"
```

Start the local development server:
```bash
just dev
```
The gateway will start listening on `http://127.0.0.1:8787`.

### 3. Deploy to Cloudflare Workers
Store secrets and deploy to the edge:
```bash
# Store upstream credentials securely as edge secrets
bunx wrangler secret put GEMINI_API_KEY
bunx wrangler secret put GROQ_API_KEY
bunx wrangler secret put GATEWAY_TOKENS

# Deploy to Cloudflare edge
just deploy
```

For detailed deployment procedures, refer to [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Planned Client Integration

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
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): Proposed configuration variables, Wrangler settings, virtual aliases, tenant tokens, and deferred accounting.
- [docs/RUNBOOK.md](docs/RUNBOOK.md): Setup instructions, deployment steps, smoke tests, observability, and incident diagnostics.
