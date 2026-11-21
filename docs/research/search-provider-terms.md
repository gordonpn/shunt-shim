# Search provider terms: preparatory audit

Checked 2026-11-15 for [#159](https://github.com/gordonpn/shunt-shim/issues/159).
This report records public terms and project implications, not account-specific
permission or certification. It complements the economics report in
[PR #178](https://github.com/gordonpn/shunt-shim/pull/178); it does not edit its
shared file. Search privacy/ingress prerequisites remain open. Keep #159 open.

## Decision for the gateway

Do not infer that free credits, an API key, or zero persistent caching permits
an API wrapper, multi-customer result reuse, or public redistribution. Verify the
actual agreement, endpoint, account and use case before enabling any provider.
The restrictions below can block deployment independently of financial safety.

| Provider and primary source | Storage and caching | Attribution and distribution | Commercial/gateway implications |
| --- | --- | --- | --- |
| [Tavily terms](https://tavily.com/terms), sections 2, 3.2, 3.5; [storage guidance](https://help.tavily.com/articles/1612400809-storing-caching-retaining-output) | Help explicitly permits metadata, snippets, page content and API-response storage without a maximum retention period, including after subscription. Contact support before sharing cached results across customers to confirm plan fit. Publisher rights still apply. | Customer-application integration is recognized; services cannot simply be resold and competitive uses are restricted. No universal output-attribution format was established in these two pages. Do not remove source notices or infer a right to republish full pages. | Internal-business and application/end-user clauses must be read together. Confirm the intended personal gateway versus external customer offering and any plan/order-form exception. Storage help is not blanket redistribution permission. |
| [Exa terms](https://exa.ai/terms-of-service), sections 1.1, 1.2, 3 | No customer-output cache TTL or general output-storage permission was established from this agreement. Section 1.2(c)'s cache/store/distribute license is granted **to Exa**, not a license to the customer. | API use is limited to documented purposes. Reselling/leasing/sublicensing the services requires prior consent; competitive use includes Output. No output-specific mandatory attribution format was established. Preserve publisher attribution/rights and verify applicable API documentation. | Do not turn the provider's license over submitted data into a customer redistribution right. Confirm wrapper/service scope and the applicable agreement before offering a shared search service. |
| [Brave Search API terms](https://api-dashboard.search.brave.com/documentation/resources/terms-of-service), sections 3(b), 4(d), 9 | Default terms prohibit storage/cache/databases of Search Results except transient storage required for the customer application. They do not state a universal 24-hour allowance. Retention after termination is restricted. | Search Results cannot be redistributed/resold/sublicensed. Optional provider attribution must follow the specified POWERED BY BRAVE/logo or approved format; publisher rights remain separate. | Default restrictions also cover API-replacement functionality and use of results to create/evaluate/train/fine-tune/benchmark/improve AI models or services. Confirm written plan-specific rights before any relevant gateway or evaluation use; no general permission is inferred here. |
| [Parallel Customer Terms](https://parallel.ai/customer-terms), sections 2(b), 2(c), 4(b) | A query's output is primarily for one End Customer; it cannot be copied/cached/stored/made available to other End Customers or third parties. Significant output caching for AI and Data Selling Services is restricted. No universal same-customer TTL is stated. | API integration and End Customer applications are allowed subject to the agreement, but output sharing has the one-customer restriction. No fixed output-attribution format was established. | Prohibits synthetic training-data/model development, data selling/brokerage and competitive uses as defined there, including query-diverting reuse. Isolate users' output and obtain a use-case determination before shared reuse. |
| [Linkup terms](https://www.linkup.so/terms-of-use), articles 4.1, 4.2, 6.4 | Open Web Content retention is limited to what is necessary for text/data mining; lawful access and rightsholder opt-out checks apply. This is purpose-based, not a fixed TTL. Answers have a separate internal-use license. | Linkup does not transfer publisher-content ownership/licensing. Open Web Content distribution outside the specified mining purpose is not authorized. Answers are for client/end-user internal needs; no general output-attribution format was established. | Article 6.4 expressly prohibits substantially similar/competing services, including acting as a wrapper of Linkup APIs. Keep Linkup ineligible pending a written permission/use-case determination; a forwarding gateway must not assume it is exempt. |

Brave's reviewed page says last updated September 1, 2026. Parallel Customer Terms
say effective November 10, 2026 and explicitly say a customer's governing version
is the one in effect when they became a customer. Retrieval date is not proof that
these exact public versions govern an existing account.

Parallel's [website Terms of Service](https://parallel.ai/terms-of-service) concern
its websites. They are not a substitute for the Customer Terms governing API use.
Likewise, a generic Exa scraping blog cannot settle API output-storage rights.

## Privacy and training are separate questions

- Tavily terms section 6.5 permits use of AI Functionality inputs/outputs for
  training/improvement, subject to applicable terms. Do not generalize an
  AI-Functionality clause into an asserted policy for every Search/Extract field.
  Confirm the exact endpoint and account arrangement before private query use.
- Exa section 1.2(c) grants use of Search Engine input/output to provide, develop
  and improve services. API-specific privacy/retention commitments still require
  verification; this is not evidence of zero retention.
- Parallel section 4(b) permits using Customer IP to train/improve service models,
  while noting training data is not linked to individuals. Check the governing
  contract and any applicable order terms before relying on different commitments.
- Linkup article 6.5 permits processing Client Data, including prompts, for
  providing, maintaining, developing, training and improving the solution.
  Marketing or account-specific retention promises must be reconciled with the
  operative agreement rather than assumed to replace it.
- Brave's Search Query Data license and confidentiality provisions do not by
  themselves establish every endpoint's retention period. Verify the applicable
  privacy terms and any generated-result endpoint conditions separately.

These statements concern provider-side processing. A gateway metadata allowlist
cannot prevent provider or client-transcript retention.

## Follow-up acceptance evidence

1. Record account owner, governing agreement/version, order form, endpoint and
   permitted internal/external users without exposing credentials. Resolve the
   wrapper/competitive-use and publisher-content questions with the provider.
2. Integrate the approved matrix into `docs/FREE_TIERS.md` after PR #178; preserve
   endpoint/plan exceptions and distinguish permission, prohibition and unknown.
3. After the search ingress, adapters and diagnostics are implemented, reconcile
   with #158's threat model and audit the shipped search pipeline. Until then,
   record these runtime paths as unverified. Verify
   no result/query content enters logs, tracing, retry buffers, persisted caches,
   shared customer stores, analytics or retained test fixtures contrary to terms.
4. Define attribution/provenance rendering and deletion/retention rules per
   approved provider, including downstream clients and backups. A zero-cache
   gateway alone does not establish compliance of the whole application.
5. Add fixtures for these policy boundaries and get account-specific approval
   before activation. No runtime policy or live compliance test is supplied here.

Only the cited public pages were reviewed; no account, signed agreement, provider
clarification or private data was inspected. Unknown attribution/TTL fields mean
not established from the reviewed material, not that no obligation exists.
