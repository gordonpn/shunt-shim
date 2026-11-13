# Deployment acceptance evidence (#38 / #36)

Status: **pending live execution**. Local tests and a dry-run build do not certify
a deployed Worker. Keep #38 open until the operator fills in this record.
SSE is deferred by the current [MVP](MVP.md); verify streaming rejection instead.
Three-client/provider compatibility and controlled fallback remain #40 and #41.

## Identify the deployment

Record UTC execution time, Git commit, Worker version ID, workers.dev URL, plan,
and operator. Use the URL printed by `just deploy`; a successful Actions run whose
production job was skipped is not deployment evidence. Never record tokens,
provider keys, private prompts, or raw provider output.

```bash
# Set the actual URL printed by deployment before running these probes.
export BASE_URL="https://shunt-shim.<your-subdomain>.workers.dev"
just deployments
just verify-ingress "$BASE_URL"
just verify-ingress-live "$BASE_URL"
just verify-ingress-resource "$BASE_URL"
```

Load `GATEWAY_TOKENS` from local `.dev.vars` or the environment, not CLI arguments.
Standard verification runs five public probes or eleven with a token. Live mode
adds one bounded completion (16 requested output tokens). Resource mode adds a
valid JSON body of exactly 10,485,760 ASCII bytes with short messages, an ignored
padding field, and `stream: true`. It expects HTTP 400 `unsupported_parameter`,
proving body ingestion/JSON parsing reached validation without contacting a
provider. The existing over-limit probe must still return HTTP 413.

Record exact commands, pass/fail counts, request IDs, and durations. Collect CPU
and memory measurements from Cloudflare for the near-limit probe; HTTP success
and client wall time alone do not prove the deployment fits its CPU/memory plan.

| Evidence | Result / sanitized artifact |
| --- | --- |
| Clean-checkout deployment; commit and Worker version | Pending |
| Authenticated ingress and 401 boundaries | Pending |
| Bounded live completion | Pending |
| Exactly 10 MB parsed; over-limit body rejected | Pending |
| Cloudflare plan, CPU/memory measurements and headroom | Pending |
| Transport deadline and disconnect verification | Pending |
| Rollback and restored-version verification | Pending |

## Verify cancellation and deadlines on an isolated deployment

Use an operator-controlled test upstream with HTTPS and placeholder provider keys,
configured only on an isolated test Worker using `GROQ_BASE_URL` / `GEMINI_BASE_URL`.
Do not point production at a failure-injection service. The test upstream must
record only a correlation ID, request arrival, connection close, and timestamps.

1. Delay primary headers beyond five seconds: verify its connection closes and
   one fallback starts. Delay fallback too: verify a bounded HTTP 504, not 200.
2. Send headers promptly, then stall the JSON body: verify the shared 60-second
   deadline ends active work. Use a client timeout above 60 seconds.
3. Abort a request while the upstream is active. Correlate the upstream connection
   close with client abort and verify no later fallback starts. Record measured
   cancellation latency and the agreed deployment acceptance bound.
4. Restore normal isolated configuration and verify success. Remove all test-only
   configuration before any production deployment.

The `enable_request_signal` flag enables incoming disconnect notification, and
application fetches must receive the signal. See Cloudflare's
[Request documentation](https://developers.cloudflare.com/workers/runtime-apis/request/).
A curl timeout or gateway completion log by itself is not proof of upstream
cancellation. Mocked cancellation tests establish local behavior only.

## Verify rollback

Use a dedicated test Worker with a known-good version and a subsequent test
version. Record both version IDs with `just deployments`. Execute
`just rollback <known-good-version-id>` and rerun authenticated ingress and live
verification. Record the active version and results after rollback. Do not induce
a production outage merely to collect evidence. Provisioning a rollback recipe
or testing a mocked CLI is not proof that a deployed version was restored.

## Local verification recorded for this change

On 2026-11-10, Wrangler 4.149.0 / local workerd passed all 12 probes from
`verify-ingress.ts http://127.0.0.1:8787 --resource` using dummy credentials.
The exact-limit probe returned HTTP 400 `unsupported_parameter` in 133 ms;
the over-limit probe returned HTTP 413. These are client wall times on a local
runtime, not deployed CPU/memory measurements. No live provider was contacted.
The branch's 241 tests, formatting, lint, type check, dry-run build, workflow
checks, and diff checks passed. OCR was unavailable (`ocr: not found`).
