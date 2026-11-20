# MCP Client Integration Guide

> [!IMPORTANT]
> **Target Specification Notice**: This document specifies the client integration contract for the Model Context Protocol (MCP) search server (`POST /mcp` Streamable HTTP and `GET /sse` Server-Sent Events transports exposing the `web_search` tool under Story #150, Tasks #151-#152, and Search Ingress Story #113). On `main`, the active runtime currently serves the Chat Completions MVP routes (`POST /v1/chat/completions`, `POST /chat/completions`, `GET /v1/models`, and `GET /health`). The `/mcp` and `/sse` routes documented below become active once the MCP server and search ingress tasks merge.

This guide provides step-by-step instructions and copy-pasteable configuration templates for registering `shunt-shim` as a remote MCP search server in terminal AI coding assistants:

1. **Antigravity CLI (`agy-cli`)** (`mcp_config.json`)
2. **Claude Code** (`claude mcp add` CLI and `.mcp.json` / `~/.claude.json`)
3. **OpenCode** (`~/.config/opencode/opencode.json` and project `opencode.json`)
4. **OpenAI Codex CLI** (`~/.codex/config.toml`)

---

## 1. Route Topology: Active MVP vs. Target MCP Routes

| Route | HTTP Method | Protocol / Transport | Status on `main` | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `/health` | `GET` | REST JSON | Active (MVP) | Unauthenticated liveness check |
| `/v1/models` | `GET` | OpenAI REST JSON | Active (MVP) | Lists virtual model alias catalog (`fast`) |
| `/v1/chat/completions`, `/chat/completions` | `POST` | OpenAI REST JSON | Active (MVP) | Non-streaming chat completions and function tool calls |
| `/v1/search` | `POST` | Search REST JSON | Planned (#113) | Direct authenticated JSON search endpoint |
| `/mcp` | `POST` | MCP Streamable HTTP (JSON-RPC 2.0) | Planned (#150, #152) | Stateless JSON-RPC 2.0 MCP transport (`initialize`, `tools/list`, `tools/call`) |
| `/sse` | `GET` | MCP Server-Sent Events (SSE) | Planned (#150, #152) | Persistent SSE stream for MCP clients requiring SSE transport |

---

## 2. Authentication and Credential Hygiene

Every MCP route (`/mcp` and `/sse`) enforces the same gateway authentication contract as the rest of `shunt-shim` (see [docs/CONFIGURATION.md](CONFIGURATION.md) and [docs/COMPATIBILITY.md](COMPATIBILITY.md)):

- **Single Gateway Secret (`GATEWAY_TOKENS`)**: Clients authenticate to `shunt-shim` using the gateway secret configured in the Worker's `GATEWAY_TOKENS` binding.
- **Accepted Request Headers**:
  - `Authorization: Bearer <gateway-secret>` (recommended for all MCP clients)
  - `x-api-key: <gateway-secret>`
  - If a client sends both headers, both values must match `GATEWAY_TOKENS`; conflicting or missing credentials return HTTP `401 Unauthorized`.
- **Upstream Search and LLM Keys Stay on the Worker**: Upstream provider credentials (`TAVILY_API_KEY`, `EXA_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`) live exclusively in local `.dev.vars` (untracked) or Cloudflare Worker secrets (`wrangler secret put`). Never place upstream provider API keys in client MCP configuration files.
- **Zero Plaintext Secrets in Dotfiles or Repositories**: Export your gateway token from your shell profile, system keychain, or an untracked `.envrc` file as `SHUNT_SHIM_TOKEN`, and reference that environment variable from your MCP client configuration:

```bash
# Generate a 32-byte hex secret if provisioning a new gateway instance
just generate-token

# Export in your shell session or untracked local environment script
export SHUNT_SHIM_URL="https://shunt-shim.<your-subdomain>.workers.dev"
export SHUNT_SHIM_TOKEN="<your-gateway-secret>"
```

---

## 3. Client Configuration Guides

Replace `https://shunt-shim.<your-subdomain>.workers.dev` with `http://127.0.0.1:8787` when testing against a local `just dev` (`wrangler dev`) instance.

### 3.1 Antigravity CLI (`agy-cli`)

`agy-cli` reads remote MCP server definitions from `~/.gemini/config/mcp_config.json` (global) or `<workspace>/.agents/mcp_config.json` (workspace). Remote servers use `serverUrl` (prefer Streamable HTTP `/mcp`; the `httpUrl` field is legacy, and whether `/sse` URLs work under `serverUrl` is unverified here).

#### Streamable HTTP (`/mcp`)

```json
{
  "mcpServers": {
    "shunt-shim": {
      "serverUrl": "https://shunt-shim.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${SHUNT_SHIM_TOKEN}"
      }
    }
  }
}
```

### 3.2 Claude Code

Claude Code supports remote HTTP and SSE MCP servers via the `claude mcp add` CLI or declarative JSON configuration in `~/.claude.json` (user scope) and `.mcp.json` (project scope).

#### Option A: Register via CLI (user scope, recommended)

Single-quote the `--header` argument so the shell passes the literal `${SHUNT_SHIM_TOKEN}` reference to Claude Code instead of expanding the secret in plaintext into `~/.claude.json` (Claude Code expands `${SHUNT_SHIM_TOKEN}` at runtime when exported in your shell):

```bash
claude mcp add --transport http --scope user shunt-shim \
  "https://shunt-shim.<your-subdomain>.workers.dev/mcp" \
  --header 'Authorization: Bearer ${SHUNT_SHIM_TOKEN}'
```

To use the SSE transport instead:

```bash
claude mcp add --transport sse --scope user shunt-shim \
  "https://shunt-shim.<your-subdomain>.workers.dev/sse" \
  --header 'Authorization: Bearer ${SHUNT_SHIM_TOKEN}'
```

Verify registration in Claude Code:

```bash
claude mcp list
claude mcp get shunt-shim
```

#### Option B: Declarative `.mcp.json` / `~/.claude.json`

Claude Code expands `${VAR}` environment variable references inside `.mcp.json` and `~/.claude.json` so `.mcp.json` can be safely committed without secrets:

```json
{
  "mcpServers": {
    "shunt-shim": {
      "type": "http",
      "url": "https://shunt-shim.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${SHUNT_SHIM_TOKEN}"
      }
    }
  }
}
```

### 3.3 OpenCode

OpenCode configures MCP servers in `~/.config/opencode/opencode.json` (global) or `./opencode.json` (workspace root).

#### Current OpenCode schema (`mcp` remote block with `{env:VAR}` interpolation)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "shunt-shim": {
      "type": "remote",
      "url": "https://shunt-shim.<your-subdomain>.workers.dev/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer {env:SHUNT_SHIM_TOKEN}"
      }
    }
  }
}
```

#### Legacy / MCP-standard `mcpServers` block (`opencode.json`)

For OpenCode versions or compatibility loaders that read the `mcpServers` object:

```json
{
  "mcpServers": {
    "shunt-shim": {
      "type": "remote",
      "url": "https://shunt-shim.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${SHUNT_SHIM_TOKEN}"
      }
    }
  }
}
```

### 3.4 OpenAI Codex CLI

Codex CLI reads MCP server definitions from `~/.codex/config.toml`. Use `bearer_token_env_var` so Codex reads the gateway secret directly from the `SHUNT_SHIM_TOKEN` environment variable at runtime without storing the token in `config.toml`:

```toml
[mcp_servers.shunt_shim]
url = "https://shunt-shim.<your-subdomain>.workers.dev/mcp"
bearer_token_env_var = "SHUNT_SHIM_TOKEN"
startup_timeout_sec = 10
tool_timeout_sec = 30
enabled = true
```

If your Codex CLI version uses explicit HTTP headers instead of `bearer_token_env_var`, use `env_http_headers`:

```toml
[mcp_servers.shunt_shim]
url = "https://shunt-shim.<your-subdomain>.workers.dev/mcp"
env_http_headers = { "Authorization" = "SHUNT_SHIM_TOKEN_BEARER" }
```

*(When using `env_http_headers`, export `SHUNT_SHIM_TOKEN_BEARER="Bearer ${SHUNT_SHIM_TOKEN}"` in your shell; prefer `bearer_token_env_var = "SHUNT_SHIM_TOKEN"` whenever supported.)*

---

## 4. `web_search` MCP Tool Contract

The MCP server implements the Model Context Protocol `2024-11-05` specification and registers a single tool named `web_search` (defined in Story #150 / Task #151 and backed by the search validation bounds from Task #116).

### 4.1 Tool Definition (`tools/list`)

```json
{
  "name": "web_search",
  "description": "Search the web for technical documentation, GitHub repositories, and coding solutions using aggregated free-tier search engines.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search query string (1 to 500 characters).",
        "minLength": 1,
        "maxLength": 500
      },
      "max_results": {
        "type": "integer",
        "description": "Maximum number of search results to return (1 to 20, default 10).",
        "minimum": 1,
        "maximum": 20,
        "default": 10
      },
      "domains": {
        "type": "array",
        "description": "Optional allowlist of domain hostnames to restrict search results (up to 20 entries).",
        "items": {
          "type": "string"
        },
        "maxItems": 20
      }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}
```

### 4.2 Input Parameter Bounds

| Parameter | Type | Required | Default | Constraints |
| :--- | :--- | :--- | :--- | :--- |
| `query` | `string` | Yes | None | Non-empty string after trimming; `1..500` characters |
| `max_results` | `integer` | No | `10` | Integer between `1` and `20` inclusive |
| `domains` | `string[]` | No | `[]` | Array of up to `20` valid domain hostnames (for example, `["developers.cloudflare.com", "github.com"]`) |

### 4.3 Structured Output Format (`tools/call`)

Successful `web_search` invocations return an MCP `CallToolResult` containing a `text` content block formatted as a numbered Markdown list for straightforward citation by coding agents:

```markdown
1. [Cloudflare Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
   Documentation for outbound HTTP requests and AbortController signals in Cloudflare Workers.

2. [Hono Middleware Guide](https://hono.dev/docs/guides/middleware)
   Writing custom authentication and validation middleware in Hono.
```

- **Empty result set**: Returns a non-error text content block containing `"No results found"` for the supplied query.
- **Tool execution failure**: Returns a structured MCP tool error response (`"isError": true` inside `result`) with a sanitized error description so the coding agent session remains connected and can adjust its query.
- **Protocol-level failure**: Malformed JSON payloads or invalid JSON-RPC envelopes return standard JSON-RPC 2.0 error codes (`-32700` Parse error, `-32600` Invalid Request, `-32601` Method not found, or `-32602` Invalid params).

---

## 5. Local Testing (`just dev` / `wrangler dev`) and Deployed Verification

### 5.1 Local Development Server Setup

1. Ensure `.dev.vars` exists and defines `GATEWAY_TOKENS` (plus upstream search provider keys once search adapters are configured):

```bash
cp .env.example .dev.vars
# Edit .dev.vars and set GATEWAY_TOKENS="<your-local-gateway-secret>"
```

2. Start the local Cloudflare Worker emulator:

```bash
just dev
# Equivalent to: pnpm exec wrangler dev
```

3. In another terminal, export your target base URL and token:

```bash
export SHUNT_SHIM_URL="http://127.0.0.1:8787"
export SHUNT_SHIM_TOKEN="<your-local-gateway-secret>"
```

4. Verify basic Worker liveness on `/health`:

```bash
curl --fail --silent "${SHUNT_SHIM_URL}/health"
```

Expected response:

```json
{"status":"ok","service":"shunt-shim"}
```

### 5.2 JSON-RPC 2.0 Smoke Tests Against `/mcp`

Once the MCP transport routes (`POST /mcp` and `GET /sse`, Story #150 / Task #152) are active in your environment, run the three standard MCP lifecycle requests below. To test a production deployment instead of `just dev`, set `SHUNT_SHIM_URL="https://shunt-shim.<your-subdomain>.workers.dev"`.

#### Step 1: `initialize` Handshake

```bash
curl --fail --silent --show-error \
  -X POST "${SHUNT_SHIM_URL}/mcp" \
  -H "Authorization: Bearer ${SHUNT_SHIM_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {
        "name": "smoke-test-client",
        "version": "1.0.0"
      }
    }
  }'
```

Expected response envelope:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": {}
    },
    "serverInfo": {
      "name": "shunt-shim",
      "version": "0.1.0"
    }
  }
}
```

#### Step 2: `tools/list` Discovery

```bash
curl --fail --silent --show-error \
  -X POST "${SHUNT_SHIM_URL}/mcp" \
  -H "Authorization: Bearer ${SHUNT_SHIM_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'
```

Expected response envelope:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "web_search",
        "description": "Search the web for technical documentation, GitHub repositories, and coding solutions using aggregated free-tier search engines.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "minLength": 1,
              "maxLength": 500
            },
            "max_results": {
              "type": "integer",
              "minimum": 1,
              "maximum": 20,
              "default": 10
            },
            "domains": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "maxItems": 20
            }
          },
          "required": ["query"]
        }
      }
    ]
  }
}
```

#### Step 3: `tools/call` Invoking `web_search`

```bash
curl --fail --silent --show-error \
  -X POST "${SHUNT_SHIM_URL}/mcp" \
  -H "Authorization: Bearer ${SHUNT_SHIM_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "web_search",
      "arguments": {
        "query": "Cloudflare Workers AbortController request signal",
        "max_results": 3,
        "domains": ["developers.cloudflare.com"]
      }
    }
  }'
```

Expected response envelope:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "1. [Cloudflare Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/)\n   Documentation for outbound HTTP requests and AbortController signals in Cloudflare Workers."
      }
    ],
    "isError": false
  }
}
```

#### Step 4: Verify Authentication Rejection (`401 Unauthorized`)

Confirm that unauthenticated MCP requests are rejected before JSON-RPC dispatch:

```bash
curl --silent --output /dev/null --write-out "%{http_code}\n" \
  -X POST "${SHUNT_SHIM_URL}/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Expected HTTP status code: `401`.

---

## Evidence and Limitations

Checked on 2026-11-19 through Context7 (indexed official documentation and source). "Verified" means the Context7 result quoted the documented key or command. I could not install or run any of the four clients, so none of the snippets was executed against a live server.

| Client | Verified | Not verified |
| :--- | :--- | :--- |
| Antigravity CLI (`agy-cli`), docs at antigravity.google/docs/settings and /docs/cli/gcli-migration | Global `~/.gemini/config/mcp_config.json` and workspace `.agents/mcp_config.json` paths; `serverUrl` is the current remote URL key | The `headers` field and `${SHUNT_SHIM_TOKEN}` interpolation (the documented example uses `env`); whether `/sse` URLs work under `serverUrl` (the migration page shows an `/sse` URL under `serverUrl`) |
| Claude Code, docs at code.claude.com/docs/en/mcp (Context7 `/websites/code_claude`) | `claude mcp add --transport http <name> <url> --header "Authorization: Bearer ..."`; `${VAR}` expansion in `.mcp.json` `url` and `headers`; `type: "http"` | `${VAR}` expansion for values passed to `--header` or stored in `~/.claude.json`; the SSE transport is documented as deprecated, so prefer `/mcp` |
| OpenCode, docs at opencode.ai/docs/mcp-servers and /docs/config (Context7 `/websites/opencode_ai`) | `type: "remote"`, `url`, `headers`, and `{env:VAR}` substitution (unset variables become an empty string) | `enabled: true` (the published schema lists `disabled`); the legacy `mcpServers` compatibility block and its `${VAR}` syntax (not found in the current OpenCode docs) |
| OpenAI Codex CLI, source at openai/codex `codex-rs/config` (Context7 `/openai/codex`, latest indexed tag `rust-v0.165.0`) | `[mcp_servers.<name>]` with `url`, `bearer_token_env_var`, `env_http_headers` (value is the environment variable name), `startup_timeout_sec`, `tool_timeout_sec`, `enabled` | Behavior of the specific version a reader has installed |

The `/mcp` and `/sse` smoke tests in section 5.2, and every client registration against this gateway, are unverifiable today: `main` has no MCP transport and no `/v1/search` ingress. The request and response envelopes shown are the intended contract.

## Next Action

Once the MCP transport (#152) and search ingress (#113) land, run section 5.2 against `just dev` and a deployed Worker, register each of the four clients, and correct or delete every snippet in the Not verified column. That check is recorded as an acceptance item on #152; #154 stays open until it passes. No new issue is needed.
