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
| Needs | any plan, Free included (migration 0147); what it can make is limited by the workspace's credits | the API activated (`docs/API.md`) |
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
| `get_job_status` | job status, error, what it holds or was charged, and the video_id it made (null until recorded) | credits | USD cents |
| `list_videos` | videos, newest first (uploaded or held) | — | — |
| `get_video` | one video with its publish requests | — | — |
| `list_connected_accounts` | publish targets (YouTube channels, Instagram / TikTok accounts) | — | — |
| `publish_video` | cross-post a finished video; same gate and approvals as the site; YouTube uploads private. An OAuth connection's schema has **no** `idempotency_key` (one sent anyway is refused as an unknown field): while a post to a target is still being sent, a repeat call is refused and the text says that target is already being sent, but once it has finished a new call posts again, and the tool's description says so. An API key keeps its optional `idempotency_key` | free | free |
| `get_balance` | OAuth ("Get credit balance"): credits available / held, plan, videos at once, this connection's limit and use. Key ("Get API balance"): API balance, month spend, tier | credits | USD cents |
| `list_models` | the Studio models this organization can generate with (optional `capability`), with shapes, durations and resolutions; no price (0162 `api_creative_models`) | **not offered to OAuth connections** | free; scope `creative:quote` |
| `quote_generation` | the price in credits of one exact generation; nothing is held (0062 `api_creative_quote`) | **not offered** | free; scope `creative:quote` |
| `create_generation` | start one picture, clip or voice-over; `max_credits` and `idempotency_key` are required (0062 `api_creative_create`) | **not offered** | the organization's **credits**, held at the quote, charged on success, released on failure, refused above `max_credits` or past the key's monthly credit limit; scope `creative:create` |
| `get_generation` | a generation this key started, with an expiring signed link to each result file (0162 `api_creative_job_files`) | **not offered** | free; scope `creative:read` |
| `request_download`, `get_download` | HD MP4 of a video | **not offered to OAuth connections** (priced in USD cents from the API balance, file served by an API-key route) | site credit price × the `api_prices` row with `unit = 'download_cents_per_credit'` (1.5¢ by default); the order's answer carries the price (`price_cents`), and no tool text states a rate |
| `list_creative_models` | the Studio models offered to connected apps (optional `capability`): only a model whose registry spec has `mcp_oauth_exposure: true`, which only Recraft V4.1 / V4.1 Flash have (after their probe, price and beta); an empty list says so (0191 `oauth_creative_models`) | free; permission `studio:create` | **not offered to API keys** (they have `list_models`) |
| `list_media` | the workspace's own media library (optional `kind`, `limit`), the ids an edit or i2v takes as `source_asset_id` (0191 `oauth_media_list`); no URL fetching | free; `studio:create` | **not offered** |
| `quote_creative` | the price of one exact generation as `creative_price` computes it, kept for this connection 15 minutes as a `quote_id` (0191 `oauth_creative_quote`) | free; `studio:create` | **not offered** |
| `create_creative` | start the generation a quote priced: takes only `quote_id` and a required `idempotency_key`; refuses an expired, used or other connection's quote and a moved price (`price_changed`) (0191 `oauth_creative_create`) | the workspace's **credits**, held at exactly the quote, charged on success, refunded on failure, never past the connection's monthly limit; `studio:create` | **not offered** |
| `get_creative_job` | a generation this connection started; once completed, absolute signed file links that expire after a few minutes (0191 `oauth_creative_get`) | free; `studio:create` | **not offered** |

An OAuth connection is offered only the tools its permissions allow
(`videos:read`, `videos:create`, `videos:publish`, and since 0191 `studio:create` for the
five Studio tools above: a connection that allowed "make videos" was never asked about
anything else, so it does not gain them), and the server's
instructions name only those tools (a read-only connection is told it cannot
create or publish, and that the person can reconnect it allowing that). A call
to a connection tool the grant lacks (an assistant that remembers
`create_video` from the docs) is not "tool not found": it is answered with the
permission it needs and where the person reconnects (Developers → Connected
apps), and reaches nothing. The paid-download tools stay unknown to every
connection.

Every tool that takes arguments refuses one it does not know, naming it
(`list_videos({ channel })` used to be answered with every channel's videos).
A tool whose database call throws answers the generic "could not complete this
request" with the request id; it never says nothing happened (that is not
known), and the server log names only the error's class, never its message.

### When a call is refused

Every refusal comes back as a tool error whose text is written for the person
and names the next step. The assistant can relay it; it cannot change any of
these itself:

* **not enough credits**: what the video needs, what the workspace has
  available and what is set aside for videos in progress, a link to add
  credits (`/credits`) and one to choose a plan with more (`/pricing`). After
  the person buys credits or upgrades, **the same connection works on the very
  next call**: nothing needs to be connected again (credits and plan are read
  live on every call). This is the only thing standing between a Free workspace
  and a video: welcome credits, top-up packs and plan credits all count.
* **the connection's monthly limit**: its limit and use, and that only the
  person can raise it in Developers → Connected apps (`/developers`).
* **the plan's videos-at-once limit**: wait about a minute, or choose a plan
  that runs more at once.
* **the plan does not include it** (`subscription_required`): since 0147 no
  plan pauses a connection and the database never answers this. A database
  without 0147 (or after its rollback) still can: the connection is *paused*,
  not deleted, and works again with no reconnecting once the plan includes it.
* **a missing permission** (`insufficient_scope`): which one, and that the
  person disconnects the app in Developers → Connected apps (`/developers`)
  and connects it again, allowing it.
* **a publish no target took** (`publish_refused`): each target with its
  reason: already being sent (nothing to do; a later repeat would post again),
  or not a publish target this connection can use.

A video that cannot be paid for is refused **before** any work starts: nothing
is held, queued or produced. A job already running is never stopped by a later
limit; only new holds are refused.

## Connecting a client

The customer-facing version of this section is the public page **/mcp**, and
Developers → Connected apps repeats its buttons. Since 2026-11-13 (the owner's
decision) both name exactly **six assistants, in this order: ChatGPT, Claude,
Gemini, Grok, Cursor, VS Code (GitHub Copilot)**, each checked against its own
documentation (`command-center/lib/dev/mcp-clients.ts` cites the pages). No other
client has a tab, a button or a logo there. The server itself is standard, so
another client that speaks the MCP authorization flow (Claude Code, for one) can
still connect on its own; see "Other clients" below.

`/mcp` has one tab per assistant, each with three numbered steps. Whether it shows the sign-in (OAuth) flow or only
API-key steps is decided by the environment flag `MCP_OAUTH_LIVE` (literal `1` = on, read at request time;
`deploy/.env.web.example`, `lib/mcp-oauth.ts`). Leave it off until the server's OAuth is merged, deployed and tested
with a real connector: while it is off the four sign-in-only tabs (ChatGPT, Claude, Gemini, Grok) say "Coming soon",
Cursor and VS Code show their API-key steps, and no "Add to …" button is drawn on /mcp or in Developers → Connected
apps. With it on, the ChatGPT and Claude tabs carry a "Ready to connect" line (`lib/dev/mcp-availability.ts`, below) until the
owner records a real connection there. The flag decides only what the page says: the server's sign-in answers whether it is on
or off, so a person (the owner first) can add the connector in ChatGPT or Claude by hand before the page offers it.

Under the connect card `/mcp` is one long page, the same on every tab except the assistant's name: how it works,
ready-to-copy asks, six capability rows (video, channels, language and voice, approval, credits and limits, a list of topics in one ask),
a carousel of example asks, the tool list, questions, and a closing line. Every picture on it is
drawn in CSS and inline SVG and captioned as an illustration (never a generated or real result); it names no model,
provider or price. The structure is in `command-center/lib/dev/mcp-landing.ts`, the copy under `mcp.land` in
`lib/i18n/site/dev-*.ts`, and `tests/mcp-landing.test.tsx` pins the order, the honesty rules and the carousel's
keyboard use.

The OAuth sign-in tabs of `/mcp` appear only when `MCP_OAUTH_LIVE=1`. This
document describes the server as built; **set the flag after migration 0093 is applied, the build is deployed and a real
connector (claude.ai or ChatGPT) has connected once.**

Use the server URL **`https://nightshift-ai.studio/api/mcp`**. A client that
speaks the MCP authorization flow discovers everything else itself
(`/.well-known/oauth-protected-resource/api/mcp`,
`/.well-known/oauth-authorization-server`), registers, and opens a browser to
Nightshift's consent screen.

### One-click "Add to …" buttons

With the flag on, `/mcp` and Developers → Connected apps show an install button
for the three assistants that document one, built in
`command-center/lib/dev/mcp-clients.ts` and pinned byte for byte by
`tests/mcp-connect-buttons.test.tsx`. **None has been tried end to end with the
product itself**, so the steps by hand are the very next step on every tab, and
Cursor's `cursor:` link does nothing on a computer without Cursor:

| Client | Link | Opens |
| :-- | :-- | :-- |
| Claude | `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Nightshift&connectorUrl=<encoded URL>`; for an organization the same on `claude.ai/admin-settings/connectors` | Claude's dialog, prefilled; the person presses Add (a signed-out person signs in first) |
| Cursor | `cursor://anysphere.cursor-deeplink/mcp/install?name=nightshift&config=<base64 of {"url": …}>` | Cursor's install prompt |
| VS Code | `https://vscode.dev/redirect?url=` + the encoded `vscode:mcp/install?{"name":"nightshift","type":"http","url":…}` (Insiders: `vscode-insiders:`) | VS Code's review editor, then install |

No link carries a key: they only work with the sign-in. ChatGPT, Gemini and
Grok document no install link: their tabs link the vendor's own guide and give
the steps by hand.

### What ChatGPT and Claude require, and where this server stands (checked 2026-11-13)

What each tab of `/mcp` may say is decided in ONE place, `command-center/lib/dev/mcp-availability.ts`:
`mcpClientAvailability(id, mcpOauthLive())` answers `available`, `ready`, `unverified` or `soon`, and
`mcpConnectOffered(id, oauthLive)` says whether a link may send a person into that assistant to connect ("Try in ChatGPT",
"Add to Claude"). ChatGPT and Claude are **`ready`**: the server meets each vendor's published requirements, and a sign-in
shaped exactly like each vendor's (its callback, its registration, `resource`, the `iss` check, form-encoded token and
refresh) passes against the real Command Center (`command-center/scripts/oauth-e2e-vendors.mjs`). Nobody has connected the
products themselves yet, so the tabs say "Ready to connect", never "works". When the owner has connected one for real,
change its word in `MCP_SIGN_IN` to `confirmed`. With `MCP_OAUTH_LIVE` off every sign-in-only tab is still "Coming soon".

Sources: OpenAI, https://developers.openai.com/api/docs/guides/custom-mcp-server and
https://developers.openai.com/plugins/build/auth (where https://developers.openai.com/apps-sdk/build/auth now leads);
Anthropic, https://claude.com/docs/connectors/building/authentication,
https://claude.com/docs/connectors/custom/add-unlisted and
https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp; the MCP authorization
specification 2026-07-28, https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.

| Requirement | Who | Here |
| :-- | :-- | :-- |
| Remote MCP over streamable HTTP (ChatGPT: "SSE and streaming HTTP") | both | `/api/mcp`, stateless streamable HTTP, JSON responses; GET/DELETE 405 (allowed for a server with no stream) |
| `401` with `WWW-Authenticate: Bearer resource_metadata=…` (Claude ignores it on a `200`) | both | yes, plus `scope` |
| Protected resource metadata whose `resource` equals the URL as entered, path included; first `authorization_servers` entry is the issuer | both | `https://nightshift-ai.studio/api/mcp`; one issuer |
| Authorization server metadata at `/.well-known/oauth-authorization-server` or `openid-configuration` | both | both names, with and without `/api/mcp` |
| PKCE `S256`, advertised in `code_challenge_methods_supported` | both | S256 only, checked by the database |
| Client registration: CIMD, DCR or a pre-registered client | both | DCR (RFC 7591, public clients). CIMD is not offered (`client_id_metadata_document_supported: false`), so ChatGPT and Claude use DCR. In Claude choose "Register automatically" |
| `token_endpoint_auth_methods_supported` lists what the token endpoint accepts | both | `["none"]`; a request for `client_secret_post` is registered as the public client it will be |
| `resource` (RFC 8707) on authorization and token requests, token bound to it, MCP server checks the audience | both | yes; any other resource is `invalid_target`, a token of another resource is a `401` |
| `iss` (RFC 9207) on EVERY authorization response, errors included, equal to the metadata issuer; then ChatGPT uses its stable callback | ChatGPT | yes (`authorization_response_iss_parameter_supported: true`) |
| Redirect URIs: `https://chatgpt.com/connector_platform_oauth_redirect` (or `…/connector/oauth/<id>`); `https://claude.ai/api/mcp/auth_callback`; Claude Code: loopback on any port | both | allowed and matched exactly as registered; the vendor registration class has its own budget (0147) |
| Keep a DCR client valid while the connection is in use (ChatGPT reuses one client id) | ChatGPT | **was missing**: 0147 deleted it a day after the connection ended. **0161** keeps it 30 days, 3 per person |
| A new client on every fresh connection; prefer CIMD for very high traffic | Claude | vendor class: 300 an address and 2 000 an hour, 60 000 rows (0147) |
| Token endpoint takes `application/x-www-form-urlencoded`; answers within 10 s (refresh 30 s) | Claude | yes; one database call |
| A dead refresh token is `invalid_grant`; refresh tokens rotate for public clients | both | yes; reusing a spent one ends the connection |
| `readOnlyHint` on read tools (ChatGPT treats any tool without it as a write and asks to confirm) | ChatGPT | every read tool has it; `create_video` and `publish_video` do not |
| No `search` / `fetch` tool needed for a custom server | ChatGPT | none offered |
| Consent screen shows the redirect host | both (MCP spec) | app name together with the host it returns to |
| Reachable from Anthropic's egress `160.79.104.0/21`, no WAF in the way | Claude | nothing in the app blocks by address; the server's firewall is the owner's to check |
| Optional: a profile tool for multi-account, `securitySchemes` per tool, OIDC `id_token_hint` | ChatGPT | not built (not required) |

### ChatGPT (custom MCP server)

OpenAI's guide: https://developers.openai.com/api/docs/guides/custom-mcp-server
(the developer-mode guide it replaced is gone).

1. On the web open **chatgpt.com/plugins**, press **+**, then **Add custom MCP
   server**.
2. Name: `Nightshift`, a short description, URL:
   `https://nightshift-ai.studio/api/mcp` (with the path). Authentication:
   **OAuth**. If the form offers a client ID and secret, leave them empty and keep
   dynamic registration: Nightshift registers ChatGPT itself and publishes no
   Client ID Metadata Document.
3. Confirm **I understand and want to continue**, sign in and approve on the
   Nightshift page when it opens (sign in if asked; it should name ChatGPT and
   `chatgpt.com`, which confirms the kind of app and where it returns, not whose
   ChatGPT account asked: the name is whatever the registrant chose, so approve only
   a sign-in you started yourself a moment ago; choose the monthly credit limit:
   default 500, up to 20 000, 0 means read-only; **Allow**), then press
   **Create as a plugin** and install it.
4. In a chat type **@** and pick the Nightshift plugin. Read tools run at once;
   `create_video` and `publish_video` ask for confirmation (they carry no
   `readOnlyHint`). Check each action before you approve it.

If ChatGPT later shows "This connection request cannot be used" on the
Nightshift page, its registration is gone (it was never approved within a day,
or its last connection ended more than 30 days ago): remove the plugin in
ChatGPT and add it again.

### Claude (custom connector, web, desktop and mobile)

1. Press **Add to Claude** on `/mcp`, or in Claude open **Customize → Connectors**,
   press **+ Add**, then **Add custom connector**.
2. Name: `Nightshift`. URL: `https://nightshift-ai.studio/api/mcp`. Under
   **OAuth client** keep **Register automatically**: the server registers the
   app itself, and it does not read Client ID Metadata Documents, so
   "Use Claude's published identity" cannot work. Add.
3. Press **Connect** and approve on the Nightshift page as above.
4. In a conversation, enable the Nightshift connector for it and ask for a
   video. Claude's desktop and mobile apps use the same account-level
   connectors list.

A Free Claude plan allows one custom connector. On Team and Enterprise only
Owners (or an Enterprise custom role) can add one, from
`claude.ai/admin-settings/connectors` ("Add for your organization" on `/mcp`).
Claude's "Request headers" field is a beta for some organizations only, so the
page offers Claude the sign-in, never an API key.

### Gemini (custom app)

Google's help: https://support.google.com/gemini/answer/17209137

1. On a computer open **gemini.google.com → Settings → Connected Apps** (if it is
   not there: **Personal Intelligence → Connected Apps**).
2. Under **Custom apps** choose **Add a custom app**, paste
   `https://nightshift-ai.studio/api/mcp`, **Next**.
3. Finish the sign-in. Then type **@** in a prompt and pick the app.

Limits, stated on the page: a personal Google Account only (not work or school),
18 and over, currently the US and English only, Keep Activity on. Connecting is
done on the web; the app then works in Gemini on mobile too. Gemini has no header
field, so it is sign-in only. Its callbacks
(`https://oauth-redirect.googleusercontent.com/r/…` and `/a/…`) already pass the
redirect rule.

### Grok (custom connector)

xAI's guide: https://docs.x.ai/grok/connectors

1. Open **grok.com/connectors → New Connector → Custom**.
2. Enter `https://nightshift-ai.studio/api/mcp`. Leave **Client ID** and
   **Client Secret** empty, so Grok registers itself.
3. Complete the sign-in.

On Business and Enterprise a team admin first adds the connector in the xAI
console (Add Connector → Other → the URL;
https://docs.x.ai/grok/connector-management); members then connect at
grok.com/connectors. **Unverified:** that Grok actually uses dynamic client
registration. If it insists on a Client ID it cannot connect yet, and the page
says so plainly. Its web callback (`https://grok.com/connectors-oauth-exchange-code/`)
already passes the redirect rule.

### Cursor and VS Code (GitHub Copilot)

Press **Add to Cursor** / **Add to VS Code**, or add Nightshift as a **remote
(HTTP) MCP server** with just the URL and **no `Authorization` header**; the
client starts the OAuth flow itself.

* Cursor, `~/.cursor/mcp.json` (or `.cursor/mcp.json` for one project): `{ "mcpServers": { "nightshift": { "url": "https://nightshift-ai.studio/api/mcp" } } }`
* VS Code, `.vscode/mcp.json`: `{ "servers": { "nightshift": { "type": "http", "url": "https://nightshift-ai.studio/api/mcp" } } }`; then ask GitHub Copilot.

### Other clients

Not on the page, but nothing stops them: any client that supports the MCP
authorization specification adds the URL and signs in the same way. Claude Code,
for example: `claude mcp add --transport http nightshift https://nightshift-ai.studio/api/mcp`,
then `/mcp` or `claude mcp login nightshift`. It registers itself as
"Claude Code (nightshift)"; the server registers and shows it as "Claude Code"
(see Registration below).

We run the official MCP SDK client against this server in a real end-to-end
test (below). We have **not** tested each product above ourselves: they differ
in menu names and in which of the permitted redirect addresses they use
(`https://` callbacks, `http://localhost`, `127.0.0.1`, `[::1]`, and Cursor's
own `cursor://anysphere.cursor-retrieval/oauth/…`).

### With an API key (unchanged)

Create a key in **Developers → API keys** (after activating the API). Treat it
like a password: a client holding it can spend your API balance. On `/mcp` only
Cursor and VS Code take one ("Use an API key instead" under their sign-in steps).

* Cursor: `{ "mcpServers": { "nightshift": { "url": "https://nightshift-ai.studio/api/mcp", "headers": { "Authorization": "Bearer nsk_live_…" } } } }`.
* VS Code: the same `servers` entry with `"headers": { "Authorization": "Bearer ${input:nightshift-key}" }` and a
  `promptString` input with `"password": true`, so the key is asked for and never written into the file.

## What the person controls

**Developers → Connected apps** lists every connection: the app's name and the
address it returns to, when it was connected and last used, its monthly limit
and what it spent this month, and a **Disconnect** button (and Disconnect
all). The limit can be raised or lowered there; the assistant has no tool for
it. Every live connection shows **Active** (since 0147 a plan never pauses one; on a database that still gates by plan it
would show **Paused: not included in the current plan**).
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
  leet folding in several scripts, with invisible and direction characters removed). One exception, in
  TypeScript before the database is asked (`registrationName`, `lib/oauth/redirect.ts`): a single trailing
  `(nightshift)` is dropped and the rest registered, because Claude Code names itself
  `Claude Code (<server name>)` and our snippets name the server `nightshift`; it is registered and shown
  as "Claude Code". What is left must pass the rule on its own, so "Nightshift (nightshift)" and every
  lookalike are still refused, and the database's check is unchanged. An app nobody ever approves is deleted after a day, and
  (0147) so is one whose every connection ended (revoked, or past its 90 days) more than a day ago, with those connections: a
  revoked connection no longer keeps its registration alive for a month. An app whose connection ended that long ago is added
  again in the assistant (Claude registers anew on every connection anyway). **Except ChatGPT (0161):** ChatGPT registers once
  per server connection and signs in again with the same client id after a Disconnect or the 90-day cap (OpenAI: deleting it
  answers `invalid_client`). A registration whose every redirect URI is ChatGPT's own callback is kept 30 days after a person's
  last connection with it ended, at most 3 per person; its old tokens stay dead and the next sign-in shows the consent screen.
  Two classes, each with its own budgets (0147): a registration whose **every** redirect URI is an AI vendor's own callback
  (`https://claude.ai/api/mcp/auth_callback`, `https://chatgpt.com/connector_platform_oauth_redirect`,
  `https://chatgpt.com/connector/oauth/<id>`, Grok's `https://grok.com/connectors-oauth-exchange-code/`, Gemini's
  `https://oauth-redirect.googleusercontent.com/r/<segment>` and `/a/<segment>`, one path segment) may make 300 per address and 2 000 in total per hour, up to 60 000 rows, because
  Claude registers a new client on every fresh connection from Anthropic's shared servers and ChatGPT once per server connection
  (with one budget for all, the 11th person an hour was refused); every other registration keeps 10 per address and 300 in total
  per hour, 20 000 rows. A vendor-class client's code can only ever be delivered to that vendor's callback, so the class gains an
  attacker nothing but rows, and its hourly ceiling times the one-day collection stays under its row cap. Client ID Metadata
  Documents are **not** implemented (they need SSRF-safe fetching of a
  client-supplied URL); the metadata says `client_id_metadata_document_supported: false`.
* **Authorize** `/oauth/authorize`: signed out goes to `/login` and comes back to
  the same request (only that exact page is an allowed return path). The app
  and the redirect URI are checked against the registration **exactly**; until
  they match nothing is redirected. The consent screen shows the app's name
  *together with the host it will return to*, the workspace, the exact
  permissions and a mandatory monthly credit limit (default 500, maximum
  20 000, whole credits). Every plan, Free included, gets this screen (0147); it
  says that what the app makes is paid from the workspace's credits. Allow/Deny is a same-origin JSON POST with a single-use secret
  bound to that person, `Origin` and `Sec-Fetch-Site` checks, and the page is
  never framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). The answer
  carries `code`, `state` and `iss` (RFC 9207). Allow is refused, with the remedy
  on the screen, when the person already has 20 live connections
  (`too_many_connections`: disconnect one in Developers → Connected apps), or when
  50 connections for that person or 200 for that workspace were approved in the
  last 24 hours, disconnected ones included (`too_many_connections_today`, 0147:
  try again later; the connected apps keep working).
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
* **Rate limit**: 120 requests a minute per connection (`oauth_limits().rpm`),
  and since 0147 a tool call costs **one** of them. The route still calls
  `oauth_check` first (the only read of the token's resource binding and
  scopes), which counts the request and, only when it lets it through, leaves a
  single-use credit for (grant, request id) in `oauth_check_credits`; the first
  `oauth_ctx` of that grant with that request id takes it (one `DELETE ...
  RETURNING`, younger than a minute) and reads the minute's count instead of
  counting again. A batch of N tool calls costs N units, like the API-key door;
  a direct caller with a forged or reused request id gains at most the one call
  its own counted check paid for. Before 0147 a tool call cost two units.

### Plans and billing

Connecting an app is open on **every plan**, Free included (migration 0147;
0093 had made it a paid-plan entitlement, `mcp`). 0147 takes the plan check
out of every OAuth function and sets `mcp` back to `planned` (checked nowhere,
never advertised), true for every plan, so the pricing matrix and the Usage
page no longer list it. What limits a connection is credits, live on every
call: a video is held through `reserve_credits()`, refused with
`insufficient_credits` before anything is held when the workspace has too
few, and the same connection works on its next call once credits are added (a
pack or a plan). The videos-at-once limit of the plan, the connection's own
monthly limit, the rate limit, scopes and revocation all still apply; the
operator's own organization is exempt. A connection spends the workspace's credits through
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
* `supabase/migrations/0147_mcp_free_tier.sql` — every plan may connect (the plan
  check out of seven 0093 functions, `mcp` back to `planned`), one rate unit per
  tool call (`oauth_check_credits`), the vendor registration class
  (`oauth_clients.vendor`), and the API key's spend-limit sentences
  (`docs/MIGRATIONS.md`; undo: `docs/sql/rollback_0147_mcp_free_tier.sql`).
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
  under concurrency, cross-tenant, replay-twice), `tests/security/test_sec_mcp_free_tier.py`
  (Free approves and spends, the rate credit, vendor registrations, rollback), and the
  0161's `tests/test_mcp_chatgpt_client_migration.py` and `tests/security/test_sec_mcp_chatgpt_client.py`, `command-center/tests/mcp-availability.test.tsx`,
  `command-center/scripts/oauth-e2e-vendors.mjs` (on the same rig, `tests/oauth_e2e/run.sh vendors`: the official SDK client with ChatGPT's and
  Claude's own callbacks and registrations, every refusal, rotation, and ChatGPT's reconnect a day after a Disconnect), and the
  end-to-end rig `tests/oauth_e2e/run.sh`: the **official MCP SDK client** does
  discovery, registration, PKCE, consent, token, tools, refresh and revoke
  against the real Command Center and a Postgres built from the migrations.
