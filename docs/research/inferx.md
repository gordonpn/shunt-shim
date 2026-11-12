# InferX production inference research

Research for [issue #171](https://github.com/gordonpn/shunt-shim/issues/171),
checked **2026-11-12**. Scope: public official website and documentation; no
account, paid deployment, benchmark, or live inference call was used. The issue
had no comments when checked. The pages below did not expose publication or
revision dates; the check date is a retrieval date, not proof of content age.

## Assessment for shunt-shim

InferX is a useful reference for separating a stable inference API from GPU
placement and model lifecycle management. Its hosted endpoints are a possible
future upstream to evaluate, while its private GPU runtime solves a different
operational problem from this repository's lightweight HTTP gateway. InferX
explicitly separates public model APIs, hosted custom models, and an inference
platform installed on customer infrastructure. [Official overview](https://inferx.net/)

**Recommendation (research judgment): retain the current MVP.** It selects
Cloudflare Workers, Groq and Google AI Studio, free-tier models, non-streaming
Chat Completions, and bounded fallback without a database. Adding a licensed GPU
platform or a paid upstream would need a separate scope and spending decision.
See [MVP](../MVP.md), [architecture](../ARCHITECTURE.md), and
[ADR 0002](../adr/0002-model-fallback-and-provider-adaptation-strategy.md).
This investigation does not change runtime, provider selection, or compatibility
certification.

## Product and deployment boundaries

| Product | Documented deployment and commercial shape | Implication |
| :--- | :--- | :--- |
| Public Endpoints | Hosted models, API key, per-token usage pricing; no customer GPU management. [Overview](https://inferx.net/) | Closest candidate for a future gateway upstream. |
| Custom serverless inference | Bring a model to InferX; advertised scale-to-zero and billing for GPU compute while serving requests. [Overview](https://inferx.net/) | Requires owning the model-serving lifecycle and validating actual billing behavior. |
| InferX Platform | Customer GPUs, networking, storage and models; Kubernetes, bare metal, private cloud or GPU cloud. License, deployment/support package, and cluster/GPU-footprint pricing via sales. [Platform](https://inferx.net/on-prem) | Adds hardware, platform procurement, and operational obligations beyond the MVP. |

For private installs, InferX says models, traffic and inference data remain inside
the customer's boundary, with no routing to an InferX-controlled cloud. This is a
private-platform statement; it must not be generalized to hosted endpoints.
Supported Kubernetes distributions and versions are confirmed during discovery.
The published playbook starts with a limited GPU pilot, workload validation and
then rollout, rather than an unconditional deployment-time guarantee.
[Platform](https://inferx.net/on-prem)

## Architecture and serving model

The published architecture has a gateway that detects available serving
instances, a scheduler that chooses placement and triggers startup, node agents
that manage GPU resources and snapshots, an isolating runtime, and a local or
remote snapshot store. Kubernetes remains infrastructure orchestration; InferX
manages inference-specific state and placement.
[Architecture](https://inferx.net/architecture)

The differentiating mechanism is snapshot/restore of initialized **CPU, CUDA,
and NCCL communication state**, rather than merely faster weight loading. The
same snapshot primitive is described as supporting restore, fork-based scale-out,
migration and recovery on healthy capacity. Runtime diagrams show a KVM guest
kernel, host VMM, CUDA/NCCL interception and validation before host NCCL, with
OCI/CRI compatibility. These are vendor descriptions, not an independent audit
of isolation or recovery correctness.
[Architecture](https://inferx.net/architecture)

The platform documents NVIDIA GPUs, tensor parallelism across 2, 4 and 8 GPUs,
and NCCL data parallelism. The homepage lists vLLM, SGLang, TensorRT-LLM and
PyTorch compatibility references, expressly without implying partnership or
endorsement. This is not a version-by-version support matrix.
[Platform](https://inferx.net/on-prem), [overview](https://inferx.net/)

The console guide provides a concrete custom-model workflow: select a Hugging
Face model ID and vLLM image version, configure parameters such as
`--max-model-len`, GPU count and vRAM, create a snapshot, and retrieve endpoint
credentials. That guide's UI describes GPU counts of 1 or 2, while the platform
page describes larger tensor-parallel deployments; these describe different
surfaces and should not be collapsed into a universal limit. Gated models require
accepted licenses and an `HF_TOKEN`.
[Console guide](https://inferx.net/docs/console-guide)

## Reliability, scaling, observability and cost

| Area | Public evidence | Qualification for this project |
| :--- | :--- | :--- |
| Scaling | Shared GPU pools, snapshots for inactive workloads, placement and restoration when capacity is needed. [Architecture](https://inferx.net/architecture) | Scale-to-zero releases assigned capacity; it does not create physical capacity or guarantee admission under load. |
| Recovery | Snapshot restoration to healthy GPU capacity and migration are described. [Architecture](https://inferx.net/architecture) | No recovery-time objective, request replay semantics, queue durability, control-plane HA topology or disaster-recovery procedure was established in the reviewed pages. |
| Latency/utilization | Sub-second cold starts, up to 80% utilization, and 30–70% infrastructure savings are advertised. Savings explicitly depend on workload, model size, traffic and existing utilization. [Platform](https://inferx.net/on-prem) | Marketing claims, not measurements for code-review prompts or this gateway's 5-second connection/header timeout and 60-second deadline. |
| Observability | Model detail exposes pod status and logs; private deployment support includes monitoring, upgrades and capacity planning. [Console guide](https://inferx.net/docs/console-guide), [platform](https://inferx.net/on-prem) | Reviewed pages do not establish Prometheus/OpenTelemetry export, metric schemas, alerting SLOs or redaction guarantees. |
| Hosted cost/capacity | Public endpoints publish model-specific input/output/cached-token prices. Homepage reports a previously free endpoint temporarily becoming discounted paid access while GPU capacity is added. [Overview](https://inferx.net/) | Do not assume a permanent free tier, guaranteed model availability or fixed promotional prices. No account-specific entitlement was verified. |
| Private cost | Platform license plus deployment/support and GPU footprint. [Platform](https://inferx.net/on-prem) | GPU rental/ownership, networking, storage and operations must also enter any comparison; a license quote and representative utilization measurements are needed. |

The reviewed public material does not establish a contractual uptime SLA,
rate-limit values, regional failover, cancellation billing, or an independently
reproducible cost benchmark. This is an evidence gap, not a claim that those
capabilities are absent.

## API and integration evidence

The API reference confirms bearer authentication and a Chat Completions request
with `model`, `messages` and `stream`. Endpoint-specific base URL, model name and
key come from the console. The SDK guide uses the standard OpenAI Python client
with `base_url="https://model.inferx.net/v1"`; no proprietary SDK is required for
that documented workflow.
[API reference](https://inferx.net/docs/api-reference),
[SDK guide](https://inferx.net/docs/sdk-guides)

The SDK guide names OpenCode, OpenClaw, Hermes, Claude Code, OpenWebUI, Dify and
Continue, and qualifies compatibility as accepting an OpenAI base URL and key.
**OpenCode is not OpenCodeReview**, and this does not certify any of shunt-shim's
three review clients. The public example streams; it does not by itself prove
non-streaming behavior, function tools, all `tool_choice` modes, token-limit
precedence, reasoning metadata, usage shape or error normalization.
[SDK guide](https://inferx.net/docs/sdk-guides),
[project compatibility requirements](../COMPATIBILITY.md)

## Useful concepts and future qualification

These are project-specific inferences, not promised InferX features:

- Keep routing/authentication policy separate from GPU/model lifecycle. InferX's
  gateway/scheduler/runtime split illustrates the boundary; shunt-shim can remain
  a small HTTP policy layer without implementing a GPU scheduler.
  [Architecture](https://inferx.net/architecture)
- Distinguish **capacity exhaustion** from **quota exhaustion**. Snapshots improve
  activation and utilization, but the published capacity-related pricing change
  reinforces that elastic infrastructure still has finite capacity.
  [Overview](https://inferx.net/)
- For a future hosted-provider evaluation, first obtain an explicitly approved
  model, cost ceiling, endpoint/key and rate limits. Exercise non-streaming text
  plus the complete tool-call/result workflow, null content, finish reasons,
  optional usage/reasoning fields, and both token-limit fields against
  [COMPATIBILITY.md](../COMPATIBILITY.md).
- Measure connect/header and full-response latency under warm, cold and loaded
  conditions. Verify HTTP 429/503, credential/validation errors, retry headers,
  disconnect cancellation and timeout behavior before including InferX in
  bounded fallback. A failed request may already have consumed upstream compute;
  do not infer idempotence or free retries from OpenAI compatibility.
- Consider a private installation only if private model/data control and owned
  GPU utilization become requirements. Verify Worker network reachability,
  supported hardware/software versions, snapshot upgrade/invalidation rules,
  security evidence, telemetry/redaction, recovery guarantees and total cost
  during a pilot. Private endpoints require an actual authorized network path
  from the Worker; a documented internal URL alone is insufficient.

## Evidence limits

All external claims above come from the linked first-party material, retrieved
on 2026-11-12. Product pages describe vendor capabilities and intentions, not
independent validation. No authenticated console, model deployment, API request,
security report or pricing agreement was inspected. Public API documentation is
brief; the absence of detailed semantics prevents a production compatibility
claim. Further collection should focus on those qualification gaps rather than
repeat general marketing claims.
