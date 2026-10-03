# Nightshift MCP server

`https://nightshift-ai.studio/api/mcp` is a remote [Model Context Protocol](https://modelcontextprotocol.io)
server over **Streamable HTTP** (stateless, JSON responses), built with the
official TypeScript SDK (`@modelcontextprotocol/sdk`). It lets an AI assistant
make, follow, publish and read videos for a Nightshift workspace.

There are **two doors** into it. They are separate products with separate
billing:

| | **Connect an app (OAuth)** | **API key** |
| :-- | :-- | :-- |
| For | people using Claude, ChatGPT, Cursor, … | developers' own code and agents |
| Sign-in | the person signs in and approves on a Nightshift screen; no key is ever pasted | `Authorization: Bearer nsk_live_…` |
| Needs | a paid plan (Creator, Pro or Studio): entitlement `mcp` | the API activated (`docs/API.md`) |
| Pays with | the workspace's **site credits**, the same price and the same hold as a video made in the app | the separate **prepaid USD API balance** |
| Limit | a **monthly credit limit per connection**, set by the person on the consent screen | per-key limit, tier limits |
| Revoked | Developers → Connected apps → Disconnect (immediate) | Developers → API keys |

The API-key door is unchanged: same key, same activation, usage tier, rate
limit, prepaid USD balance, holds and database checks as `/api/v1`.

## Tools

| Tool | What it does | Costs (OAuth connection) | Costs (API key) |
| :-- | :-- | :-- | :-- |
| `list_channels` | channels (ids for create_video) | — | — |
| `create_video` | queue a video (topic, duration, …; optional `idempotency_key`) | credits held now, charged on success, released on failure; price = the app's own per-minute price with its minimum per video | USD held now, charged on success ($1.20/min, min $0.60 by default) |
| `get_job_status` | job status, error, and what it holds or was charged | credits | USD cents |
| `list_videos` | videos, newest first | — | — |
| `get_video` | one video with its publish requests | — | — |
| `list_connected_accounts` | publish targets (YouTube channels, Instagram / TikTok accounts) | — | — |
| `publish_video` | cross-post a finished video; same gate and approvals as the site; YouTube uploads private. An OAuth connection does not use an idempotency key here (it is ignored): while a post to a target is still being sent, a repeat call is answered `already_sending`, but once it has finished a new call posts again | free | free |
| `get_balance` | OAuth: credits available / held, plan, videos at once, this connection's limit and use. Key: API balance, month spend, tier | credits | USD cents |
| `request_download`, `get_download` | HD MP4 of a video | **not offered to OAuth connections** (priced in USD cents from the API balance, file served by an API-key route) | site credit price × 1.5¢ |

An OAuth connection is offered only the tools its permissions allow
(`videos:read`, `videos:create`, `videos:publish`).

### When a call is refused

Every refusal comes back as a tool error whose text is written for the person
and names the next step. The assistant can relay it; it cannot change any of
these itself:

* **not enough credits**: what the video needs, what the workspace has
  available and what is set aside for videos in progress, a link to add
  credits (`/credits`) and one to choose a plan with more (`/pricing`). After
  the person buys credits or upgrades, **the same connection works on the very
  next call**: nothing needs to be connected again (credits and plan are read
  live on every call).
* **the connection's monthly limit**: its limit and use, and that only the
  person can raise it in Developers → Connected apps (`/developers`).
* **the plan's videos-at-once limit**: wait about a minute, or choose a plan
  that runs more at once.
* **no paid plan** (`subscription_required`): the connection is *paused*, not
  deleted. Choose a plan and it works again with no reconnecting. Free
  workspaces cannot approve a connection at all.

A video that cannot be paid for is refused **before** any work starts: nothing
is held, queued or produced. A job already running is never stopped by a later
limit; only new holds are refused.

## Connecting a client

Use the server URL **`https://nightshift-ai.studio/api/mcp`**. A client that
speaks the MCP authorization flow discovers everything else itself
(`/.well-known/oauth-protected-resource/api/mcp`,
`/.well-known/oauth-authorization-server`), registers, and opens a browser to
Nightshift's consent screen.

### claude.ai (Custom Connectors) and Claude Desktop

1. **Settings → Connectors → Add custom connector**.
2. Name: `Nightshift`. URL: `https://nightshift-ai.studio/api/mcp`. Leave any
   OAuth client ID / secret fields **empty** (the server registers the app
   itself). Add.
3. Press **Connect**. A Nightshift page opens: sign in if asked, check the app
   name and the address it names, choose the monthly credit limit (default 500,
   up to 20 000; 0 means read-only), **Allow**.
4. In a conversation, enable the Nightshift connector for it and ask for a
   video. Claude Desktop uses the same account-level connectors list.

(Where your Claude plan offers custom connectors. On Team/Enterprise an
organization administrator may need to add the connector first.)

### ChatGPT (developer mode)

1. **Settings → Connectors → Advanced → Developer mode** on (where your
   ChatGPT plan offers it).
2. **Create** a connector. Name: `Nightshift`. MCP server URL:
   `https://nightshift-ai.studio/api/mcp`. Authentication: **OAuth**. If it
   asks for a client ID / secret, leave them empty.
3. Create, then **Connect** and approve on the Nightshift page as above.
4. In a chat, choose the connector from the tools menu.

### Claude Code

```bash
claude mcp add --transport http nightshift https://nightshift-ai.studio/api/mcp
```

then run `/mcp`, pick `nightshift` and **Authenticate**: the browser opens on
the consent screen (the callback is a `http://localhost:<port>` address).

### Cursor, VS Code, Windsurf, Gemini CLI, Codex CLI, OpenClaw, Hermes, …

Add Nightshift as a **remote (HTTP) MCP server** with just the URL, with **no
`Authorization` header**; the client starts the OAuth flow itself.

* Cursor, `~/.cursor/mcp.json`: `{ "mcpServers": { "nightshift": { "url": "https://nightshift-ai.studio/api/mcp" } } }`
* VS Code, `.vscode/mcp.json`: `{ "servers": { "nightshift": { "type": "http", "url": "https://nightshift-ai.studio/api/mcp" } } }`
* Any other client that supports the MCP authorization specification works the
  same way; use its "add remote MCP server" command.

We run the official MCP SDK client against this server in a real end-to-end
test (below). We have **not** tested each product above ourselves: they differ
in menu names and in which of the permitted redirect addresses they use
(`https://` callbacks, `http://localhost`, `127.0.0.1`, `[::1]`, and Cursor's
own `cursor://anysphere.cursor-retrieval/oauth/…`).

### With an API key (unchanged)

Create a key in **Developers → API keys** (after activating the API). Treat it
like a password: a client holding it can spend your API balance.

```bash
claude mcp add --transport http nightshift https://nightshift-ai.studio/api/mcp \
  --header "Authorization: Bearer nsk_live_…"
```

Cursor: `{ "mcpServers": { "nightshift": { "url": "https://nightshift-ai.studio/api/mcp", "headers": { "Authorization": "Bearer nsk_live_…" } } } }`.

For a client with no browser flow and no way to send a header, the
`mcp-remote` bridge adds the header locally:

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

## What the person controls

**Developers → Connected apps** lists every connection: the app's name and the
address it returns to, when it was connected and last used, its monthly limit
and what it spent this month, and a **Disconnect** button (and Disconnect
all). The limit can be raised or lowered there; the assistant has no tool for
it. A connection whose plan lapsed shows **Paused: a paid plan is required**.
Deleting the account removes every connection with it.

## How it works (MCP authorization, spec 2026-07-28)

Nightshift is its own authorization server for its MCP resource.

* `/api/mcp` answers a request with no valid credential with `401` and
  `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp", scope="videos:read videos:create videos:publish"`
  (RFC 9728). A bad `nsk_live_` key keeps its old answer.
* Discovery: `/.well-known/oauth-protected-resource` (+ `/api/mcp`),
  `/.well-known/oauth-authorization-server` (+ `/api/mcp`),
  `/.well-known/openid-configuration` (+ `/api/mcp`, same document; this is not
  an OpenID provider). Exactly these names are public.
* **Registration** (RFC 7591) `POST /oauth/register`: public clients only, PKCE
  required. No secret is ever issued: a client that asks for
  `client_secret_post` / `client_secret_basic` is registered as the public
  client it will be and the answer says `token_endpoint_auth_method: none`;
  methods needing a key or certificate are refused. Redirect URIs: `https`
  with a real lower-case DNS name, or `http` on `localhost` / `127.0.0.1` /
  `[::1]`; plus Cursor's one private-use callback. No fragment, userinfo,
  wildcard, `javascript:`, `data:` or other custom scheme. Bounded: 5 URIs, a name of 1 to 80 visible
  characters that may not contain "Nightshift" (checked after Unicode folding, lookalike and
  leet folding in several scripts, with invisible and direction characters removed), 10 registrations per address and 300 in total per hour, 20 000
  rows; an app nobody ever approves is deleted after a day. Client ID Metadata
  Documents are **not** implemented (they need SSRF-safe fetching of a
  client-supplied URL); the metadata says `client_id_metadata_document_supported: false`.
* **Authorize** `/oauth/authorize`: signed out goes to `/login` and comes back to
  the same request (only that exact page is an allowed return path). The app
  and the redirect URI are checked against the registration **exactly**; until
  they match nothing is redirected. The consent screen shows the app's name
  *together with the host it will return to*, the workspace, the exact
  permissions and a mandatory monthly credit limit (default 500, maximum
  20 000, whole credits). A Free workspace sees "needs a paid plan" and no code
  can exist. Allow/Deny is a same-origin JSON POST with a single-use secret
  bound to that person, `Origin` and `Sec-Fetch-Site` checks, and the page is
  never framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). The answer
  carries `code`, `state` and `iss` (RFC 9207).
* **Token** `POST /oauth/token`: `authorization_code` (PKCE `S256` only; the
  code lives 60 seconds, is single-use, and is bound to client, redirect URI,
  challenge, person and resource; a replay revokes what the first use made) and
  `refresh_token` (**rotating**; presenting a spent one revokes the whole
  connection). Access tokens last 1 hour; refresh tokens 30 days sliding with a
  90-day absolute cap. Tokens are opaque 256-bit values; only their SHA-256 is
  stored; they are never logged; every answer is `Cache-Control: no-store`.
  `resource` (RFC 8707) must be the MCP server URL and the MCP endpoint accepts
  only tokens issued for it.
* **Revoke** `POST /oauth/revoke` (RFC 7009): either token ends the connection.
* **Scopes**: `videos:read`, `videos:create`, `videos:publish`. Unknown words in
  a request are ignored; an empty request means all three.

### Plans and billing

`mcp` is an entitlement of the plan (migration 0093 makes it *enforced*):
Creator, Pro and Studio have it, Free does not, and a workspace that only
bought credit packs is on the Free plan and is **not** entitled. It is one row
per plan in `plan_entitlements`; the operator's own organization is exempt.
It is checked at the consent screen, at the token and refresh endpoints and on
**every call**. A connection spends the workspace's credits through
`reserve_credits()` and the `render_jobs` payment guard exactly as a video made
in the app, capped per connection under the credit account's row lock so
concurrent calls cannot exceed the limit. An unpriced video is refused, never
free. An OAuth token cannot reach any prepaid-USD function, even by calling
the database directly: `api_begin` hands a hash that is not an API key to
`oauth_ctx`, which allows a fixed list of endpoints.

## Implementation

* `supabase/migrations/0093_mcp_oauth.sql` — tables (clients, consent requests,
  grants, codes, tokens, runs, rate counters: RLS on, no grants to any API
  role), `oauth_*` security-definer functions, the entitlement flip, the audit
  actions, and `api_begin` = 0062's body plus one branch.
* `command-center/app/api/mcp/route.ts` — POST/GET/DELETE. A `nsk_live_` key goes
  the old way; an `nso_at_…` token is checked with `oauth_check`, its resource
  and scopes validated, and a server built with only the tools it may use.
* `command-center/lib/api/mcp.ts`, `lib/api/mcp-oauth.ts` — the tools, the
  OAuth routing (allow-listed database functions) and the refusal texts.
* `command-center/lib/oauth/*`, `app/oauth/*`, `app/.well-known/*` — metadata,
  registration, token, revocation, the consent page and its decision endpoint.
* `/api/mcp`, the `.well-known` names and `/oauth/{register,token,revoke}` are exempt
  from the cookie middleware by EXACT path (`lib/public-paths.ts`);
  `/oauth/authorize` and `/oauth/decision` are not.
* Tests: `command-center/tests/{oauth-*,mcp-oauth-*}.test.ts`,
  `tests/test_mcp_oauth_migration.py`, the Postgres lab
  `tests/security/test_sec_mcp_oauth.py` (no table access, hostile redirect
  URIs, code double-spend, refresh race, registration floods, the spend limit
  under concurrency, cross-tenant, entitlement, replay-twice), and the
  end-to-end rig `tests/oauth_e2e/run.sh`: the **official MCP SDK client** does
  discovery, registration, PKCE, consent, token, tools, refresh and revoke
  against the real Command Center and a Postgres built from the migrations.
