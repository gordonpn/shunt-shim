# Always-Free Cloud and LLM Tiers Reference

This document catalogs permanent, always-free cloud infrastructure allowances and large language model (LLM) developer tiers. It distinguishes perpetual quotas from temporary 12-month promotional trials and documents operational constraints, idle policies, and failover patterns.

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

## 4. Generous Cloud LLM Provider Tiers

| Provider | Supported Free Models | Daily / Rate Allowance | Context Window | Primary Strength | Key Constraints |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Google AI Studio | Gemini 2.5 / 3.8 Flash-Lite, Flash, Pro | Up to 1,000 RPD (Flash-Lite), 250-500 RPD (Flash), 50-100 RPD (Pro) | 1,000,000 tokens | Massive token context, multimodal inputs (audio, video, PDF). | Prompts and completions may be reviewed by human annotators to train Google models. |
| Groq | Llama 3.3 70B, Llama 3.1 8B, Whisper-large-v3 | 14,400 RPD (8B), ~1,000 RPD (70B), ~30 RPM | 128,000 tokens | Low latency inference (250-300+ tokens/sec on 70B). | Enforces strict sliding per-minute token (TPM) limits. |
| OpenRouter (:free) | DeepSeek R1, Llama 3.3 70B, Qwen 2.5 72B | ~20 RPM, ~200 RPD | Up to 128k-1M (model dependent) | Single endpoint for testing frontier open-weight models. | Shared community capacity can produce queue latency spikes. |
| Cloudflare Workers AI | Llama 3.3 70B, Mistral 7B, DeepSeek R1 Distill | 10,000 Neurons/day (~1,000 lightweight queries) | 8,000-128,000 tokens | Zero credential setup inside Cloudflare Workers. | Lower context limits compared to dedicated model hosts. |
| GitHub Models | GPT-4o, Claude 3.5 Sonnet, o3-mini, Llama 3.3 | 15 RPM, 150 RPD per model | Model defaults | Evaluation access to frontier closed and open models. | Intended for playground evaluation; not rated for production traffic. |
| Mistral AI | Mistral Small, Codestral, Embeddings | ~1 RPS with monthly volume limits | 32,000-128,000 tokens | Structured JSON outputs and code completions. | Strict 1 RPS rate cap on the free tier. |

### Provider Mechanics and Quota Reset Profiles

1. Google AI Studio:
   - Quotas reset daily at 00:00 UTC.
   - Flash-Lite: 15 RPM, 250,000 TPM, 1,000 RPD.
   - Flash: 10 RPM, 250,000 TPM, 250-500 RPD.
   - Pro: 5 RPM, 150,000-250,000 TPM, 50-100 RPD.
   - Context window: 1,000,000 tokens allows routing entire codebases or long document batches in single prompts.
   - Privacy boundary: Upgrading to Pay-As-You-Go disables model training on prompt data while preserving free or low-cost usage.

2. Groq:
   - High-throughput LPU hardware achieves 250-300+ tokens/second on 70B models and over 800 tokens/second on 8B models.
   - Sliding rate windows: Groq tracks rolling tokens-per-minute (TPM) and requests-per-minute (RPM). Exceeding rolling windows triggers immediate HTTP 429 status codes.
   - Target use cases: Real-time agent loops, interactive terminal completions, and shell helpers.

3. OpenRouter (:free):
   - Acts as a unified gateway for models with the `:free` suffix.
   - Dynamic balancing via `openrouter/free` meta-model routes requests to available free capacity.
   - Rate allowance: Approximately 20 requests per minute and 200 requests per day per user key.

4. Cloudflare Workers AI:
   - Daily allocation of 10,000 Neurons resets at 00:00 UTC.
   - Native execution inside Worker handlers without external API key management.
   - Best for classification, summarization, and webhook pipelines.

## 5. Workload Selection Strategy

- Self-hosting heavy services, Docker workloads, or VPN hubs: Deploy to Oracle Cloud (OCI) Ampere A1 (up to 12 GB RAM, 10 TB egress). Convert to PAYG to eliminate idle reaping.
- Edge routing, API gateways, static frontends, and backups: Deploy to Cloudflare (Workers, Pages, R2, D1) for zero egress fees and always-on edge availability.
- Persistent lightweight containers: Deploy to Northflank Sandbox (always-on, no idle sleep).
- Out-of-band monitoring and network pingers: Deploy to GCP e2-micro, restricting outbound data to under 1 GB per month.
- Aggregated LLM inference: Deploy shunt-shim to a Cloudflare Worker to multiplex Google AI Studio, Groq, and OpenRouter behind an OpenAI-compatible endpoint.
