# shunt-shim

Status: Cloudflare Worker service implemented with reproducible quality gates. See [MVP scope and acceptance criteria](docs/MVP.md) for the specification, verification gates, and platform trade-offs.

`shunt-shim` is an OpenAI-compatible routing gateway for free-tier large language model (LLM) providers. The MVP exposes a `/v1/chat/completions` endpoint backed by Groq with Google AI Studio as fallback. Cloudflare Workers (TypeScript / Hono) is the target deployment runtime (see [ADR 0001](docs/adr/0001-runtime-target-and-shared-request-bounds.md)). Model fallback and provider adaptation strategies are documented in [ADR 0002](docs/adr/0002-model-fallback-and-provider-adaptation-strategy.md).

The goal is to let DeepSeek Review, OpenCodeReview, and PR-Agent use one endpoint without client code changes. Compatibility requires deployed evidence for all three, including OpenCodeReview's tool-call round trip. See the [pinned client sources and contract](docs/COMPATIBILITY.md).

```
Client -> Gateway (fast alias) -> Groq (Primary: qwen/qwen3.8-27b)
                                -> Google AI Studio (Fallback: gemini-2.5-flash-lite)
```

## Implemented MVP Capabilities

- OpenAI-compatible `/v1/chat/completions`, its `/chat/completions` alias, and `GET /v1/models` (catalog returning `fast`).
- One virtual alias, `fast`, routing to primary Groq (`qwen/qwen3.8-27b`) and fallback Google AI Studio (`gemini-2.5-flash-lite`).
- Non-streaming JSON responses, function tool calls, and tool-result message validation.
- Deterministic HTTP 400 `unsupported_parameter` rejection when `stream: true` or `stream_options` are supplied (streaming is deferred to post-MVP).
- At most one bounded fallback attempt on upstream HTTP 429, HTTP 503, connection timeout (5s), or network error before committing the response.
- One random gateway secret configured in `GATEWAY_TOKENS`, accepted via Bearer auth or `x-api-key`.
- Strict request bounds: 10 MB body limit, 128,000 context ceiling, 8,192 max completion tokens, 5s connect timeout, 60s total deadline, and client disconnect cancellation.
- Safe structured JSON diagnostics with request IDs, status, latency, provider, model, attempts, and fallback reasons; zero logging of prompts, completions, tool payloads, or credentials.

If all eligible providers are exhausted, the gateway returns an explicit error. It does not create additional quota or guarantee uninterrupted access.

Shared accounting, proactive quota checks, tenant priorities, context routing, `deep` and `reasoning` aliases, OpenRouter, and Workers AI are deferred. The MVP requires no database, KV namespace, or multi-tenant token catalog.

## Free-Tier Provider Summary

| Provider | Top Models | Free Quotas | Context | Primary Strength | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Groq | Qwen 2.5 32B (`qwen/qwen3.8-27b`) | 1,000 RPD, 30 RPM, 8,000 TPM | 128,000 tokens | Low latency inference, reliable function tool calling | Primary Route |
| Google AI Studio | Gemini 2.5 Flash-Lite (`gemini-2.5-flash-lite`) | 1,000 RPD, 15 RPM | 1,000,000 tokens | Free input/output tokens, high context window | Fallback Route |
| OpenRouter (:free) | DeepSeek R1, Llama 3.3 70B, Qwen 2.5 | 50 RPD (free tier), 1,000 RPD ($10+ credits) | Up to 128k-1M tokens | Unified open-weights catalog | Deferred |
| Cloudflare Workers AI | Gemma, GLM, Nemotron, Llama 3.3 | 10,000 Neurons/day (~1,000 queries) | 8k-128k tokens | Native edge invocation | Deferred |
| Vercel AI Gateway | Multi-provider catalog | $5/month recurring credits | Model dependent | Commercial model testing | Deferred |

For an inventory of always-free compute, storage, edge networks, and LLMs, consult [docs/FREE_TIERS.md](docs/FREE_TIERS.md).

## Cloudflare Quickstart

The Worker entrypoint and Wrangler configuration are runnable locally and verified through test suites.

### 1. Prerequisites
- `node` (v22+) and `pnpm` (v10+)
- `just` task runner
- Cloudflare account with Workers enabled
- Free API keys from [Google AI Studio](https://aistudio.google.com) and [Groq](https://console.groq.com)

### 2. Local Setup
Install dependencies and configure local environment variables:
```bash
pnpm install
cp .env.example .dev.vars
```

Edit `.dev.vars` with your provider keys and a random gateway secret:
```ini
GEMINI_API_KEY="AIzaSy..."
GROQ_API_KEY="gsk_..."
GATEWAY_TOKENS="<one-random-gateway-secret>"
```

Validate secrets, check types, run test coverage, and start the local development server:
```bash
just check-secrets
just typecheck
just test
just dev
```
The gateway will listen locally on `http://127.0.0.1:8787`.

### 3. Deploy to Cloudflare Workers
Provision edge secrets and deploy:
```bash
pnpm exec wrangler secret put GEMINI_API_KEY
pnpm exec wrangler secret put GROQ_API_KEY
pnpm exec wrangler secret put GATEWAY_TOKENS

just deploy
```

For operational procedures and diagnostics runbook, refer to [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Client Integration

All target clients must configure non-streaming completions (`stream: false` or omitted) against the gateway endpoint `/v1/chat/completions` using the `fast` model alias:

| Review client | Gateway setting | Model | Stream Mode |
| :--- | :--- | :--- | :--- |
| `hustcer/deepseek-review@v1` | `base-url=https://proxy.example.com/v1` | `fast` | Non-streaming (Action default) |
| `alibaba/open-code-review` | `llm_protocol=openai`, `llm_url=https://proxy.example.com/v1/chat/completions` | `fast` | Non-streaming (`stream=false`) |
| `The-PR-Agent/pr-agent` | `openai.api_base=https://proxy.example.com/v1` | `openai/fast` | Non-streaming (`config.custom_model_max_tokens=128000`) |

Use the gateway credential configured in `GATEWAY_TOKENS`, not upstream provider keys. Follow the [complete configuration and evidence requirements](docs/COMPATIBILITY.md).

## Documentation Roadmap

- [docs/AUTOMATION.md](docs/AUTOMATION.md): All imported GitHub Actions, file guards, review secrets, coverage/CodeQL setup, and local verification with `mise exec -- just check-workflows`.
- [docs/MVP.md](docs/MVP.md): MVP scope, acceptance criteria, language choices, and deployment alternatives.
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md): Canonical request/response contract, pinned client sources, configuration, and evidence requirements.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): Edge topology, request lifecycle, timeout bounds, and schema adaptation.
- [docs/FREE_TIERS.md](docs/FREE_TIERS.md): Inventory of always-free compute, storage, database, and LLM tiers.
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): Configuration variables, Wrangler settings, virtual aliases, and request limits.
- [docs/RUNBOOK.md](docs/RUNBOOK.md): Setup instructions, deployment steps, smoke tests, observability, and incident diagnostics.
