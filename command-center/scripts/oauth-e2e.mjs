/**
 * End-to-end proof of MCP over OAuth, played by the OFFICIAL MCP SDK client
 * against a running Command Center (migration 0093). The "browser" is this
 * script: it holds the signed-in person's session cookie, opens the
 * authorization URL the SDK produced, reads the consent page, and posts the
 * person's Allow, exactly as the page's button does.
 *
 *   BASE=http://localhost:3100 COOKIE='sb-127-auth-token=…' node scripts/oauth-e2e.mjs
 *
 * See tests/oauth_e2e/run.sh for the whole rig (a Postgres built from the
 * repository's migrations, a Supabase-shaped HTTP shim in front of it, and
 * `next dev`). Exits non-zero on the first thing that is not as specified.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://localhost:3100";
const COOKIE = process.env.COOKIE ?? "";
const FREE_COOKIE = process.env.FREE_COOKIE ?? "";
const MCP = new URL("/api/mcp", BASE);
const REDIRECT = "http://127.0.0.1:33418/callback";
const log = (...a) => console.log("•", ...a);

function memoryProvider(onAuthorize) {
  let info, tokens, verifier;
  return {
    get redirectUrl() { return REDIRECT; },
    get clientMetadata() {
      return {
        client_name: "E2E Agent",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    state: () => "state-" + Math.random().toString(36).slice(2),
    clientInformation: () => info,
    saveClientInformation: (i) => { info = i; },
    tokens: () => tokens,
    saveTokens: (t) => { tokens = t; },
    redirectToAuthorization: (url) => onAuthorize(url),
    saveCodeVerifier: (v) => { verifier = v; },
    codeVerifier: () => verifier,
    get _tokens() { return tokens; },
    get _info() { return info; },
  };
}

/** The person: open the authorization URL signed in, read the screen, press Allow. */
async function approve(authUrl, { cookie = COOKIE, limit = 300 } = {}) {
  const page = await fetch(authUrl, { headers: { cookie }, redirect: "manual" });
  assert.equal(page.status, 200, `consent page: ${page.status}`);
  const html = await page.text();
  assert.match(html, /E2E Agent/, "the consent page names the app as it registered");
  assert.match(html, /127\.0\.0\.1:33418/, "…and the host it will send the person back to");
  assert.match(html, /Alice Studio/, "…and the workspace");
  assert.match(html, /spend|spends|credits/i, "…and that it spends credits");
  const secret = /nso_rq_[A-Za-z0-9_-]{43}/.exec(html)?.[0];
  assert.ok(secret, "the page carries the single-use secret of this request");
  const res = await fetch(new URL("/oauth/decision", BASE), {
    method: "POST",
    headers: { cookie, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ request: secret, decision: "allow", limit }),
  });
  assert.equal(res.status, 200, `decision: ${res.status}`);
  const { redirect } = await res.json();
  const u = new URL(redirect);
  assert.equal(u.origin + u.pathname, REDIRECT, "the code goes to the registered address only");
  assert.equal(u.searchParams.get("iss"), BASE, "RFC 9207 issuer is on the response");
  assert.ok(u.searchParams.get("code"));
  return { code: u.searchParams.get("code"), state: u.searchParams.get("state"), secret };
}

async function connectFresh() {
  let authUrl;
  const provider = memoryProvider((u) => { authUrl = u; });
  const mk = () => new Client({ name: "e2e", version: "1.0.0" });
  let client = mk();
  let transport = new StreamableHTTPClientTransport(MCP, { authProvider: provider });
  await assert.rejects(client.connect(transport), UnauthorizedError, "no token yet: the SDK is sent to authorize");
  assert.ok(authUrl, "the SDK discovered the server and built an authorization URL");
  const q = authUrl.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("resource"), MCP.href, "RFC 8707 resource is the MCP server URL");
  assert.equal(q.get("redirect_uri"), REDIRECT);
  log("SDK discovered metadata, registered a client and built", authUrl.origin + authUrl.pathname);
  const { code, state } = await approve(authUrl);
  assert.equal(state, q.get("state"), "state is returned unchanged");
  await transport.finishAuth(code);
  client = mk();
  transport = new StreamableHTTPClientTransport(MCP, { authProvider: provider });
  await client.connect(transport);
  log("connected with an access token");
  return { client, provider, transport };
}

const text = (r) => r.content.map((c) => c.text).join("\n");

async function main() {
  // 0. A signed-out visitor is sent to sign in and back, never shown a screen.
  const meta = await (await fetch(new URL("/.well-known/oauth-authorization-server", BASE))).json();
  const probe = new URL(meta.authorization_endpoint);
  probe.search = new URLSearchParams({ response_type: "code", client_id: "00000000-0000-4000-8000-000000000000", redirect_uri: REDIRECT }).toString();
  const out = await fetch(probe, { redirect: "manual" });
  assert.equal(out.status, 307);
  assert.match(out.headers.get("location"), /\/login\?next=%2Foauth%2Fauthorize%3F/);
  log("signed out → /login with a safe return path");

  // 1. discovery → DCR → authorize → token, by the official client.
  const { client, provider } = await connectFresh();
  const grantedScope = provider._tokens.scope;
  assert.equal(provider._tokens.token_type.toLowerCase(), "bearer");
  assert.ok(provider._tokens.refresh_token && provider._tokens.expires_in <= 3600);
  assert.equal(grantedScope, "videos:read videos:create videos:publish");

  // 2. the tools: what an OAuth caller is offered (no paid downloads).
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["create_video", "get_balance", "get_job_status", "get_video", "list_channels", "list_connected_accounts", "list_videos", "publish_video"]);
  log("tools/list:", tools.join(", "));

  // 3. real work, paid in credits.
  const bal0 = JSON.parse(text(await client.callTool({ name: "get_balance", arguments: {} })));
  assert.equal(bal0.credits.available, 400);
  assert.equal(bal0.this_connection.monthly_limit_credits, 300);
  const channels = JSON.parse(text(await client.callTool({ name: "list_channels", arguments: {} })));
  assert.deepEqual(channels.channels.map((c) => c.id), ["e2e-channel"]);
  const made = await client.callTool({ name: "create_video", arguments: { channel_id: "e2e-channel", topic: "Rome", duration: 60, idempotency_key: "e2e-1" } });
  assert.ok(!made.isError, text(made));
  const job = JSON.parse(text(made));
  assert.equal(job.price_credits, 90);
  const bal1 = JSON.parse(text(await client.callTool({ name: "get_balance", arguments: {} })));
  assert.equal(bal1.credits.held, 90);
  assert.equal(bal1.this_connection.spent_this_month_credits, 90);
  const status = JSON.parse(text(await client.callTool({ name: "get_job_status", arguments: { job_id: job.job_id } })));
  assert.equal(status.charge.held_credits, 90);
  log("create_video held", job.price_credits, "credits; job", job.job_id, status.status);

  // 4. the limits speak in plain words and name a way forward.
  for (let i = 0; i < 2; i++) await client.callTool({ name: "create_video", arguments: { channel_id: "e2e-channel", duration: 60, idempotency_key: "e2e-more-" + i } });
  const over = await client.callTool({ name: "create_video", arguments: { channel_id: "e2e-channel", duration: 60, idempotency_key: "e2e-over" } });
  assert.ok(over.isError);
  assert.match(text(over), /monthly spending limit/);
  assert.match(text(over), /Developers → Connected apps at http:\/\/localhost:3100\/developers/);
  assert.doesNotMatch(text(over), /rj-|reserve|ledger|hold|sha|token/i);
  log("limit refusal:", text(over).split("\n")[0].slice(0, 110) + "…");

  // 5. refresh rotates; reuse of a spent refresh token kills the connection.
  const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
  const t0 = provider._tokens;
  const clientId = provider._info.client_id;
  const r1 = await (await fetch(new URL("/oauth/token", BASE), form({ grant_type: "refresh_token", refresh_token: t0.refresh_token, client_id: clientId, resource: MCP.href }))).json();
  assert.ok(r1.access_token && r1.refresh_token && r1.refresh_token !== t0.refresh_token, JSON.stringify(r1));
  const callWith = (tok) => fetch(MCP, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal((await callWith(r1.access_token)).status, 200);
  const stale = await callWith(t0.access_token);
  assert.equal(stale.status, 401, "the rotated-out access token is dead");
  assert.match(stale.headers.get("www-authenticate"), /error="invalid_token".*resource_metadata=/);
  const reuse = await fetch(new URL("/oauth/token", BASE), form({ grant_type: "refresh_token", refresh_token: t0.refresh_token, client_id: clientId }));
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, "invalid_grant");
  assert.equal((await callWith(r1.access_token)).status, 401, "reuse revoked the whole family");
  log("refresh rotated; reuse revoked the family");

  // 6. a second connection, revoked through RFC 7009: the next call is refused.
  const second = await connectFresh();
  const t2 = second.provider._tokens;
  const rv = await fetch(new URL("/oauth/revoke", BASE), form({ token: t2.refresh_token, client_id: second.provider._info.client_id }));
  assert.equal(rv.status, 200);
  assert.equal((await callWith(t2.access_token)).status, 401);
  log("revoked: the access token no longer works");

  // 7. the person's Free neighbour gets no screen to approve.
  if (FREE_COOKIE) {
    const reg = await (await fetch(new URL("/oauth/register", BASE), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Free App", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) })).json();
    const u = new URL("/oauth/authorize", BASE);
    u.search = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: "A".repeat(43), code_challenge_method: "S256", state: "s" }).toString();
    const html = await (await fetch(u, { headers: { cookie: FREE_COOKIE } })).text();
    assert.match(html, /needs a paid plan/);
    assert.doesNotMatch(html, /nso_rq_/, "no secret, so no code can exist");
    log("Free workspace: paid-plan screen, nothing to approve");
  }
  console.log("\nOK: discovery, registration, consent, token, tools, refresh, reuse, revoke — all as specified.");
}

main().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
