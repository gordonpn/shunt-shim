# Always-Free Cloud and LLM Tiers Reference

This document catalogs permanent, always-free cloud infrastructure allowances and large language model (LLM) developer tiers. It distinguishes perpetual quotas from temporary promotional trials and documents operational constraints, idle policies, and failover patterns.

Verified against provider documentation as of October 20, 2026.

## 1. Raw Compute and Virtual Machines (IaaS)

| Provider | Always-Free Compute Specs | Storage and Bandwidth | Constraints and Pitfalls |
| :--- | :--- | :--- | :--- |
| Oracle Cloud (OCI) | Up to 2 OCPUs and 12 GB RAM (Ampere A1 Arm) plus 2x AMD Micro VMs (1/8 OCPU, 1 GB RAM each) | 200 GB Block Volume, 10 TB/month Outbound Egress, 20 GB Object Storage | Idle Reclamation: Instances with under 20% CPU, memory, or network utilization over 7 days are automatically reclaimed. Arm capacity in popular regions faces frequent stock depletion. |
| Google Cloud (GCP) | 1x e2-micro VM (2 shared vCPUs, 1 GB RAM; US regions only) | 30 GB Standard Persistent Disk, 1 GB/month Outbound Egress | Bandwidth Cliff: The 1 GB monthly egress quota is strict. Any outbound traffic exceeding this limit automatically bills the linked card. |

### Operational Notes: Compute Tiers

- Oracle Cloud Infrastructure (OCI): OCI provides the largest perpetual compute allocation in the industry. The Ampere A1 pool can run as a single 2-core / 12 GB RAM instance or split into two 1-core / 6 GB instances running continuously. Upgrading an account to Pay-As-You-Go (PAYG) waives the idle-reclaiming policy while retaining the free tier quota, provided usage stays under 2 OCPUs and 12 GB RAM.
- Google Cloud Platform (GCP): The e2-micro tier provides a stable x86 VM that does not pause or sleep. Because of the 1 GB egress restriction, it is best suited for inbound webhook listeners, local cron triggers, or low-bandwidth uptime pingers.
- AWS and Azure Caveats: Neither AWS nor Azure provides a permanent general-purpose VM tier. Compute allocations such as AWS t2.micro/t3.micro and Azure B1s are 12-month promotional trials that convert to on-demand retail billing after month 12.

## 2. Edge Networks, Serverless, and Storage

| Provider | Free Edge / Compute | Free Storage and Persistence | Key Features |
| :--- | :--- | :--- | :--- |
| Cloudflare | 100,000 Worker requests/day, unlimited Pages requests and bandwidth | 10 GB R2 Object Storage (zero egress fees), 5 GB D1 SQL Database (5M reads, 100k writes/day) | Zero billing risk: no idle sleeps, no reclamation sweeps, and no overage billing without explicit manual upgrades. Includes 50 Zero Trust tunnel seats. |
| Turso | Managed libSQL (distributed SQLite) | 9 GB storage across up to 500 databases, 1 billion row reads/month | Sub-millisecond cold starts. Inactive databases scale to zero compute without data archiving or deletion. |
| AWS Always-Free | 1,000,000 Lambda requests/month, 1 TB/month CloudFront egress | 25 GB DynamoDB NoSQL storage, 1,000,000 SQS messages/month | High-throughput serverless execution and CDN edge distribution independent of expiring EC2 trials. |

### Operational Notes: Edge and Storage

- Cloudflare: The absence of egress fees on Pages and R2 Object Storage makes Cloudflare the default choice for edge routing, artifact storage, and database replication tools like Litestream.
- Turso: Enables per-tenant or per-project SQLite database architectures at zero cost, supporting up to 500 isolated databases under one account.

## 3. Container Platforms and Managed Databases (PaaS)

| Provider | Container Quota | Managed Database | Sleep Behavior |
| :--- | :--- | :--- | :--- |
| Northflank (Sandbox) | 2x Services (0.1 vCPU, 256 MB RAM each), 2x Cron jobs | 1x Managed Database (PostgreSQL, MySQL, Redis, or MongoDB) | Always On: Containers do not sleep or spin down after inactivity. Public endpoints are bound to *.northflank.app subdomains. |
| Supabase | 2x Hosted Projects | 500 MB PostgreSQL per project, 1 GB File Storage | Inactivity Pause: Projects without traffic are paused after 7 days. Reactivation requires manual console intervention. |
| Koyeb | 1x Web Service (nano instance, 512 MB RAM) | Integrated key-value cache | MicroVM isolation running continuously on bare metal across US and EU edge locations. |

### Operational Notes: PaaS

- Northflank: Stands out as an always-on container host without the mandatory sleep timeouts enforced by platforms like Render. It is well-suited for lightweight persistent services like Uptime Kuma or Redis caches.
- Fly.io Status: Fly.io discontinued its perpetual free tier for new accounts, restricting free access to short-term evaluation trials.

## 4. Free LLM API Access Models and Provider Comparison

Free API access divides across three distinct economic models:

1. Permanent Free Tiers: Ongoing usage allowances that renew on daily or monthly schedules (such as Google Gemini, GroqCloud, and Cloudflare Workers AI).
2. Recurring API Credits: A recurring dollar balance renewed monthly that can be spent across eligible models (such as Vercel AI Gateway providing $5/month, or Hugging Face providing $0.10/month).
3. One-Time Trial Credits: Initial promotional balances valid for a limited window (such as Cerebras providing $5 for 30 days, requiring payment method). These support initial evaluation but do not form sustainable free infrastructure.

### Free LLM API Comparison Matrix

Verified against provider documentation as of October 20, 2026.

| Provider | Free API Allowance | Models and Capabilities | Best Suited For | Primary Constraints and Notes |
| :--- | :--- | :--- | :--- | :--- |
| Google Gemini API | Free input/output tokens on eligible models; rate-limited | Gemini 2.5 / 3.8 Flash and Flash-Lite | General-purpose applications, 1M-token large context | Prompts submitted under the free tier may be reviewed by human annotators to train Google models. Consumer Google AI Pro subscriptions do not increase Developer API allowances. |
| GroqCloud | Up to 1,000 requests/day, 200,000 tokens/day, rate-limited per minute | GPT-OSS 120B/20B, Qwen 3.8 27B, Llama 3.3 | Low-latency inference and real-time agent loops | Strict sliding per-minute token buckets (TPM) can throttle high-context coding requests before daily request limits bind. |
| OpenRouter | 50 free requests/day, 20 requests/minute (free tier); 1,000 requests/day ($10+ credits) | NVIDIA Nemotron 3 Ultra (1M), Poolside Laguna S 2.1 (262k), Cohere North Mini Code (256k), MiniMax M3.1 Flash (1M), Nemotron 3.5 Lightning (1M) | Broadest open-weight selection, coding agents, second-opinion review | Shared community endpoints can experience queue latency. Some upstream free-model providers explicitly allow training on prompts and outputs. Purchased credits ($10+) expand daily free-model cap to 1,000 requests/day. |
| Cloudflare Workers AI | 10,000 Neurons/day | Gemma, GLM, Nemotron, Llama 3.3, DeepSeek Distill | Serverless edge workflows and microservices | Neurons measure compute units rather than raw tokens. Context windows are typically smaller (8k to 128k). Certain resource-heavy models require paid plans. |
| NVIDIA Build | Free hosted NIM inference for prototyping | NVIDIA Nemotron variants, open community models | Prototyping and direct tool integration via OpenCode | Requires NVIDIA Developer Program account. Offers hosted NIM microservice inference without routing through external proxies. |
| Vercel AI Gateway | $5/month in recurring credits | Eligible models from multi-provider catalog | Testing commercial and closed-source models | Covers only eligible models in Vercel catalog. Purchasing additional API credits converts the account to paid and terminates the recurring $5/month allowance. |
| Mistral AI | Free API usage with account-specific limits | Mistral Small, Codestral, Embeddings | European hosting, structured JSON, code completion | Rate-limited to low requests per second (~1 RPS) on free tier. |
| Hugging Face | $0.10/month in inference credits | Open-source models across various providers | Evaluating specific open checkpoints | Low monthly credit ceiling ($0.10) limits continuous agent workloads. |
| Cerebras | $5 one-time trial credit, valid for 30 days (requires payment method) | GPT-OSS 120B, Qwen | High-speed inference evaluation | One-time promotional credit expiring in 30 days, not an ongoing free API allowance. |

### Obsolete and Discontinued Free Tiers

- GitHub Models: Officially retired on July 30, 2026. The playground and inference API were discontinued. GitHub Copilot Free remains available for editor chat and completions, but it is a distinct product and does not provide a general-purpose developer API.
- Qwen Code OAuth Tier: Discontinued on April 15, 2026. Legacy guides advertising 1,000 free daily requests via OAuth credentials are out of date.

### Providers Without General Ongoing Free API Tiers

- OpenAI: Operates no general recurring free API inference allowance. API billing is completely separate from ChatGPT consumer subscriptions (ChatGPT Plus or Team).
- Anthropic: Operates primarily on prepaid API credits. While certain Claude Max and Team subscriptions include monthly credits for consumer chat, there is no general free API tier.
- DeepSeek: Operates purely as a pay-per-token API without a general recurring free tier. Because pricing is very low, maintaining a small prepaid DeepSeek balance makes it an ideal safety fallback when free tiers are exhausted.
- Consumer Subscriptions vs Developer APIs: A Google AI Pro / Gemini Advanced consumer subscription does not grant larger Gemini Developer API limits. API tiers maintain independent billing configurations, quotas, and terms of service.

## 5. Connected Topics and Operational Blind Spots

### Free-Tier Data Privacy
Both Google Gemini free API and certain OpenRouter free-model hosting providers explicitly permit using submitted prompts and generated completions to improve and train AI models. Operators and coding agent users must avoid submitting proprietary codebases, production credentials, internal API keys, or sensitive customer data through untrusted free developer endpoints. For sensitive code, consider local self-hosting (Ollama / llama.cpp) or commercial API tiers with explicit zero-data-retention guarantees.

### Coding Agent Integration Matrix (OpenCode, Codex CLI, agy, OCR)
Coding agents (Codex CLI, agy, OpenCode, and Alibaba Open Code Review) interact with LLM providers through standard OpenAI-compatible endpoints:
- OpenCode: Directly supports 75+ providers via `/connect` (including OpenRouter, Groq, NVIDIA Build, Gemini, and Ollama). Run headless agent tasks with:
  `opencode run --model provider/model-id --agent plan "task description"`
- Alibaba Open Code Review (OCR): Operates as a deterministic PR review gate using local rules or upstream completions.
- shunt-shim: Acts as an edge-based gateway sitting between coding agents and upstream free tiers, providing rate-limit shielding, automatic failover (Groq to Gemini), and standard OpenAI protocol normalization.

### Coding Agent Token Dynamics
Coding agents (such as Aider, OpenCode, Claude Code, and PR-Agent) consume dramatically more tokens than conversational chat interfaces. Every interaction re-sends complete file trees, tool definitions, test outputs, and conversation context. As a result:
- Restrictive tokens-per-minute (TPM) limits (such as Groq's sliding TPM) trigger HTTP 429 throttling long before generous daily request quotas (1,000 RPD) are exhausted.
- Sliding token buckets require gateways like `shunt-shim` to inspect prompt byte sizes and divert large payloads (>100k tokens) to providers with high token-per-minute headroom (such as Google Gemini Flash).

### Complementary Local Self-Hosting
Hardware environments with bare-metal compute (such as home servers or local development workstations) can run local inference via Ollama or llama.cpp. Local models expose an OpenAI-compatible API endpoint with zero marginal token cost and complete data privacy, complementing cloud free tiers for repetitive small-context tasks.

## 6. Workload Selection and Multi-Provider Routing Strategy

| Architecture Role | Selected Provider | Rationale |
| :--- | :--- | :--- |
| Default Gateway Endpoint | Google Gemini API (free tier) | Multimodal ingestion, 1,000,000-token context window, stable daily reset schedule. |
| Low-Latency Inference | GroqCloud | Sub-second LPU execution for interactive CLI completions, git commit generators, and short diffs. |
| Model Diversity | OpenRouter (:free) | Single OpenAI-compatible endpoint multiplexing 25+ open-weight community models (Nemotron 3 Ultra, Laguna S 2.1). |
| Edge Native Pipelines | Cloudflare Workers AI | Co-located inference inside Cloudflare Workers alongside D1 SQL, KV, and R2 storage without managing API keys. |
| Prototyping & Fast NIM | NVIDIA Build | Free hosted NIM microservice inference for NVIDIA Nemotron variants via OpenCode. |
| Commercial Model Testing | Vercel AI Gateway | Monthly $5 credit allowance on eligible commercial models without upfront payment. |
| Paid Emergency Fallback | DeepSeek API | Cost-effective token balance reserved as a last-resort fallback when all free-tier quotas are exhausted. |
| Self-Hosted Fallback | Local Ollama / llama.cpp | Zero-cost loopback inference on local bare-metal hardware for non-rate-limited offline testing. |

### Infrastructure Deployment Guidance

- Self-hosting heavy services, Docker workloads, or VPN hubs: Deploy to Oracle Cloud (OCI) Ampere A1 (up to 12 GB RAM, 10 TB egress). Convert to PAYG to eliminate idle reaping.
- Edge routing, API gateways, static frontends, and backups: Deploy to Cloudflare (Workers, Pages, R2, D1) for zero egress fees and always-on edge availability.
- Persistent lightweight containers: Deploy to Northflank Sandbox (always-on, no idle sleep).
- Out-of-band monitoring and network pingers: Deploy to GCP e2-micro, restricting outbound data to under 1 GB per month.
- Aggregated LLM routing: Deploy `shunt-shim` to Cloudflare Workers to coordinate free allowances, enforce sliding rate-limit circuit breaking, and fall back to DeepSeek when quotas deplete.
