# Search security threat model (preparatory)

Status: design guidance for proposed search, not an implemented or enforced search
security contract. This document is partial preparatory work for
[#158](https://github.com/gordonpn/shunt-shim/issues/158), under
[#156](https://github.com/gordonpn/shunt-shim/issues/156). Search diagnostic privacy
work [#157](https://github.com/gordonpn/shunt-shim/issues/157) and authenticated search
ingress story [#113](https://github.com/gordonpn/shunt-shim/issues/113), including its
prerequisites, remain open. This document does not complete or close those issues,
certify deployment, or implement runtime controls. Provider retention, caching,
and redistribution review remains separate work in
[#159](https://github.com/gordonpn/shunt-shim/issues/159).

## Existing boundary and proposed extension

The [MVP](MVP.md) and [architecture](ARCHITECTURE.md) describe the implemented chat
gateway. Its authenticated model/completion routes validate inputs, bound bodies
and deadlines, isolate configured provider credentials, and return normalized
responses. See [authentication](../src/auth.ts), the
[request middleware](../src/index.ts), and the [operational runbook](RUNBOOK.md).
These controls limit access and resource use; they do not establish the truth or
safety of model output, authorize tools, or detect prompt injection.

Current [diagnostics](../src/diagnostics.ts) serialize an explicit chat metadata
allowlist: timestamp, request ID, status, latency, provider, model, fallback reason,
and attempts. Search-specific diagnostics, query redaction tests, result
formatting, and URL controls described below are proposals, not existing search
capabilities. No search endpoint or search enforcement is claimed here.

## Assets, adversaries, and trust boundaries

Protect local source code, private project context, user intent, credentials,
workspace integrity, external accounts, and query/result privacy. An attacker may
control a ranked page, snippet, title, URL, redirect target, or compromised
otherwise reputable page. A search provider may relay this content faithfully;
ranking, HTTPS, and provider authentication do not make the content trustworthy.
A compromised provider or a malicious authenticated caller is also in scope.

| Boundary | Untrusted input and consequence | Responsible control owner |
| --- | --- | --- |
| User/workspace to agent search request | Queries can disclose source, internal names, traces, or secrets to providers. | Agent operator minimizes and approves disclosure. |
| Client to gateway to search provider (proposed) | Malformed requests, credential confusion, quota abuse; provider sees queries. | Gateway validates/authenticates before dispatch; operator selects providers and terms. |
| Provider/web content to gateway response (proposed) | Titles, snippets, URLs, HTML, and metadata may contain instructions or forged provenance. | Gateway bounds and encodes data; preserves source attribution without endorsing it. |
| Search response to agent reasoning | Retrieved text may impersonate system messages or tool results. | Client keeps external data below trusted instructions and user intent. |
| Agent reasoning to tools/browser/external accounts | Content can induce execution, exfiltration, login, or irreversible effects. | Client tool policy, sandbox, and user authorization gate effects. |
| Requests/responses/errors to logs and collectors | Queries, headers, result text, or URLs can leak into telemetry. | Gateway and operator enforce data minimization across every sink. |

The gateway cannot control a consuming agent's tool privileges or prevent a user
from trusting a misleading result. These client boundaries require independent
controls even if all gateway proposals are implemented.

## Attack scenarios and mitigations

| Scenario | Realistic failure | Required operator/client response and proposed gateway support |
| --- | --- | --- |
| Indirect prompt injection | A snippet or HTML comment says to ignore the user, reveal secrets, or treat a fabricated system message as authoritative. | Treat all retrieved fields as evidence only. Keep provenance and structured boundaries; never promote page text into instructions. Test role spoofing and delimiter escapes. |
| Malicious command recommendation | A convincing troubleshooting page recommends a destructive command, a remote install script, or a package that uploads environment variables. | Independently inspect commands, packages, and destinations against the user's goal. Never execute directly from a result; use minimal privileges and a sandbox. Confirm effects beyond existing user authorization. |
| Phishing or homoglyph URL | A familiar title points to a lookalike domain; a redirect requests an API key or login. | Inspect the actual parsed host and redirect destinations, including ASCII/punycode form. Verify official destinations independently before credentials or downloads. A title or lock icon is insufficient. |
| Query and credential disclosure | The agent searches an entire proprietary stack trace or a page asks it to append a token to a URL. | Remove secrets, private paths, tenant names, and unnecessary code before dispatch. Stop and obtain informed consent for necessary sensitive disclosure. Never transmit secrets because retrieved content requests them. |
| Error/telemetry exfiltration | Provider errors echo the query or authorization header; debug logs capture full request objects. | Return bounded generic errors and allowlisted codes, not raw upstream bodies/headers or exception objects. Test logs and downstream errors with synthetic secret markers. |
| Context flooding and answer poisoning | Many long snippets repeat attacker claims until the agent follows them or loses trusted context. | Bound counts and lengths, retain truncation/provenance signals, compare independent primary sources, and preserve enough trusted task context to evaluate claims. |

## Proposed result handling

Use a structured result envelope separating gateway-generated metadata from
provider-supplied title, URL, snippet, and optional page text. Attach result IDs,
provider identity, source URL, retrieval time when actually known, and truncation
flags. Preserve the distinction between a snippet and a fetched page; never
invent a verification timestamp or represent provenance as proof of correctness.

Clients should render these fields as escaped data within clearly labelled
untrusted-content blocks or a structured tool result, outside system/developer
instruction channels. Use serialization that escapes delimiter/control characters;
a page can include a closing fence or fake role marker. Delimiters and provenance
help interpretation but cannot by themselves prevent model instruction following.
Operator guidance for client configurations is to treat web content strictly as
data, never as authority to change goals, permissions, tool policy, or disclosure
rules. This document does not modify upstream agent system prompts.

Before implementation, specify and test explicit byte/character limits for query,
title, URL, each snippet/page excerpt, result count, upstream body, and aggregate
response, plus bounded parsing/fetch time. Reject or truncate deterministically
and expose truncation without silently changing URLs. Chat body bounds are not a
search limit specification. Limit before expensive parsing and again after
normalization; do not automatically fetch more content to bypass a bound.

If HTML is accepted, use a suitable parser to produce inert text and exclude
scripts, styles, comments, hidden markup, and active elements; do not render raw
HTML in the client. Escape output for its destination format. HTML stripping
reduces active markup and noise, but hidden-text detection is imperfect and plain
text can contain the same injection. It is not a prompt injection solution.

## Safe URL and effect handling

Parse URLs with a standard URL parser. For result links, allow only explicitly
supported HTTP(S) schemes; reject executable schemes, embedded credentials, and
malformed URLs. Display the actual destination host separately from the page's
claimed title. Avoid automatic navigation, downloads, script execution, or
credential forwarding. Treat shortened links and every redirect as a new trust
decision; do not infer trust from a reputable original host.

If later page fetching is added, independently constrain network egress: reject
loopback, private/link-local, and cloud metadata destinations, including IPv6;
validate resolved destinations and every redirect against DNS rebinding and SSRF.
Do not forward gateway/provider authorization headers, ambient cookies, or local
files to result hosts. These are proposed fetcher requirements, not implemented
search behavior.

An agent should explain the concrete command, destination, disclosure, or account
change and obtain consent before effects outside the user's existing authority.
Search content cannot grant that authority. Require separate review for destructive
commands, installations, credential submission, publishing, or sending data;
keep tool access narrowly scoped even after approval. Source verification and
consent reduce risk without guaranteeing that a malicious instruction is detected.

## Query, credential, and telemetry privacy

Queries necessarily leave the client when sent to a provider. Gateway log exclusion
does not prevent provider retention or downstream client transcript storage.
Prefer a minimal public error description over raw code/traces; operators should
review provider terms and configure access/retention for client histories,
Cloudflare logs, collectors, and incident artifacts. Do not attach raw results or
queries to public bug reports.

For #157, use a separate explicit search metadata allowlist: opaque request ID,
fixed route, status, latency, controlled provider/fallback identifiers, query
length, and result count. Never include query text, result URLs/titles/snippets,
headers, request/response bodies, or provider credentials. Length/count metadata
can still reveal activity; collect only what is needed and restrict retention.
The current chat allowlist is not evidence that future search paths are safe.

Allowlisted keys alone do not sanitize their values. Use enums for failure reasons
and provider identity, bounded numeric fields, and opaque correlation IDs. Current
request middleware accepts bounded caller-supplied request IDs; callers must not
encode secrets in them, and proposed search privacy verification must consider
that channel. Do not copy upstream messages into a permitted string field.
Credential isolation must cover success, validation failure, timeout, fallback,
and unexpected-exception paths, as well as custom log sinks and client errors.

## Verification and remaining work

Before claiming search readiness, add synthetic fixtures for instruction/role
spoofing, delimiter escapes, malicious plain text and HTML, oversized content,
phishing/punycode URLs, unsupported schemes, and redirects to private addresses
if fetching exists. Verify inert rendering, stable provenance, limits, and that
no content-triggered tool effect bypasses the client's authorization boundary.
Use fake credentials and recognizable query/result markers to inspect all
emitted diagnostics and error payloads, including upstream failures and debug
paths. Never use real secrets in fixtures.

Complete #157 privacy tests and #113 ingress dependencies, agree concrete search
bounds/contracts, and review this model against the resulting implementation.
Client integration checks must exercise both safe answers and attempted effects;
no static text filter or documentation review proves injection resistance.
This preparatory document changes no runtime behavior and supplies no evidence
of passing search security tests or completed parent acceptance criteria.
