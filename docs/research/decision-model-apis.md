# Dedicated decision APIs: feasibility and remaining spike work

Research for [issue #168](https://github.com/gordonpn/shunt-shim/issues/168).
**Verified against public official sources on 2026-11-12.** No issue comments
were present. This is a research deliverable, not a completed implementation or
empirical evaluation. The issue remains open: no model calls, credentialed quota
checks, deployed route or three-way benchmark were performed.

## Recommendation and proposed decision record

**Defer a production `POST /v1/decisions`; proceed with an isolated, text-only
Gemini evaluation once account eligibility and free-tier status are established.**
Purpose-built models are real documented products: Gemini Decision 1 evaluates
closed-ended questions in a single prefill pass, returns outcome probabilities
and produces zero output tokens. It is distinct from a generative model asked
to emit JSON. Its model page records a November 2026 update and explicitly marks
text generation, structured outputs, tool calling and search grounding as
unsupported. [Google model](https://aistudio.google.com/docs/models/gemini-decision-1)

Proposed ADR status: **research proposal, not accepted**. Keep decision inference
separate from Chat Completions because question semantics, probability outputs,
media handling and error cases differ. Reuse gateway transport protections,
not chat response envelopes. Preserve the current Workers/Hono deployment,
Groq/Gemini chat behavior, free-only policy and no-storage MVP.
[Current architecture](../ARCHITECTURE.md), [MVP](../MVP.md),
[ADR 0002](../adr/0002-model-fallback-and-provider-adaptation-strategy.md)

A useful initial experiment is classifying code-review findings into
`actionable`, `needs_context` or `non_actionable` in shadow mode, without changing
review publication. For watchgraph, score already-retrieved synthetic candidate
summaries against a declared preference rubric; do not add web research or
personal viewing history to the initial free-service test. Neither consuming
repository is changed by this report.

## Provider comparison

All limits below describe public policy on the check date, not effective limits
on the owner's account. Free usage is capacity-limited and is not an SLA.

| Candidate | Type, schema and scope | Free economics and qualification |
| :--- | :--- | :--- |
| Google Gemini Decision 1 | Native Decisions API: shared `input`, named `questions`, `noul`, `choice`, `score`, `answers` and modality-aware usage. Text, images, audio, video and PDFs. 262,144 input tokens; up to 1,000 independent questions. [API](https://aistudio.google.com/docs/decisions-api) | Published free limits **200 RPM, 50,000 TPM, 10,000 RPD**; paid input $0.10/M tokens, zero output-token charge. Shared input billed once, each question adds instructions/criteria tokens. No Batch API or caching. [Limits](https://aistudio.google.com/docs/rate-limits#gemini-decision), [pricing](https://aistudio.google.com/docs/pricing#gemini-decision) |
| Parallel Decisions Fast via OpenRouter | Dedicated web-grounded decisions, not chat. Text/JSON `state`; up to 100 questions; 32,000 tokens per question including shared state. `noul`, choice distributions, rubric score; per-question refusals and request citations. [Model](https://openrouter.ai/parallel/decisions-fast:free) | `parallel/decisions-fast:free` lists zero input/output price. OpenRouter free-variant account limits apply unless exempt; shared capacity and grounding add a different dependency from local classification. No dedicated TPM guarantee established. [Limits](https://openrouter.ai/docs/api-reference/limits) |
| Respan Span-01 Lite via OpenRouter | Dedicated behavior scoring over conversation spans; probability that a described behavior is present. [Model](https://openrouter.ai/respan/span-01-lite:free) | `respan/span-01-lite:free` lists free pricing. Do not infer general-purpose choice/score capability merely from the marketplace's shared playground or generic endpoint examples; exact per-model limits and unsupported questions need a call test. [Model](https://openrouter.ai/respan/span-01-lite:free) |
| JevStyle hosted / local | Independent Jev-style models, not TypeSafe. Hosted 2B v4 is text-only, `/v1/systemone`, shared `state` and typed questions; 8,192 context, 8,000-token/32,000-byte input cap. Local PyTorch 2B v4 supports images; MLX/GGUF are text-only. [API](https://jevstyle.com/api/), [models overview](https://jevstyle.com/) | Free hosted service has **no fixed per-account RPM/RPD cap**, shared capacity and 429 + Retry-After; best effort, no SLA. Older 10,000/day references are explicitly obsolete. Free weights do not make self-hosted compute free. [Current limits](https://jevstyle.com/api/limits.html) |
| Cloudflare Workers AI | Relevant narrow alternative: SST-2 DistilBERT accepts `{text}` and returns classification results. It is a fixed sentiment classifier, not arbitrary instruction-based binary/choice/rubric inference. Native `env.AI.run` binding or REST. [Model](https://developers.cloudflare.com/workers-ai/models/distilbert-sst-2-int8/) | Recurring **10,000 Neurons/day**, reset 00:00 UTC; Free plan operations fail after limits, Paid plan bills excess at $0.011/1,000 Neurons. No universal decisions/day or TPM follows from Neurons. [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Existing generative upstream | Structured JSON classification can reuse existing text-model access, but still generates tokens and needs output validation; a model-written confidence number is not automatically a calibrated distribution. Google's documentation explicitly contrasts these uses. [Decision vs structured output](https://aistudio.google.com/docs/decisions-api#when-to-use) | Compare using actual configured account/model allowance, not Gemini Decision quotas. Additional classifier requests consume existing upstream quota. [Project contract](../COMPATIBILITY.md) |

The OpenRouter native endpoint is **`POST https://openrouter.ai/api/alpha/decisions`**,
with bearer authentication; it is not `/chat/completions` and is explicitly alpha.
Its public reference demonstrates raw `fetch`, `state`, model and typed questions.
Response usage may include `input_tokens`, `output_tokens` and cost; do not copy
Google's zero-output assumption into every adapter.
[Native reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)

### Quotas, credentials, billing and privacy

- Google publishes recurring free allowance rather than a one-time credit.
  Limits are project-scoped; evaluate RPM, TPM and RPD together. At 1,000 input
  tokens/request, 50,000 TPM permits at most 50 requests/minute before other
  limits, not 200. At 250 tokens/request, the published RPM and TPM ceilings
  coincide. These are arithmetic bounds, not guaranteed throughput. Billing
  must be set up to move from Free to Tier 1; effective entitlement and possible
  project verification must be checked in AI Studio. Reusing `GEMINI_API_KEY`
  does not prove the associated project is unbilled or authorized for this model.
  [Rate limits](https://aistudio.google.com/docs/rate-limits)
- Google's free-tier pricing table says inputs may improve products. The terms
  allow human review and prohibit sensitive/confidential/personal information in
  unpaid services, with regional and billing-linked exceptions. They also limit
  use to available regions, require paid services for clients available to users
  in the EEA/Switzerland/UK, and contain age/use restrictions. Check the actual
  project, user location and use case; do not treat a free key as permission for
  confidential code-review traffic. [Pricing](https://aistudio.google.com/docs/pricing#gemini-decision),
  [terms, effective March 23, 2026](https://ai.google.dev/gemini-api/terms)
- OpenRouter documents 20 RPM and 50 requests/day for free variants with fewer
  than 10 lifetime purchased credits, versus 1,000/day at the higher purchase
  tier (documentation notes a current rounding/top-up threshold concession).
  Check `GET /api/v1/key` for the effective account counter and exceptions;
  multiple keys do not multiply quota. Do not purchase credits for this spike.
  These are request limits, not a verified per-model TPM/TPD entitlement.
  [Limits](https://openrouter.ai/docs/api-reference/limits)
- OpenRouter uses API keys. Pin the exact `:free` ID and disable paid fallback;
  generic credit/budget caps alone do not establish no-spend model selection.
  Its policy table lists Parallel and Respan as not training on prompts but with
  an **unknown retention period**. This is intermediary documentation, not an
  independently inspected provider agreement; verify both provider terms and
  OpenRouter's own logging settings before private data use. Card requirements
  and account access were not tested. [Provider policies](https://openrouter.ai/docs/features/privacy-and-logging)
- JevStyle requires an email-verified or Google account and bearer key; its
  privacy page says there are no payments today, request text is not stored,
  and operational key/time/status metadata is logged. Do not send secrets or
  government IDs. The free-service policy prohibits quota resale/scraping.
  Its homepage labels the project Apache-2.0; verify the exact downloaded model
  artifact's license and training provenance before redistribution. Local
  Python/PyTorch/MLX inference needs a separate host, not the current Worker.
  [Privacy](https://jevstyle.com/privacy/), [limits](https://jevstyle.com/api/limits.html),
  [project and provenance](https://jevstyle.com/)
- Workers AI supports a Worker binding or account API token for REST. Free plan
  capacity is a hard boundary without upgrading, while Paid enables billed
  excess. Cloudflare says standard stateless inference does not retain content
  after processing and does not train on it, subject to stated legal/security
  exceptions; logging, caching and stateful features alter storage behavior.
  Model licenses remain applicable. Card/signup requirements and model-specific
  context/RPM limits were not established here. [Model usage](https://developers.cloudflare.com/workers-ai/models/distilbert-sst-2-int8/),
  [data use, updated October 16, 2026](https://developers.cloudflare.com/workers-ai/platform/data-usage/)

No inspected source establishes comparable calibration on these projects'
traffic. Marketplace latency/uptime displays and vendor single-pass claims are
not a measured p50/p95 or reliability guarantee for this gateway.

## Native Gemini semantics and remaining technical blocker

The official guide confirms the Developer API `v1beta` and SDK
`client.decisions.create`; it specifies SDK 3.2+ and accepts shared text or media
content blocks. The retrieved page exposed Python examples while its REST tab
was not included in the extracted content. Consequently **the exact native
Google HTTP path and authentication header are not verified in this report**;
do not invent a path from the SDK method name or send decisions to the existing
OpenAI-compatible chat URL. Export a REST example from the official playground
or inspect the corresponding official SDK implementation before implementing a
raw-fetch adapter. Workers compatibility is plausible at the HTTPS/JSON boundary,
not runtime-tested or certified here.
[Official guide](https://aistudio.google.com/docs/decisions-api)

Verified semantic details from that guide:

- Binary `noul` is P(yes), clamped to 0.01–0.99; confidence is
  `max(p, 1-p)`. High confidence can therefore mean a confident **no**.
- Choice has 2–255 options, probability distribution and top choice. Keys are
  sorted in UTF-8 byte order; exact ties select the first key. Include an `other`
  category or an independent scope check for out-of-domain input.
- Score has 2–255 ordered levels, indexed from zero. Value is the expected
  index, not necessarily the most likely level. Preserve probabilities and
  legend; a bimodal distribution can have the same expected score as a peaked
  one. Confidence refers to the top outcome, not certainty in the mean.
- Questions cannot see each other's answers; shared input counts once, but
  question instructions/criteria add tokens. Multiple questions in one request
  are not the unsupported asynchronous Batch API.
- Safety blocks are HTTP 400 with structured error codes, not low-confidence
  decisions. No text generation, explanations, caching or chat tool blocks.
  Serialize JSON as text for Google; do not reinterpret arbitrary JSON as media.
  No YouTube or direct `gs://` URIs.

**Prototype blocker:** no `GEMINI_API_KEY` is available in this worktree's process,
no effective free-tier project entitlement has been verified, and shell network
access is blocked by the configured proxy. No key was read from secret stores,
no paid account was enabled and no model call was attempted. This is an
execution/access blocker, not evidence that the documented model is unavailable.

## Candidate gateway contract (unimplemented)

Use an independent schema version and explicit model selector initially:
`decision-gemini-v1`, not an alias that silently swaps semantics. Text only,
JSON object bodies, 32 KiB UTF-8 request cap, at most 10 independent questions,
2–10 options/levels, bounded nonempty instructions and unique question IDs.
These are proposed gateway limits, deliberately below provider maxima; exact
per-field lengths and token estimates require implementation tests. Reject
media, unsupported capabilities and unknown fields explicitly rather than drop
them. Keep provider metadata allowlisted, never raw provider payloads.

Proposed binary/choice/score request, sent to an **unimplemented** endpoint:

```json
{
  "schema_version": "1",
  "model": "decision-gemini-v1",
  "input": "The report cites a reproducible crash and includes the failing input.",
  "questions": {
    "actionable": {"type": "binary", "instructions": "Does this finding contain evidence of a defect?"},
    "route": {"type": "choice", "instructions": "Choose the review action.", "options": {"review": "Evidence warrants inspection", "other": "Insufficient evidence"}},
    "quality": {"type": "score", "instructions": "Rate the supporting evidence.", "levels": ["Unsupported", "Concrete report", "Reproducible report"]}
  }
}
```

Illustrative envelope only; the numbers below are synthetic, not model results:

```json
{
  "schema_version": "1",
  "request_id": "example-001",
  "model": "decision-gemini-v1",
  "provider": "gemini",
  "actual_model": "gemini-decision-1",
  "answers": {
    "actionable": {"type": "binary", "status": "ok", "probability_yes": 0.9, "confidence": 0.9},
    "route": {"type": "choice", "status": "ok", "value": "review", "probabilities": {"other": 0.1, "review": 0.9}, "confidence": 0.9},
    "quality": {"type": "score", "status": "ok", "expected_index": 1.7, "probabilities": {"0": 0.0, "1": 0.3, "2": 0.7}, "confidence": 0.7}
  },
  "usage": {"input_tokens": 200, "output_tokens": 0}
}
```

Responses must preserve question keys/types, provider probabilities and supplied
usage; never fabricate confidence when absent. Missing optional metadata is
omitted. Permit a per-question `status: "refused"` with a safe code and no value
for adapters that support refusals. Malformed or missing required answers are
protocol failures, never an implicit negative. Schema and score semantics stay
stable within version 1; incompatible changes need a new version.

### Integration boundaries and behavior

Repository inspection at `ee2357346481b9229856e2ade4c2ec62d2ff39e6` found:

- `src/index.ts` owns the Hono routes, shared authentication and diagnostic
  middleware. A disabled-by-default route would reuse those protections.
  `src/worker.ts` should keep its minimal default export.
- `src/auth.ts` provides constant-time credential comparison. Provider keys stay
  in Worker secrets; a decision-only environment validator should not require
  Groq merely because the chat validator currently does.
- `src/validation.ts` mixes the reusable bounded-body reader with chat validation.
  Use a decision validator and parameterized body bound; do not call the chat
  schema or enlarge its limits. Validate before upstream dispatch.
- `src/upstream.ts` contains chat normalization and timeout/fallback behavior.
  Start with a separate decision adapter, direct `fetch` after native REST
  verification, and a single attempt. Share small cancellation/deadline helpers
  only after tests demonstrate identical needs; no generalized provider framework.
- `src/diagnostics.ts` limits fields and currently types providers as Groq/Gemini.
  Initial Gemini can reuse that identity; future providers need an explicit type
  change. Never log input, instructions, answers, distributions or keys.
  `src/errors.ts` can supply the existing safe error envelope.

Proposed initial deadline: 10 seconds total including body/response reading,
with a 5-second connect/header ceiling, one request, no automatic retry, hedging
or fallback. Abort on caller disconnect/deadline, clean up timers, and bound the
upstream response body. Cancelled work may still consume provider quota. Map
invalid/unsupported requests to 400, auth to 401, unknown selector to 404, body
size to 413, upstream quota to 429, safety to an explicit safe 400, transport or
malformed provider responses to 502, unavailability to 503 and deadline to 504.
Provider credential errors must remain errors with safe messages and no retry.
Copy only validated retry headers; never leak upstream credentials or raw bodies.
No low-confidence result triggers another paid or recursive decision call.

No cross-request counter is necessary: upstream limits enforce quota. An alias
must not promise reservation or strict shared accounting without coordination.
Initial consumers handle low confidence locally via abstention/manual review or
deterministic rules, and treat 429/5xx as service failures, not valid predictions.

## External-client examples (for the proposed contract)

Save the request above as `decision.json`; this command is executable syntax but
will receive 404 from the current gateway because the route does not exist:

```sh
curl --fail-with-body "$SHUNT_BASE_URL/v1/decisions" \
  -H "Authorization: Bearer $SHUNT_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @decision.json
```

TypeScript transport example, with no provider SDK dependency:

```ts
async function decide(base: string, token: string, input: unknown, signal: AbortSignal) {
  const response = await fetch(`${base}/v1/decisions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) throw new Error(`Decision service failed: ${response.status}`);
  return response.json(); // Consumer must validate the versioned envelope before use.
}
```

## Evaluation protocol and honest current results

**No empirical comparison results exist yet.** Binary/choice/score behavior,
accuracy, false-positive/negative rates, calibration, p50/p95 latency, token
usage, cost and failure handling are **not measured**. Documentation establishes
feasibility, not economic benefit. Issue #168's 50-case dataset and live
prototype acceptance items remain incomplete.

For a reproducible next evaluation, commit a fixed, reviewed JSONL dataset of
at least 50 non-sensitive cases, ten each for intent, provider selection,
relevance, recommendation fit and tool/escalation selection. Include clear
positives/negatives, near-boundary cases, out-of-domain cases, adversarial
instructions and intentionally missing context. Record rubric version, expected
label and allowed abstention, annotator and rationale. Freeze labels before calls;
separate threshold-tuning and holdout cases to avoid scoring on tuned examples.

Run identical inputs/criteria through (1) Gemini Decision 1, (2) the existing
free generative model with validated JSON, and (3) deterministic rules. For
example, compare token/body limits deterministically before asking a model to
classify semantic complexity; do not ask the model to override unavailable
providers or account quotas. Do not substitute numeric sentiment for arbitrary
routing quality.

Record per-case label, prediction/distribution, abstention/refusal, HTTP status,
latency, input/output tokens and actual billed cost, plus model version, account
tier and prompt hash. Compute task-specific confusion matrices, macro accuracy,
false-positive/negative rates, abstention coverage, Brier score/reliability bins
for compatible probabilities, and p50/p95 on successful calls while reporting
failures separately. Repeat timed calls on a fixed subset for latency estimates;
50 examples alone do not establish stable tail latency or calibration.

Count requests and input tokens separately: ten questions sharing a document
may save shared-context tokens, but a single wrong criterion can invalidate the
comparison. Treat output-token savings as one factor; network latency, model
quality, quota scarcity and cost of wrong decisions determine practical value.
A paid hypothetical example of 1,000 input tokens is $0.0001 per request at
Google's listed $0.10/M rate; it is not observed cost and is not authorization
to use a paid project.

### Follow-up milestones and completion boundary

1. Verify the native Google REST route, free-only project entitlement, regional
   terms, effective limits and secret availability without exposing credentials.
2. Build an isolated disabled harness and mocked tests for binary/choice/score,
   malformed inputs/outputs, refusal, 429, timeout, abort and bounded responses.
   Run the repository's format, lint, typecheck, build and test gates.
3. Freeze and run the dataset/baselines within actual free quota. Publish raw
   non-sensitive records, aggregate metrics and calibration limits.
4. Decide go/no-go using labeled quality and failure costs plus saved downstream
   tokens/latency. Only then propose an accepted ADR and separately reviewed route.

Estimated engineering work (judgment, not benchmark): a few days for a one-provider
harness, schema tests and first evaluation; production integration adds rollout,
client contracts and maintenance as alpha APIs evolve. Costs can remain zero only
within verified free allowances and free-only routing. Local JevStyle introduces
host operations; Workers AI Paid and billed Gemini projects introduce overage
exposure. This document completes provider/architecture research **partially**,
not the whole spike. It intentionally leaves the issue open.
