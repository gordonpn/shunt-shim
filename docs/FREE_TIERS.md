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

## 7. Web Search Provider Economics and MVP Selection

Verified November 12, 2026 against the official pages linked below. This date applies only to this section; the preceding infrastructure and LLM catalog was not reverified. Prices are USD unless stated otherwise. These are published offers, not a guarantee about an operator's particular account. No accounts, cards, or paid plans were provisioned during verification.

The search initiative (#98) requires a separate search API and a fail-closed `freeOnly` policy. Select **Tavily and Exa for the MVP**, using dedicated accounts with no payment method, paid credit balance, or automatic recharge. Treat a missing or unverified billing policy as ineligible. A public free allowance alone does not prove that a configured account will stop before spending money.

### Search Comparison Matrix

| Provider / official pricing | Free Allowance | Renewal | Payment Method | Overage Risk | Technical Fit | MVP Decision |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| [Tavily](https://www.tavily.com/pricing) | 1,000 API credits; 1,000 basic searches or 500 advanced searches if spent exclusively on search | First day of each month | None required for Researcher/free | Free requests stop at exhaustion. Opting into PAYG permits charges at $0.008/credit; do not enable it. | Synchronous JSON search with content, optional answers, domain filters; depth changes cost | **Include** on verified free-only account; explicitly select basic depth |
| [Exa](https://exa.ai/pricing) | $10 monthly credit balance, plus a separate one-time $10 onboarding bonus; only a user's first team receives the recurring grant | Balance resets to $10 on first day of calendar month; unused monthly grant does not accumulate; onboarding bonus does not expire | None required for Free | Exhausted balance or key budget returns HTTP 402. Paid prepaid balance and configurable auto recharge can spend money; keep both absent. | Synchronous JSON search with text/highlights and domain/date filters; Lite $4/1k requests, Auto $7/1k, Deep $12/1k for up to 10 results, before add-ons | **Include**; reserve monetary cost by mode/options, not a fixed request quota |
| [Brave Search](https://brave.com/search/api/) | $5 credits/month; equivalent to 1,000 Search requests at $5/1k, if used only there | Monthly; exact reset boundary not stated on pricing page | **Card required**, described as abuse prevention | Current FAQ says prepaid, no subscription, charged only for credits chosen for purchase. This differs from assumptions that every card-backed plan auto-bills; account-specific recharge/exhaustion controls still require verification. | Independent index; web/news/image/video results and LLM Context; storage/training rights require custom plan | **Defer** card-backed access until explicit approval and quota guardrails; do not describe current offer as 2,000 free queries |
| [Parallel](https://parallel.ai/pricing) | Build: $5/month with card; up to $80 signup credit is promotional. Launch: free personal-use MCP with variable limits, not a published fixed API quota | Build monthly; exact reset boundary not stated | **Card required** for Build API; none/account not needed for Launch MCP | Published API rates apply after credits run out; auto-reload and spend limits available. Search starts at $1/1k requests with 10 results; additional results cost extra. | Synchronous agent-oriented search/excerpts plus separate Extract API; Launch MCP is a different access surface | **Defer** Build until card approval and atomic budget enforcement; do not count Launch as a deterministic API allowance |
| [Linkup](https://www.linkup.so/pricing) | Advertises 4,000 free queries | **Unverified**: pricing page does not promise recurring renewal; treat as promotional until confirmed | **Unverified** on reviewed public pages | PAYG Search advertised at $0.005–$0.006/request; free exhaustion, auto-recharge and payment requirements not established | Synchronous search with ranked sources, sourced answers or schema output; depth/output change cost | **Defer** until renewal and hard-stop/card policy are verified; do not infer monthly credits |
| [Firecrawl](https://www.firecrawl.dev/pricing) | 1,000 credits/month: up to 500 searches of 1–10 results, without scraping or premium options | Monthly; free credits do not roll over; exact reset boundary not stated | None required for Free | PAYG requires paid plan; paid accounts automatically add credits in $5 increments. Billing limit 0 disables PAYG; blank means unlimited. Keep free account separate. | Search URLs/descriptions/highlights; optional full-page extraction and other endpoints share balance and add cost | **Post-MVP candidate** for search/extraction; current recurring offer is not a one-time 500-credit trial |
| [Serper](https://serper.dev/) | 2,500 free queries to try | **One-time promotional allowance**, no published recurring free grant; trial expiry not established | None required for trial | FAQ says queries stop at zero balance. Paid top-up model, no subscription: Starter $50/50k credits ($1/1k), paid credits valid 6 months | Google SERP JSON, including organic links/snippets and specialized result types; separate from Google's own API | **Exclude from sustainable free pool**; optional bounded evaluation only |
| [Jina AI Reader / Search](https://jina.ai/reader/) | New key receives 10M free tokens shared across products; Search starts at 10,000 tokens/request (at most 1,000 searches at that minimum if no other use). Keyless Reader URL extraction is distinct | New-key promotional balance; recurring Search token renewal not promised; token expiry not established | Free key offered; explicit no-card signup guarantee **unverified** | Top-up tokens sold separately; optional auto top-up charges saved payment method. Do not enable it. Search requires key; keyless Reader is not free search. | `s.jina.ai` searches and returns readable content; `r.jina.ai` extracts known URLs. Free-key Search 100 RPM, keyless Reader 20 RPM | **Exclude from recurring search pool**; assess separately for extraction |
| [Google Custom Search JSON API](https://developers.google.com/custom-search/v1/overview) | Existing customers only: 100 queries/day; paid $5/1k up to 10k/day | Daily, **only until discontinuation January 1, 2027** | API key and configured Programmable Search Engine; billing enrollment for extra requests | Billing permits paid requests beyond free quota | REST web/image JSON from Programmable Search Engine; closed to new customers | **Disqualified**: closed to new customers and approaching sunset |

### Official API Contracts and Cost Boundaries

All endpoint references below were read November 12, 2026. They describe HTTP interfaces usable from Workers via `fetch`; adapter behavior, latency, quality, and live credentials have not been tested. None is an OpenAI Chat Completions search contract.

| Provider | Endpoint / official contract | Budget-relevant boundary |
| :--- | :--- | :--- |
| Tavily | [`POST https://api.tavily.com/search`](https://docs.tavily.com/documentation/api-reference/endpoint/search), Bearer API key | [Credit documentation](https://docs.tavily.com/documentation/api-credits): basic/fast/ultra-fast cost 1 credit; advanced costs 2. Pin depth and avoid research/crawl defaults when reserving one search credit. |
| Exa | [`POST https://api.exa.ai/search`](https://exa.ai/docs/reference/search), API key | [Billing](https://exa.ai/docs/admin/billing) confirms calendar reset and HTTP 402 hard stop. Results above 10 and content/synthesis options can change cost; $10 is a money allowance, not universally 2,500 searches. Auto-recharge maximum 0 or blank means **no cap**, unlike Firecrawl's 0 setting. |
| Brave | [`GET https://api.search.brave.com/res/v1/web/search`](https://brave.com/search/api/), `X-Subscription-Token` | LLM Context uses `/res/v1/llm/context`; Answers also has token charges. Do not pool all endpoint costs as one Search request. Verify permitted caching/storage rights before retaining results. |
| Parallel | [`POST https://api.parallel.ai/v1/search`](https://docs.parallel.ai/api-reference/search/search), API key | Current contract uses `/v1/search`; older `/v1beta/search` examples must not be copied without rechecking. Variable mode/result costs and paid continuation require a bounded reservation. |
| Linkup | [`https://api.linkup.so/v1/search`](https://docs.linkup.so/pages/documentation/endpoints/search/overview), authenticated search route | Depth and `outputType` select ranked results, generated answer or structured output. Estimate the exact selected mode; public pricing is insufficient to establish a renewable free-only account. |
| Firecrawl | [`POST https://api.firecrawl.dev/v2/search`](https://docs.firecrawl.dev/features/search), API key for account quota | Search costs 2 credits per 10 results, rounded up. Scraping adds page costs; multiple source types apply result limits per source. Disable scraping and premium options for a bounded search-only estimate. |
| Serper | [Official product examples](https://serper.dev/) show SERP result schema | The reviewed public page establishes result shape and exhaustion policy, but not a versioned authenticated request contract. Confirm method, host, authentication and current terms in official account docs before any adapter work. |
| Jina | [`https://s.jina.ai`](https://jina.ai/reader/), free/paid API key; `https://r.jina.ai` is Reader | Shared token pool, output-size accounting for Reader, and Search minimum charge prevent treating RPM or keyless extraction as a recurring Search quota. |
| Google | [`GET https://customsearch.googleapis.com/customsearch/v1`](https://developers.google.com/custom-search/v1/reference/rest/v1/cse/list), key plus engine ID | Reference only for migration; do not build a new provider adapter. |

### Operational Decision and Remaining Verification

- MVP eligibility is conditional on account inspection: no payment method or paid balance, no PAYG/auto-recharge, confirmed free grant, known reset, and a bounded request cost. A provider's exhaustion response is a final backstop, not a substitute for local quota reservations under concurrency.
- Fail closed when billing state, credit renewal, request cost, or remaining quota is unknown. Never silently move from free credits to purchased credits. Do not retry a costly request or fail over to an unapproved paid account merely because another provider returns 402/429.
- Keep trial/signup bonuses separate from recurring budgets. Shared keys, teams and extraction/research use consume the same upstream allowance; local counters must account for that or use isolated accounts. Reverify offers and account configuration before provisioning and after billing changes.
- The recommendation is an economics and interface assessment, not a quality ranking. Run recorded adapter contract tests and a representative coding/documentation search benchmark before selecting fallback order. Query retention, redistribution and caching rights require separate terms review; Brave explicitly limits storage/training to a custom plan.
- Unresolved evidence is deliberately explicit: Linkup renewal/card/hard-stop policy; Jina Search token expiry and signup payment guarantee; exact monthly reset boundaries for Brave, Parallel and Firecrawl; Serper trial expiry and authenticated endpoint contract. None should inherit a safe default from an issue description or an older pricing comparison.
