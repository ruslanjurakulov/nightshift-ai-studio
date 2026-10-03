import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { ApiCaller } from "@/lib/api/operations";
import { apiError } from "@/lib/api/http";
import { oauthRpc } from "@/lib/api/mcp-oauth";
import { pkceChallenge } from "@/lib/oauth/tokens";
import { FakeOauthDb } from "./helpers/oauth-fake-db";

/**
 * A whole MCP client, played through the real route handlers (discovery ->
 * registration -> consent -> token -> tools -> refresh -> revoke -> refused),
 * with an in-memory database that restates the 0093 rules. The same flow runs
 * against the real database and the official SDK in tests/oauth_e2e.
 */

const ORIGIN = "https://nightshift-ai.studio";
const MCP = ORIGIN + "/api/mcp";
const REDIRECT = "http://127.0.0.1:33418/callback";

const h = vi.hoisted(() => ({ db: null as unknown as import("./helpers/oauth-fake-db").FakeOauthDb, user: { id: "u1" } as { id: string } | null }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("@/lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }) };
});
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => h.user }));
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/server/oauth", async () => {
  const { oauthEndpoints } = await import("@/lib/oauth/config");
  return {
    oauthEndpoints,
    oauthDeps: () => ({ rpc: h.db.rpc, origin: "https://nightshift-ai.studio", resource: "https://nightshift-ai.studio/api/mcp" }),
    beginAuthorization: async (a: Parameters<FakeOauthDb["begin"]>[0]) => {
      const r = h.db.begin(a) as Record<string, unknown>;
      if (r.ok !== true) return { ok: false, error: r.error, redirectOk: false };
      if (r.entitled === false) return { ok: true, entitled: false, clientName: r.client_name, workspaceName: r.workspace_name, plan: r.plan };
      return { ok: true, entitled: true, clientName: r.client_name, redirectUri: r.redirect_uri, workspaceName: r.workspace_name, plan: r.plan,
        scopes: r.scopes, defaultLimit: r.default_limit_credits, maxLimit: r.max_limit_credits, exempt: false };
    },
    decideAuthorization: async (a: Parameters<FakeOauthDb["decide"]>[0]) => {
      const r = h.db.decide(a) as Record<string, unknown>;
      return r.ok ? { ok: true, allowed: r.allowed, redirectUri: r.redirect_uri, state: r.state } : { ok: false, error: r.error };
    },
  };
});
vi.mock("@/lib/server/public-api", () => ({
  isCaller: (v: object) => "keyHash" in v,
  apiCaller: async () => apiError(401, "invalid_api_key", "Send your API key as \"Authorization: Bearer nsk_live_…\"."),
  oauthCheck: async (hash: string, requestId: string) => h.db.rpc("oauth_check", { p_token_hash: hash, p_request_id: requestId }),
  oauthApiCaller: (hash: string, requestId: string): ApiCaller => ({ keyHash: hash, requestId, rpc: oauthRpc(h.db.rpc), backend: "queue", downloads: false }),
}));

const { POST: mcp } = await import("@/app/api/mcp/route");
const { POST: register } = await import("@/app/oauth/register/route");
const { POST: tokenRoute } = await import("@/app/oauth/token/route");
const { POST: revokeRoute } = await import("@/app/oauth/revoke/route");
const { POST: decision } = await import("@/app/oauth/decision/route");
const { default: AuthorizePage } = await import("@/app/oauth/authorize/page");
const { GET: prm } = await import("@/app/.well-known/oauth-protected-resource/api/mcp/route");
const { GET: asm } = await import("@/app/.well-known/oauth-authorization-server/route");

beforeEach(() => {
  h.db = new FakeOauthDb();
  h.user = { id: "u1" };
});

const rpcReq = (body: unknown, token?: string) =>
  new Request(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const call = (name: string, args: object = {}) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
const form = (o: Record<string, string>) =>
  new Request(ORIGIN + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });

/** Every string inside a rendered element tree (server components are not run, their props are). */
function allText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => allText(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    const props = (node as ReactElement).props as Record<string, unknown>;
    for (const v of Object.values(props)) {
      if (typeof v === "string") out.push(v);
      else if (v && typeof v === "object") allText(v, out);
    }
  }
  return out;
}
function find(node: unknown, pred: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (Array.isArray(node)) for (const n of node) { const f = find(n, pred); if (f) return f; }
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as ReactElement).props as Record<string, unknown>;
    if (pred(props)) return props;
    for (const v of Object.values(props)) if (v && typeof v === "object") { const f = find(v, pred); if (f) return f; }
  }
  return null;
}

async function textOf(res: Response) {
  const body = (await res.json()) as { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] } };
  return { isError: body.result?.isError === true, text: body.result?.content?.map((c) => c.text).join("\n") ?? "", tools: body.result?.tools?.map((t) => t.name) ?? [] };
}

/** discovery -> registration -> consent -> token: returns the tokens. */
async function connect(limit = 300) {
  const first = await mcp(rpcReq({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  expect(first.status).toBe(401);
  const metaUrl = /resource_metadata="([^"]+)"/.exec(first.headers.get("www-authenticate") ?? "")![1];
  expect(metaUrl).toBe(ORIGIN + "/.well-known/oauth-protected-resource/api/mcp");
  const res = (await (await prm()).json()) as { resource: string; authorization_servers: string[] };
  expect(res.resource).toBe(MCP);
  const as = (await (await asm()).json()) as Record<string, unknown>;
  expect(as.issuer).toBe(res.authorization_servers[0]);

  const reg = await register(new Request(as.registration_endpoint as string, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "E2E Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) }));
  const clientId = ((await reg.json()) as { client_id: string }).client_id;

  const verifier = "v".repeat(64);
  const page = await AuthorizePage({ searchParams: Promise.resolve({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "st-1", code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256", resource: MCP }) });
  const text = allText(page).join("\n");
  expect(text).toContain("E2E Agent");
  expect(text).toContain("127.0.0.1:33418");
  expect(text).toContain("Alice Studio");
  const form_ = find(page, (p) => typeof p.secret === "string")!;
  const dec = await decision(new Request(ORIGIN + "/oauth/decision", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ request: form_.secret, decision: "allow", limit }) }));
  const { redirect } = (await dec.json()) as { redirect: string };
  const u = new URL(redirect);
  expect(u.searchParams.get("state")).toBe("st-1");
  expect(u.searchParams.get("iss")).toBe(ORIGIN);
  const tok = await tokenRoute(form({ grant_type: "authorization_code", code: u.searchParams.get("code")!, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId, resource: MCP }));
  expect(tok.status).toBe(200);
  return { clientId, ...((await tok.json()) as { access_token: string; refresh_token: string }) };
}

describe("a whole client, through the handlers", () => {
  it("discovery, registration, consent, token, tools, work in credits, refresh, revoke, refused", async () => {
    const t = await connect();

    const tools = await textOf(await mcp(rpcReq(list, t.access_token)));
    expect(tools.tools.sort()).toEqual(["create_video", "get_balance", "get_job_status", "get_video", "list_channels", "list_connected_accounts", "list_videos", "publish_video"]);

    const bal = JSON.parse((await textOf(await mcp(rpcReq(call("get_balance"), t.access_token)))).text);
    expect(bal.credits.available).toBe(400);
    const made = await textOf(await mcp(rpcReq(call("create_video", { channel_id: "e2e-channel", duration: 60 }), t.access_token)));
    expect(made.isError).toBe(false);
    expect(JSON.parse(made.text).price_credits).toBe(90);
    expect(h.db.credits).toEqual({ available: 310, held: 90 });
    expect(h.db.usdTouched).toBe(false);

    // refresh: rotated; the old access token is a 401 that names invalid_token
    const r = await (await tokenRoute(form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.clientId }))).json();
    const stale = await mcp(rpcReq(list, t.access_token));
    expect(stale.status).toBe(401);
    expect(stale.headers.get("www-authenticate")).toMatch(/error="invalid_token".*resource_metadata=/);
    expect((await mcp(rpcReq(list, r.access_token))).status).toBe(200);

    // revoke ends it: the very next call is refused
    const rv = await revokeRoute(new Request(ORIGIN + "/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: r.refresh_token, client_id: t.clientId }).toString() }));
    expect(rv.status).toBe(200);
    expect((await mcp(rpcReq(call("list_channels"), r.access_token))).status).toBe(401);
  });

  it("a signed-out visitor sends nobody anywhere: the page redirects to /login and back", async () => {
    h.user = null;
    await expect(AuthorizePage({ searchParams: Promise.resolve({ client_id: "x", redirect_uri: "y", state: "a&b" }) })).rejects.toMatchObject({
      to: "/login?next=" + encodeURIComponent("/oauth/authorize?client_id=x&redirect_uri=y&state=a%26b"),
    });
  });

  it("a request whose app or return address is not registered is an error page, never a redirect", async () => {
    const reg = await register(new Request(ORIGIN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "A", redirect_uris: [REDIRECT] }) }));
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const page = await AuthorizePage({ searchParams: Promise.resolve({ response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/cb", code_challenge: "x", code_challenge_method: "S256" }) });
    expect(allText(page).join(" ")).toContain("cannot be used");
    expect(find(page, (p) => typeof p.secret === "string")).toBeNull();
    expect(h.db.requests.size).toBe(0);
  });

  it.each([
    REDIRECT + "/",                                  // trailing slash
    "HTTP://127.0.0.1:33418/callback",               // case
    "http://127.0.0.1:33418/callback?x=1",           // an added query
    "http://127.0.0.1:33418/callback#frag",          // a fragment
    "http://127.0.0.1:33419/callback",               // another port
    "http://localhost:33418/callback",               // another loopback name
    "http://127.0.0.1.evil.com:33418/callback",      // lookalike host
    "http://evil.com@127.0.0.1:33418/callback",      // userinfo
    "http://[::1]:33418/callback",                   // IPv6 loopback, not registered
    "http://127.0.0.1:33418/callbаck",               // Cyrillic а
    "https://evil.example/cb",
    "",
  ])("the authorize page never redirects to %j: an unregistered return address is an error page", async (redirect) => {
    const reg = await register(new Request(ORIGIN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "A", redirect_uris: [REDIRECT] }) }));
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    let outcome: unknown;
    try {
      outcome = await AuthorizePage({ searchParams: Promise.resolve({ response_type: "code", client_id: clientId, redirect_uri: redirect, state: "s", code_challenge: "A".repeat(43), code_challenge_method: "S256" }) });
    } catch (e) {
      throw new Error(`redirected to ${(e as { to?: string }).to}`);
    }
    expect(allText(outcome).join(" ")).toContain("cannot be used");
    expect(find(outcome, (p) => typeof p.secret === "string")).toBeNull();
    expect(h.db.requests.size).toBe(0);
  });

  it("a request with a missing or repeated parameter is an error page too", async () => {
    for (const raw of [{ client_id: ["a", "b"], redirect_uri: REDIRECT }, { client_id: "3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e" }, { redirect_uri: REDIRECT }]) {
      const page = await AuthorizePage({ searchParams: Promise.resolve(raw) });
      expect(allText(page).join(" ")).toContain("cannot be used");
    }
  });

  it("a Free workspace gets the paid-plan screen and no secret, so no code can exist", async () => {
    h.db.entitled = false;
    const reg = await register(new Request(ORIGIN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "A", redirect_uris: [REDIRECT] }) }));
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const page = await AuthorizePage({ searchParams: Promise.resolve({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: "A".repeat(43), code_challenge_method: "S256" }) });
    const text = allText(page).join(" ");
    expect(text).toContain("needs a paid plan");
    expect(find(page, (p) => p.href === "/pricing")).not.toBeNull();
    expect(find(page, (p) => typeof p.secret === "string")).toBeNull();
    expect(h.db.requests.size).toBe(0);
    expect(h.db.codes.size).toBe(0);
  });

  it("a token for another resource is refused by the MCP server (RFC 8707)", async () => {
    const t = await connect();
    for (const g of h.db.grants.values()) g.resource = "https://other.example/mcp";
    const res = await mcp(rpcReq(list, t.access_token));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("an expired access token is a 401 pointing at the refresh token's flow", async () => {
    const t = await connect();
    h.db.now += 3601;
    const res = await mcp(rpcReq(list, t.access_token));
    expect(res.status).toBe(401);
    const r = await tokenRoute(form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.clientId }));
    expect(r.status).toBe(200);
  });

  it("never reaches a USD-balance function with a token, whatever the model asks for", async () => {
    const t = await connect();
    for (const name of ["request_download", "get_download"]) {
      const res = await textOf(await mcp(rpcReq(call(name, { video_id: "v", quality: "720p", download_id: 1 }), t.access_token)));
      expect(res.isError).toBe(true);
    }
    expect(h.db.usdTouched).toBe(false);
  });
});

describe("plans and billing, as the assistant sees them", () => {
  it("a lapsed plan: the handshake works, every call says a paid plan is needed, and the same connection works again when the plan returns", async () => {
    const t = await connect();
    h.db.entitled = false;
    expect((await textOf(await mcp(rpcReq(list, t.access_token)))).tools.length).toBeGreaterThan(0);
    const r = await textOf(await mcp(rpcReq(call("create_video", { channel_id: "e2e-channel", duration: 60 }), t.access_token)));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("needs a paid plan");
    expect(r.text).toContain(ORIGIN + "/pricing");
    expect(r.text).toContain("no need to connect the app again");
    const refresh = await tokenRoute(form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.clientId }));
    expect(refresh.status).toBe(400);
    h.db.entitled = true;
    const before = h.db.calls.length;
    const again = await textOf(await mcp(rpcReq(call("list_channels"), t.access_token)));
    expect(again.isError).toBe(false);
    expect(h.db.calls.slice(before).map((c) => c.fn)).not.toContain("oauth_exchange_code");
  });

  const INTERNAL = /rj-|reserve|ledger|hold|hash|sha|NS4|api_|oauth_|tenant|org_id|usd|cents|balance_cents/i;

  it("no credits: says what is missing, links top-up and plans, and 'top up then continue' needs no re-authorisation", async () => {
    const t = await connect(1000);
    h.db.credits = { available: 40, held: 20 };
    const refused = await textOf(await mcp(rpcReq(call("create_video", { channel_id: "e2e-channel", duration: 60 }), t.access_token)));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("needs 90 credits");
    expect(refused.text).toContain("40 available");
    expect(refused.text).toContain("20 more are set aside");
    expect(refused.text).toContain(ORIGIN + "/credits");
    expect(refused.text).toContain(ORIGIN + "/pricing");
    expect(refused.text).toContain("no need to connect the app again");
    expect(refused.text).not.toMatch(INTERNAL);
    expect(h.db.credits).toEqual({ available: 40, held: 20 });

    const calls = h.db.calls.length;
    h.db.credits.available = 1000; // the person bought credits
    const ok = await textOf(await mcp(rpcReq(call("create_video", { channel_id: "e2e-channel", duration: 60 }), t.access_token)));
    expect(ok.isError).toBe(false);
    const used = h.db.calls.slice(calls).map((c) => c.fn);
    expect(used).not.toContain("oauth_exchange_code");
    expect(used).not.toContain("oauth_refresh");
  });

  it("the connection's monthly limit: says so, says only the person can raise it, and where", async () => {
    const t = await connect(100);
    await mcp(rpcReq(call("create_video", { channel_id: "e2e-channel", duration: 60 }), t.access_token));
    const refused = await textOf(await mcp(rpcReq(call("create_video", { channel_id: "e2e-channel", duration: 60 }), t.access_token)));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("monthly spending limit");
    expect(refused.text).toContain("limit 100 credits");
    expect(refused.text).toContain("90 used");
    expect(refused.text).toContain(`Developers → Connected apps at ${ORIGIN}/developers`);
    expect(refused.text).toMatch(/Only the person can raise it/);
    expect(refused.text).toContain("You cannot change it");
    expect(refused.text).not.toMatch(INTERNAL);
  });

  it("the plan's run limit: wait or upgrade, with the retry hint, and only the workspace's own counts", async () => {
    const t = await connect(1000);
    h.db.runLimit = 1;
    await mcp(rpcReq(call("create_video", { channel_id: "e2e-channel", duration: 60 }), t.access_token));
    const refused = await textOf(await mcp(rpcReq(call("create_video", { channel_id: "e2e-channel", duration: 60 }), t.access_token)));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("at most 1 video at once and 1 is in progress");
    expect(refused.text).toContain("try again in about a minute");
    expect(refused.text).toContain(ORIGIN + "/pricing");
    expect(refused.text).not.toMatch(INTERNAL);
  });
});

describe("the consent decision cannot be forged", () => {
  async function pending() {
    const reg = await register(new Request(ORIGIN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "A", redirect_uris: [REDIRECT] }) }));
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const page = await AuthorizePage({ searchParams: Promise.resolve({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s", code_challenge: "A".repeat(43), code_challenge_method: "S256" }) });
    return find(page, (p) => typeof p.secret === "string")!.secret as string;
  }
  const post = (secret: string, headers: Record<string, string>, body?: unknown) =>
    decision(new Request(ORIGIN + "/oauth/decision", { method: "POST", headers, body: JSON.stringify(body ?? { request: secret, decision: "allow", limit: 100 }) }));

  it("needs our own Origin, a same-origin fetch and JSON; the secret alone or the cookie alone is not enough", async () => {
    const secret = await pending();
    const json = { "content-type": "application/json" };
    for (const headers of [
      { ...json },                                                    // no Origin at all
      { ...json, origin: "https://evil.example" },                    // another site
      { ...json, origin: "null" },                                    // a sandboxed frame
      { ...json, origin: ORIGIN, "sec-fetch-site": "cross-site" },    // the browser says cross-site
      { ...json, origin: ORIGIN, "sec-fetch-site": "same-site" },
    ]) {
      expect((await post(secret, headers)).status, JSON.stringify(headers)).toBe(403);
    }
    expect((await post(secret, { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await post(secret, { origin: ORIGIN, "content-type": "text/plain" })).status).toBe(415);
    expect(h.db.codes.size).toBe(0);
    // And signed out, a correct request is refused.
    h.user = null;
    expect((await post(secret, { ...json, origin: ORIGIN })).status).toBe(401);
    h.user = { id: "u1" };
    expect(h.db.codes.size).toBe(0);
    const ok = await post(secret, { ...json, origin: ORIGIN, "sec-fetch-site": "same-origin" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a malformed or replayed secret", async () => {
    const secret = await pending();
    const headers = { "content-type": "application/json", origin: ORIGIN };
    expect((await post(secret, headers, { request: "nope", decision: "allow", limit: 5 })).status).toBe(400);
    expect((await post(secret, headers, { request: secret, decision: "maybe", limit: 5 })).status).toBe(400);
    expect((await post(secret, headers, { request: secret, decision: "allow", limit: 5 })).status).toBe(200);
    const replay = await post(secret, headers, { request: secret, decision: "allow", limit: 5 });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "expired" });
  });

  it("deny answers with access_denied on the registered address and makes no grant", async () => {
    const secret = await pending();
    const res = await post(secret, { "content-type": "application/json", origin: ORIGIN }, { request: secret, decision: "deny" });
    const u = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(u.origin + u.pathname).toBe(REDIRECT);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("s");
    expect(h.db.grants.size).toBe(0);
  });
});

