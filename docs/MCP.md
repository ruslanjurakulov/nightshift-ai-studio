# Nightshift MCP server

`https://<your domain>/api/mcp` is a remote [Model Context Protocol](https://modelcontextprotocol.io)
server over **Streamable HTTP** (stateless, JSON responses), built with the
official TypeScript SDK (`@modelcontextprotocol/sdk`). It lets an AI assistant
make, follow, publish and download videos for your organization.

It is the public API (`docs/API.md`) behind a different door: the **same API
key** (`Authorization: Bearer nsk_live_…`), the same activation, usage tier,
per-minute rate limit, prepaid balance, holds and database checks. Every tool
call is one API request; the handshake (`initialize`, `tools/list`) is checked
and counted once through `api_auth`, so a revoked key or an organization that
has not activated the API is refused before any tool is listed.

## Tools

| Tool | What it does | Costs |
| :-- | :-- | :-- |
| `list_channels` | channels (ids for create_video) | — |
| `create_video` | queue a video (topic, duration, …; optional `idempotency_key`) | held now, charged on success ($1.20/min, min $0.60 by default) |
| `get_job_status` | job status, error, charge | — |
| `list_videos` | videos, newest first | — |
| `get_video` | one video with its publish requests | — |
| `list_connected_accounts` | publish targets (YouTube channels, Instagram / TikTok accounts) | — |
| `publish_video` | cross-post a finished video; same gate and approvals as the site; YouTube uploads private | free |
| `request_download` | order a 720p / 1080p MP4 | site credit price × 1.5¢, charged when ready |
| `get_download` | download status and `file_url` | — |
| `get_balance` | API balance, month spend, tier | — |

A refused call comes back as a tool error whose text is the API's error
envelope (`{"error": {"type", "code", "message", "request_id", …}}`), so the
assistant can tell "top up" (`insufficient_balance`) from "wait"
(`rate_limit_exceeded`, with `retry_after`).

## Connecting a client

The customer-facing version of this section is the public page **/mcp** (snippets for
eleven assistants, each checked against that assistant's own documentation:
see `command-center/lib/dev/mcp-clients.ts`).

`/mcp` has one tab per assistant (Claude, ChatGPT, Claude Code, OpenClaw, Cursor and Hermes first, then the rest),
each with three numbered steps. Whether it shows the sign-in (OAuth) flow or only API-key steps is decided by the
environment flag `MCP_OAUTH_LIVE` (literal `1` = on, read at request time; `deploy/.env.web.example`,
`lib/mcp-oauth.ts`). Leave it off until the server's OAuth is merged, deployed and tested with a real connector: while
it is off the Claude and ChatGPT tabs say "Coming soon" and every other tab shows its API-key steps.

Create a key in **Developers → API keys** (owner/admin, after activating the
API). Treat it like a password: a client holding it can spend your API balance.

### Claude Code — supported (custom header)

```bash
claude mcp add --transport http nightshift https://nightshift-ai.studio/api/mcp \
  --header "Authorization: Bearer nsk_live_…"
```

### Cursor — supported (custom header)

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "nightshift": {
      "url": "https://nightshift-ai.studio/api/mcp",
      "headers": { "Authorization": "Bearer nsk_live_…" }
    }
  }
}
```

### Claude Desktop — through a local bridge

Claude Desktop's and claude.ai's **custom connectors** take a URL and
authenticate with **OAuth** (or none); they do not let you type a static
`Authorization` header. This server uses API keys, not OAuth, so a custom
connector cannot connect to it directly. Use the `mcp-remote` bridge in
`claude_desktop_config.json` (Settings → Developer → Edit config), which runs
locally and adds the header:

```json
{
  "mcpServers": {
    "nightshift": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://nightshift-ai.studio/api/mcp",
               "--header", "Authorization:${NIGHTSHIFT_AUTH}"],
      "env": { "NIGHTSHIFT_AUTH": "Bearer nsk_live_…" }
    }
  }
}
```

(Requires Node.js on that computer. The key sits in that local file.)

### ChatGPT — not supported yet

ChatGPT's connectors for remote MCP servers (developer mode) authenticate
with OAuth or no authentication; they cannot send an API-key header. Until
this server offers OAuth, ChatGPT cannot connect to it. Use the REST API
(`/docs/api`) from your own code instead.

### Anything else

Any MCP client that speaks Streamable HTTP and can send a custom header works
the same way: URL `…/api/mcp`, header `Authorization: Bearer nsk_live_…`.

## Implementation

* `command-center/app/api/mcp/route.ts` — POST/GET/DELETE; authenticates the
  key (format check, then the database), builds a fresh `McpServer` and a
  `WebStandardStreamableHTTPServerTransport` (`sessionIdGenerator: undefined`,
  JSON responses) per request.
* `command-center/lib/api/mcp.ts` — the tools: zod input schemas, descriptions,
  annotations; each is one call into `lib/api/operations.ts`, the same code the
  REST routes use.
* `/api/mcp` is exempt from the cookie middleware by exact path
  (`lib/public-paths.ts`); `/api/mcp/x` and `/api/mcpx` are not.
* Tests: `command-center/tests/api-mcp.test.ts` (auth refusal, handshake
  check, tool listing, each tool → its 0031 function, errors as tool errors).
