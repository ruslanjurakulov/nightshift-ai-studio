/**
 * End-to-end proof that a sign-in shaped exactly like ChatGPT's and like Claude's works against the running Command Center,
 * played by the OFFICIAL MCP SDK client (discovery, dynamic client registration, PKCE, token, MCP calls) with each vendor's
 * own callback address and registration, and by raw HTTP for what the SDK does not check itself.
 *
 *   node scripts/oauth-e2e-vendors.mjs http://localhost:3100 'sb-127-auth-token=…' 'postgresql://…/ns_oauth_e2e'
 *
 * What each vendor documents and this script reproduces (read 2026-11-13; lib/dev/mcp-availability.ts, docs/MCP.md):
 *  - ChatGPT (https://developers.openai.com/plugins/build/auth): DCR once per connection, then the SAME client id for every
 *    later sign-in; `resource` on the authorization and token requests; `iss` compared to the metadata issuer by exact string
 *    before the code is used; the stable callback https://chatgpt.com/connector_platform_oauth_redirect for a server that
 *    advertises and returns `iss`.
 *  - Claude (https://claude.com/docs/connectors/building/authentication): 401 + resource_metadata; `resource` equal to the URL as
 *    entered; DCR when no CIMD is advertised, a new client on every fresh connection; the callback
 *    https://claude.ai/api/mcp/auth_callback; form-encoded token and refresh; `invalid_grant` for a dead refresh token; rotation.
 *
 * The person is this script: it holds the signed-in session cookie, opens the authorization URL, reads the consent page and
 * posts Allow as the page's button does. The browser would then be sent to the vendor's callback; the script reads the code
 * off that address instead, so nothing is ever sent to chatgpt.com or claude.ai. The database (third argument) is only used
 * to move a connection back in time, as if a day had passed. Exits non-zero on the first thing that is not as specified.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const [BASE = "http://localhost:3100", COOKIE = "", DSN = ""] = process.argv.slice(2);
const MCP = new URL("/api/mcp", BASE);
const log = (...a) => console.log("•", ...a);
const sql = (q) => execFileSync("psql", [DSN, "-v", "ON_ERROR_STOP=1", "-Atc", q], { encoding: "utf8" }).trim();
const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pkce = () => {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};
const rpc = (token, method, params = {}, id = 1) =>
  fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

const VENDORS = [
  // ChatGPT asks for a secret-based method here to prove the public-client answer; the SDK then authenticates with "none".
  { id: "chatgpt", name: "ChatGPT", redirect: "https://chatgpt.com/connector_platform_oauth_redirect", host: "chatgpt.com", method: "client_secret_post" },
  { id: "claude", name: "Claude", redirect: "https://claude.ai/api/mcp/auth_callback", host: "claude.ai", method: "none" },
];

function provider(v, onAuthorize) {
  let info, tokens, verifier;
  return {
    get redirectUrl() { return v.redirect; },
    get clientMetadata() {
      return {
        client_name: v.name,
        redirect_uris: [v.redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: v.method,
        // Fields a vendor may send that this server does not use: tolerated, never a refusal.
        client_uri: `https://${v.host}`,
        logo_uri: `https://${v.host}/favicon.ico`,
      };
    },
    state: () => "st-" + b64url(randomBytes(12)),
    clientInformation: () => info,
    saveClientInformation: (i) => { info = i; },
    tokens: () => tokens,
    saveTokens: (t) => { tokens = t; },
    redirectToAuthorization: (url) => onAuthorize(url),
    saveCodeVerifier: (x) => { verifier = x; },
    codeVerifier: () => verifier,
    get _tokens() { return tokens; },
    get _info() { return info; },
  };
}

/** Open the consent page signed in, check what it names, press Allow; return the code read off the vendor's callback. */
async function approve(authUrl, v, issuer) {
  const page = await fetch(authUrl, { headers: { cookie: COOKIE }, redirect: "manual" });
  assert.equal(page.status, 200, `${v.id}: consent page ${page.status}`);
  assert.equal(page.headers.get("x-frame-options"), "DENY", `${v.id}: the consent page is never framed`);
  const html = await page.text();
  assert.match(html, new RegExp(`>${v.name}<`), `${v.id}: the consent page names the app as it registered`);
  assert.ok(html.includes(v.host), `${v.id}: …and the host it will send the person back to`);
  assert.match(html, /Alice Studio/, `${v.id}: …and the workspace`);
  const secret = /nso_rq_[A-Za-z0-9_-]{43}/.exec(html)?.[0];
  assert.ok(secret, `${v.id}: the page carries the single-use secret of this request`);
  const res = await fetch(new URL("/oauth/decision", BASE), {
    method: "POST",
    headers: { cookie: COOKIE, origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ request: secret, decision: "allow", limit: 300 }),
  });
  assert.equal(res.status, 200, `${v.id}: decision ${res.status}`);
  const back = new URL((await res.json()).redirect);
  assert.equal(back.origin + back.pathname, v.redirect, `${v.id}: the code goes to the vendor's registered callback only`);
  // Both vendors compare iss to the metadata issuer by exact string before they use the code (RFC 9207; MCP 2026-07-28).
  assert.equal(back.searchParams.get("iss"), issuer, `${v.id}: iss is the metadata issuer, byte for byte`);
  assert.equal(back.searchParams.get("state"), new URL(authUrl).searchParams.get("state"), `${v.id}: state comes back unchanged`);
  return back.searchParams.get("code");
}

async function vendorFlow(v, meta) {
  // 1. What the vendor's backend sees first: a 401 that says where the metadata is.
  const bare = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: v.id, version: "1" } } }) });
  assert.equal(bare.status, 401);
  const challenge = bare.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /);
  const prm = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  assert.ok(prm, `${v.id}: the 401 points at the protected resource metadata`);
  const resource = await (await fetch(prm)).json();
  assert.equal(resource.resource, MCP.href, `${v.id}: resource is the server URL exactly as entered`);
  assert.equal(resource.authorization_servers[0], meta.issuer, `${v.id}: the first authorization server is the issuer`);

  // 2. The official SDK client: discovery, DCR with the vendor's callback, the authorization URL.
  let authUrl;
  const p = provider(v, (u) => { authUrl = u; });
  await assert.rejects(new Client({ name: v.id, version: "1" }).connect(new StreamableHTTPClientTransport(MCP, { authProvider: p })), UnauthorizedError);
  assert.ok(authUrl, `${v.id}: the SDK built an authorization URL`);
  assert.equal(p._info.token_endpoint_auth_method, "none", `${v.id}: registered as the public client it is; no secret issued`);
  assert.equal(p._info.client_secret, undefined);
  assert.deepEqual(p._info.redirect_uris, [v.redirect]);
  const q = authUrl.searchParams;
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("resource"), MCP.href);
  assert.equal(q.get("redirect_uri"), v.redirect);
  log(`${v.name}: 401 → metadata → registered ${p._info.client_id.slice(0, 8)}… with ${v.redirect}`);

  // 3. Consent, the code on the vendor's callback, the token by the SDK.
  const code = await approve(authUrl, v, meta.issuer);
  const transport = new StreamableHTTPClientTransport(MCP, { authProvider: p });
  await transport.finishAuth(code);
  const t = p._tokens;
  assert.equal(t.token_type.toLowerCase(), "bearer");
  assert.ok(t.access_token.startsWith("nso_at_") && t.refresh_token && t.expires_in <= 3600);
  assert.equal(t.scope, "videos:read videos:create videos:publish");
  log(`${v.name}: consent → code (iss checked) → token`);

  // 4. MCP through the token: initialize, tools/list (annotations ChatGPT reads), a read call, a paid call held in credits.
  const client = new Client({ name: v.id, version: "1" });
  await client.connect(new StreamableHTTPClientTransport(MCP, { authProvider: p }));
  const tools = (await client.listTools()).tools;
  const names = tools.map((x) => x.name).sort();
  assert.deepEqual(names, ["create_video", "get_balance", "get_job_status", "get_video", "list_channels", "list_connected_accounts", "list_videos", "publish_video"]);
  for (const name of ["list_channels", "get_job_status", "list_videos", "get_video", "list_connected_accounts", "get_balance"])
    assert.equal(tools.find((x) => x.name === name).annotations?.readOnlyHint, true, `${v.id}: ${name} is read-only to ChatGPT`);
  for (const name of ["create_video", "publish_video"])
    assert.notEqual(tools.find((x) => x.name === name).annotations?.readOnlyHint, true, `${v.id}: ${name} is a write ChatGPT asks to confirm`);
  const text = (r) => r.content.map((c) => c.text).join("\n");
  const channels = JSON.parse(text(await client.callTool({ name: "list_channels", arguments: {} })));
  assert.deepEqual(channels.channels.map((c) => c.id), ["e2e-channel"]);
  const made = await client.callTool({ name: "create_video", arguments: { channel_id: "e2e-channel", topic: v.name, duration: 30, idempotency_key: `e2e-${v.id}` } });
  assert.ok(!made.isError, text(made));
  assert.equal(JSON.parse(text(made)).price_credits, 45, `${v.id}: the app's own price, held in the workspace's credits`);
  log(`${v.name}: initialize, tools/list (${names.length}), list_channels, create_video held 45 credits`);

  // 5. The code is single-use, bound to the client, the callback, the verifier and the resource.
  const replay = await fetch(meta.token_endpoint, form({ grant_type: "authorization_code", code, redirect_uri: v.redirect, client_id: p._info.client_id, code_verifier: p.codeVerifier(), resource: MCP.href }));
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant", `${v.id}: a replayed code is refused`);
  assert.equal((await rpc(p._tokens.access_token, "tools/list")).status, 401, `${v.id}: …and the replay revoked what the first use made`);
  log(`${v.name}: code replay refused and the connection it made revoked`);
  return { provider: p };
}

/** A second connection on an existing registration, by hand: each request exactly as the vendor's backend sends it. */
async function signInByHand(v, meta, clientId, { scope = "videos:read videos:create videos:publish" } = {}) {
  const { verifier, challenge } = pkce();
  const u = new URL(meta.authorization_endpoint);
  u.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: v.redirect, state: "st-" + b64url(randomBytes(9)),
    code_challenge: challenge, code_challenge_method: "S256", scope, resource: MCP.href }).toString();
  const code = await approve(u.href, v, meta.issuer);
  const res = await fetch(meta.token_endpoint, form({ grant_type: "authorization_code", code, redirect_uri: v.redirect, client_id: clientId, code_verifier: verifier, resource: MCP.href }));
  assert.equal(res.status, 200, `${v.id}: token ${res.status}`);
  assert.equal(res.headers.get("cache-control")?.includes("no-store"), true);
  return { tokens: await res.json(), code, verifier };
}

async function negatives(v, meta, clientId) {
  const { verifier, challenge } = pkce();
  const authorize = (over) => {
    const u = new URL(meta.authorization_endpoint);
    u.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: v.redirect, state: "s", code_challenge: challenge,
      code_challenge_method: "S256", resource: MCP.href, ...over }).toString();
    return fetch(u, { headers: { cookie: COOKIE }, redirect: "manual" });
  };
  // A return address that is not the registered one, even one character off, is never redirected to: an error page, no secret.
  for (const bad of [v.redirect + "/", v.redirect + "?x=1", `https://evil.example/${v.host}/cb`, v.redirect.replace("https:", "http:")]) {
    const r = await authorize({ redirect_uri: bad });
    assert.equal(r.status, 200, `${v.id}: ${bad} → ${r.status}`);
    const html = await r.text();
    assert.doesNotMatch(html, /nso_rq_/, `${v.id}: no request exists for ${bad}`);
    assert.match(html, /cannot be used/);
  }
  // PKCE is S256 only.
  const plain = await authorize({ code_challenge_method: "plain", code_challenge: verifier });
  assert.equal(plain.status, 307);
  assert.equal(new URL(plain.headers.get("location")).searchParams.get("error"), "invalid_request");
  assert.equal(new URL(plain.headers.get("location")).searchParams.get("iss"), meta.issuer, `${v.id}: an error answer carries iss too`);
  // A token for another resource is not issued (RFC 8707), and an error on the redirect still carries iss.
  const other = await authorize({ resource: "https://evil.example/api/mcp" });
  assert.equal(other.status, 307);
  const loc = new URL(other.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, v.redirect);
  assert.equal(loc.searchParams.get("error"), "invalid_target");
  assert.equal(loc.searchParams.get("iss"), meta.issuer);
  // A code redeemed with the wrong verifier is refused, and so is the right verifier for the wrong resource.
  const good = await signInByHand(v, meta, clientId);
  assert.ok(good.tokens.access_token);
  const second = pkce();
  const u = new URL(meta.authorization_endpoint);
  u.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: v.redirect, state: "s2", code_challenge: second.challenge,
    code_challenge_method: "S256", resource: MCP.href }).toString();
  const code = await approve(u.href, v, meta.issuer);
  const wrongVerifier = await fetch(meta.token_endpoint, form({ grant_type: "authorization_code", code, redirect_uri: v.redirect, client_id: clientId, code_verifier: pkce().verifier, resource: MCP.href }));
  assert.equal((await wrongVerifier.json()).error, "invalid_grant", `${v.id}: a wrong PKCE verifier is refused`);
  const wrongResource = await fetch(meta.token_endpoint, form({ grant_type: "refresh_token", refresh_token: good.tokens.refresh_token, client_id: clientId, resource: "https://evil.example/api/mcp" }));
  assert.equal((await wrongResource.json()).error, "invalid_target", `${v.id}: a refresh for another resource is refused`);
  // A token whose connection was issued for another resource is refused by the MCP endpoint (the audience check).
  const audience = await signInByHand(v, meta, clientId);
  assert.equal((await rpc(audience.tokens.access_token, "tools/list")).status, 200);
  sql(`update public.oauth_grants set resource = 'https://evil.example/api/mcp' where id = (select grant_id from public.oauth_tokens where token_hash = encode(sha256(convert_to('${audience.tokens.access_token}', 'UTF8')), 'hex'))`);
  const foreign = await rpc(audience.tokens.access_token, "tools/list");
  assert.equal(foreign.status, 401, `${v.id}: a token for another audience is refused`);
  assert.match(foreign.headers.get("www-authenticate"), /error="invalid_token"/);
  log(`${v.name}: wrong callbacks, plain PKCE, wrong resource, wrong verifier and another audience all refused`);
  return good;
}

async function scopes(v, meta, clientId) {
  // A connection allowed to read only is offered only the read tools, and a write it remembers from the docs reaches nothing.
  const ro = await signInByHand(v, meta, clientId, { scope: "videos:read" });
  assert.equal(ro.tokens.scope, "videos:read");
  const list = await (await rpc(ro.tokens.access_token, "tools/list")).json();
  const names = list.result.tools.map((x) => x.name);
  assert.ok(!names.includes("create_video") && !names.includes("publish_video") && names.includes("list_videos"), names.join(","));
  const jobs = () => sql("select count(*) from public.render_jobs");
  const before = jobs();
  const call = await (await rpc(ro.tokens.access_token, "tools/call", { name: "create_video", arguments: { channel_id: "e2e-channel", duration: 30 } })).json();
  assert.equal(call.result?.isError, true);
  assert.match(call.result.content[0].text, /permission/i);
  assert.equal(jobs(), before, `${v.id}: the refused call queued nothing`);
  log(`${v.name}: a read-only connection lists no write tools and its create_video is refused before anything is held`);
}

async function rotation(v, meta, clientId, tokens) {
  const r1 = await (await fetch(meta.token_endpoint, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId, resource: MCP.href }))).json();
  assert.ok(r1.access_token && r1.refresh_token && r1.refresh_token !== tokens.refresh_token, JSON.stringify(Object.keys(r1)));
  assert.equal((await rpc(r1.access_token, "tools/list")).status, 200);
  const reuse = await fetch(meta.token_endpoint, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId, resource: MCP.href }));
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, "invalid_grant", `${v.id}: a spent refresh token is invalid_grant (what both vendors act on)`);
  assert.equal((await rpc(r1.access_token, "tools/list")).status, 401, `${v.id}: reuse revoked the whole connection`);
  log(`${v.name}: refresh rotates; a spent refresh token is invalid_grant and ends the connection`);
}

async function main() {
  assert.ok(COOKIE && DSN, "usage: oauth-e2e-vendors.mjs <base> <session cookie> <database dsn>");
  const meta = await (await fetch(new URL("/.well-known/oauth-authorization-server", BASE))).json();
  // What ChatGPT and Claude read from the metadata to choose DCR, S256 and the stable callback.
  assert.equal(meta.issuer, BASE);
  assert.equal(meta.authorization_response_iss_parameter_supported, true);
  assert.equal(meta.client_id_metadata_document_supported, false);
  assert.ok(meta.registration_endpoint && meta.code_challenge_methods_supported.includes("S256") && meta.token_endpoint_auth_methods_supported.includes("none"));
  assert.ok(!meta.scopes_supported.includes("openid"), "no OIDC scopes: ChatGPT would request them by default");

  // E2E_VENDORS=claude runs one vendor's flows (a small sandbox may not hold `next dev` for both); the reconnect checks below always run.
  const only = (process.env.E2E_VENDORS ?? "chatgpt,claude").split(",");
  for (const v of VENDORS.filter((x) => only.includes(x.id))) {
    const { provider: p } = await vendorFlow(v, meta);
    const clientId = p._info.client_id;
    const good = await negatives(v, meta, clientId);
    await scopes(v, meta, clientId);
    await rotation(v, meta, clientId, good.tokens);
  }

  // ChatGPT's reconnect (migration 0161): disconnect, a day passes, the SAME client id signs in again through the consent screen.
  const chatgpt = VENDORS[0];
  const first = await signInByHand(chatgpt, meta, (await registerLike(chatgpt)).client_id);
  const cid = sql(`select client_id from public.oauth_grants where id = (select grant_id from public.oauth_tokens where token_hash = encode(sha256(convert_to('${first.tokens.access_token}', 'UTF8')), 'hex'))`);
  const rv = await fetch(meta.revocation_endpoint, form({ token: first.tokens.refresh_token, client_id: cid }));
  assert.equal(rv.status, 200);
  assert.equal((await rpc(first.tokens.access_token, "tools/list")).status, 401);
  ageClient(cid, 25);
  await registerLike(VENDORS[1]); // anyone's registration runs the collector
  const back = await signInByHand(chatgpt, meta, cid);
  assert.equal((await rpc(back.tokens.access_token, "tools/list")).status, 200);
  log("ChatGPT: disconnected, a day later the same client id signs in again (consent shown) and works");
  // Claude registers anew on every connection, so its ended client still goes a day later.
  const claude = VENDORS[1];
  const cl = await registerLike(claude);
  const cconn = await signInByHand(claude, meta, cl.client_id);
  await fetch(meta.revocation_endpoint, form({ token: cconn.tokens.refresh_token, client_id: cl.client_id }));
  ageClient(cl.client_id, 25);
  await registerLike(claude);
  assert.equal(sql(`select count(*) from public.oauth_clients where client_id = '${cl.client_id}'`), "0");
  log("Claude: an ended client goes a day later, as before (Claude registers anew)");

  console.log("\nOK: ChatGPT- and Claude-shaped sign-ins, MCP calls, refusals, rotation and ChatGPT's reconnect — all as specified.");
}

async function registerLike(v) {
  const res = await fetch(new URL("/oauth/register", BASE), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: v.name, redirect_uris: [v.redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: v.method }) });
  assert.equal(res.status, 201);
  return res.json();
}

function ageClient(cid, hours) {
  sql(`update public.oauth_grants set created_at = created_at - interval '${hours} hours', activated_at = activated_at - interval '${hours} hours', ` +
      `revoked_at = revoked_at - interval '${hours} hours' where client_id = '${cid}'`);
  sql(`update public.oauth_clients set created_at = created_at - interval '${hours} hours', last_authorized_at = last_authorized_at - interval '${hours} hours' where client_id = '${cid}'`);
}

main().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
