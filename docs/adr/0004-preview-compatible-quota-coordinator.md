# 4. Preview-Compatible Quota Coordinator Boundary

Date: 2026-11-15
Status: PROPOSED
Scope: Preparatory architecture design for [#204](https://github.com/gordonpn/shunt-shim/issues/204)

## Context

The current `Justfile` uploads gateway versions with `wrangler versions upload
--preview-alias pr-<number>`. `.github/scripts/deploy-preview.sh` extracts a Version
URL and runs `just verify-ingress` against it. Cloudflare does not generate Version
URLs for Workers that implement a Durable Object [1]. Exporting the planned
`SearchQuotaCoordinator` from `shunt-shim` would therefore break this flow, even in
the dedicated preview account.

This proposal complements the preview evaluation in [PR #192](https://github.com/gordonpn/shunt-shim/pull/192)
and the quota design in [PR #188](https://github.com/gordonpn/shunt-shim/pull/188).
It does not accept either design, implement a coordinator, or change deployment
automation or infrastructure. Phase 1's no-database contract in
[ARCHITECTURE.md](../ARCHITECTURE.md) remains unchanged.

## Proposed decision

Host `SearchQuotaCoordinator` in a separate Worker in each account. The gateway
consumes an external Durable Object namespace through `script_name`, exports no
Durable Object class, and owns no Durable Object lifecycle configuration.
Cloudflare documents this external binding [2], and the Version URL restriction
applies to Workers implementing the class [1]. This supports the proposed boundary;
it is not evidence that the combined deployment has passed a live preview test.

| Option | Preview and operational consequences | Position |
| --- | --- | --- |
| Separate coordinator Worker, external `script_name` binding | Retains gateway Version URLs and the existing ingress gate. Adds a separately released stateful dependency, protocol compatibility obligations, and a shared preview namespace requiring test isolation. | Recommended, subject to the gates below. |
| Cloudflare isolated Previews (`wrangler preview`), with the coordinator implemented in the gateway Worker | Distinct from Version URLs [1, 7]. Requires Wrangler 4.135.0+ (`package.json` pins `^4.149.0`) and a `previews` configuration block; does not inherit production settings and requires applying preview secrets separately [7]. Automatically provisions an isolated Durable Object namespace per Preview, emits per-Preview and per-Deployment URLs, and enforces 100 Previews/Worker on Free (500 on Paid) and 100 deployments/Preview with oldest-first eviction [7, 8]. Service bindings, Workflow bindings, Queue consumers, Cron Triggers, and routes remain production-targeted [8]. | Candidate alternative evaluated from documentation only (see [PR #192](https://github.com/gordonpn/shunt-shim/pull/192)); requires live validation of `wrangler preview` in `.github/scripts/deploy-preview.sh`, `just verify-ingress` against Preview URLs, and preview-account credential behavior ([#186](https://github.com/gordonpn/shunt-shim/issues/186)) before selecting over the external coordinator Worker. |
| Per-PR named gateway Worker using `wrangler deploy`, with the coordinator implemented there | Uses ordinary `workers.dev` endpoints instead of Version URLs. Requires new naming, route suppression, secret provisioning, concurrency, PR-close teardown, and orphan cleanup. Each Worker owns its namespace and migrations. More Workers and retained state consume account resources. | Supported fallback if both external-binding Version URLs and isolated Previews fail validation; requires a separate implementation decision. |

Cloudflare's isolated **Previews** product (`wrangler preview`) is distinct from
Version URLs [1, 7] and is assessed above from official documentation only; no
live Preview deployment has been tested.

## Configuration and isolation

These are illustrative future configuration fragments, not deployable files. Use
explicit preview-only and production-only configuration selection and account IDs;
a different name alone is not the security boundary.

| Deployment target | Account | Gateway name | External `script_name` | Gateway routes |
| --- | --- | --- | --- | --- |
| PR versions | Dedicated non-production account | `shunt-shim` | `shunt-quota-preview` | No production routes; `workers_dev: true`, `preview_urls: true` |
| Production | Production account | `shunt-shim` | `shunt-quota-production` | Existing production custom domain and `workers.dev` |

The preview gateway would contain:

```jsonc
{
  "durable_objects": {
    "bindings": [{
      "name": "SEARCH_QUOTA_COORDINATOR",
      "class_name": "SearchQuotaCoordinator",
      "script_name": "shunt-quota-preview"
    }]
  }
}
```

Production substitutes `shunt-quota-production` in its own account. Both coordinator
Workers disable public ingress with `workers_dev: false`, `preview_urls: false`,
and no routes. The gateway uses namespace stubs and an explicit versioned RPC or
`stub.fetch` protocol, not a public coordinator URL or a service-binding proxy.
Calling a preview gateway version reaches the coordinator's deployed code; it
does not select a matching coordinator version. Roll out compatible coordinator
changes before gateway consumers and retain compatibility with old preview URLs.

Durable Object bindings are not inherited by Wrangler environments [3]. If named
environments are used, repeat every binding explicitly and validate the resolved
Worker name and optional `environment` selector [2]. No preview configuration may
name a production resource. Preview and production use independent namespaces,
storage, credentials, and provider accounts, as required by
[#186](https://github.com/gordonpn/shunt-shim/issues/186).

Within the preview account, Version URLs reuse configured resources [1]. PRs share
the preview coordinator unless explicitly partitioned. Use deterministic PR/test
scopes for synthetic reservations and cleanup, not arbitrary request-controlled
namespace keys. Production accounting keys identify the actual provider billing
account and billing window across all gateway versions. Any live preview provider
credentials also need one aggregate budget across PRs; per-PR counters must not
multiply the allowance for the same provider account.

## Credential and failure boundaries

Keep current same-repository PR and project-file gates. PR jobs receive only
`CLOUDFLARE_PREVIEW_API_TOKEN`, `CLOUDFLARE_PREVIEW_ACCOUNT_ID`, and
`PREVIEW_GATEWAY_TOKENS`; production credentials remain in the branch-restricted
`production` GitHub environment. Preview tokens have no production account or
zone/DNS permissions. Coordinator provisioning and migrations run from trusted
release automation, not arbitrary PR code. Account-scoped script-edit credentials
can affect other preview Workers, so a shared preview coordinator is not a boundary
between mutually untrusted PRs. Keep forks excluded and restrict live preview data.

Provision secrets independently on each Worker; bindings do not copy secrets.
Provider keys and gateway bearer tokens stay on their respective gateway. The
coordinator receives reservation metadata and limits, not provider credentials,
bearer tokens, prompts, or response bodies. Reviewer credentials stay in repository
secrets under the existing `AGENTS.md` policy.

Before any card-backed provider dispatch, require a successful durable reservation.
Missing bindings, coordinator timeouts, unavailable code, protocol mismatches,
storage errors, or exhausted Cloudflare limits fail closed for that provider.
Do not bypass accounting with isolate-local counters or retries that double-spend.
Use bounded calls within the existing gateway deadline, idempotent reservation
identifiers, and a defined reconciliation policy for uncertain dispatch/settlement.
Preserve uncertain reservations conservatively until reconciled. The implementation
must define the client error contract and any independently safe fallback path.

## Namespace lifecycle, rollout, and rollback

Namespace identity follows the owning account, Worker, and class, not the gateway
version or binding variable name [3]. Keep those identities stable across releases;
do not recreate production namespaces to reset quota. The coordinator alone owns
SQLite namespace creation, class lifecycle, and stored-schema upgrades.
Cloudflare currently documents declarative `exports` and a separate legacy
`migrations` mechanism [4]. Choose one supported by the pinned Wrangler, validate
its schema, and never combine both for Durable Objects. If using `migrations`,
create the SQLite class with `new_sqlite_classes`, not legacy `new_classes`.
Apply lifecycle changes with `wrangler deploy`, not gateway `versions upload` [5].

Required implementation and rollout gates:

1. Validate both resolved account/configuration pairs, absent gateway class exports
   and migrations, absent preview production routes, secret separation, and pinned
   Wrangler support. Run local two-Worker tests for external routing and protocol
   compatibility, atomic concurrent reservations, retries, timeout uncertainty,
   quota exhaustion, and fail-closed behavior with zero unauthorized provider calls.
2. Deploy and migrate the preview coordinator from a trusted revision, then bootstrap
   the preview gateway if needed. Obtain a real Version Preview Alias URL from
   `.github/scripts/deploy-preview.sh` with the external binding enabled and pass
   `just verify-ingress`. Exercise authenticated quota calls, concurrent PR scopes,
   coordinator failure, and a second upload updating the alias. Record account IDs,
   versions, sanitized binding evidence, and proof that preview writes never reach
   production state. Ingress probes alone do not prove quota enforcement.
3. Measure coordinator latency, requests, duration, storage operations, and retained
   state against both accounts' allowances. Rehearse compatible gateway/coordinator
   rollback and lifecycle-change recovery in preview before production provisioning.
   Release a compatible production coordinator first, then the gateway, with
   post-deploy ingress and quota checks and no unsupervised paid-provider probes.

Gateway rollback preserves the coordinator namespace and spend ledger. Roll back
coordinator code only to a protocol/schema-compatible version; Cloudflare cannot
roll back across a Durable Object lifecycle change [5]. Use a forward repair for
such changes, keeping card-backed dispatch disabled until accounting is reliable.
Existing automatic gateway rollback does not roll back the coordinator or its data.

Preview aliases and old version URLs can continue using the shared coordinator
after PR closure. Define expiration of synthetic test records and reservation
reconciliation without erasing active spend. Retire consumers and reachable old
versions before deleting a coordinator. Namespace deletion permanently destroys
its data [4]; Worker deletion is not a routine rollback. If the per-PR alternative
is chosen, add idempotent PR-close teardown and a scheduled orphan sweep covering
Workers, secrets, namespaces, and retained data, including failed/cancelled deploys.

## Budget and completion boundaries

SQLite-backed Durable Objects are available on Workers Free. Current documented
allowances include 100,000 requests/day, 13,000 GB-s/day, 5 million rows read/day,
100,000 rows written/day, and 5 GB stored data; exceeding a Free allowance causes
operations to fail [6]. Model reserve/settle/reconcile calls, alarms, retained state,
gateway traffic, and all preview PRs together. A second Worker does not grant a new
account allowance. Paid plans add billing exposure; this proposal neither selects
one nor guarantees zero spend. Free-limit exhaustion must use the failure policy
above, not an automatic plan upgrade or accounting bypass.

This document records a proposed boundary only. [#134](https://github.com/gordonpn/shunt-shim/issues/134),
[#135](https://github.com/gordonpn/shunt-shim/issues/135), and
[#204](https://github.com/gordonpn/shunt-shim/issues/204) remain open until the design
is accepted, the implementation lands, and live preview compatibility and production
isolation are verified. No live deployments or quota acceptance tests are claimed here.

## Sources

Official Cloudflare documentation checked 2026-11-15 (sources 1-6) and 2026-11-19 (sources 7-8):

1. [Version URLs and limitations](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)
2. [Wrangler Durable Object bindings](https://developers.cloudflare.com/workers/wrangler/configuration/#durable-objects)
3. [Durable Object environments and binding identity](https://developers.cloudflare.com/durable-objects/reference/environments/)
4. [Durable Object class exports and lifecycle](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) and [legacy class migrations](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)
5. [Durable Object lifecycle changes and version uploads](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/)
6. [Durable Object pricing and Free limits](https://developers.cloudflare.com/durable-objects/platform/pricing/)
7. [Workers Previews overview](https://developers.cloudflare.com/workers/previews/)
8. [Workers Previews resources and isolation](https://developers.cloudflare.com/workers/previews/resources/)
