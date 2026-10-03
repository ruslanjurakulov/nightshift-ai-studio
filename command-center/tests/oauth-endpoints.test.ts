import { beforeEach, describe, expect, it } from "vitest";
import { registerEndpoint, revokeEndpoint, tokenEndpoint, type OauthDeps } from "@/lib/oauth/endpoints";
import { ACCESS_TOKEN_RE, CODE_RE, REFRESH_TOKEN_RE, hashSecret, newAccessToken, newAuthorizationCode, newRefreshToken, pkceChallenge } from "@/lib/oauth/tokens";
import { FakeOauthDb } from "./helpers/oauth-fake-db";

const ORIGIN = "https://nightshift-ai.studio";
const RESOURCE = ORIGIN + "/api/mcp";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
let db: FakeOauthDb;
let deps: OauthDeps;

beforeEach(() => {
  db = new FakeOauthDb();
  deps = { rpc: db.rpc, origin: ORIGIN, resource: RESOURCE };
});

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(ORIGIN + "/oauth/register", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const form = (o: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(ORIGIN + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(o).toString() });

describe("secrets", () => {
  it("are 256 random bits, recognisable by prefix, and hash to 64 hex characters", async () => {
    const a = newAccessToken();
    const r = newRefreshToken();
    const c = newAuthorizationCode();
    expect(a).toMatch(ACCESS_TOKEN_RE);
    expect(r).toMatch(REFRESH_TOKEN_RE);
    expect(c).toMatch(CODE_RE);
    expect(new Set([a, newAccessToken(), newAccessToken()]).size).toBe(3);
    expect(await hashSecret(a)).toMatch(/^[0-9a-f]{64}$/);
    // RFC 7636 appendix B
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("POST /oauth/register (RFC 7591, public clients only)", () => {
  const good = { client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };

  it("registers a public client and answers with exactly what was stored, never cached", async () => {
    const res = await registerEndpoint(json(good), deps);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", response_types: ["code"] });
    expect(body.client_secret).toBeUndefined();
    expect(db.clients.size).toBe(1);
  });

  it("registers a client that asks for a secret-based method as the public client it will be, and says so", async () => {
    for (const method of ["client_secret_post", "client_secret_basic"]) {
      const res = await registerEndpoint(json({ ...good, token_endpoint_auth_method: method }), deps);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.client_secret).toBeUndefined();
    }
  });

  it("refuses everything that is not a public client, before the database", async () => {
    for (const patch of [{ token_endpoint_auth_method: "private_key_jwt" }, { token_endpoint_auth_method: "tls_client_auth" },
      { grant_types: ["client_credentials"] }, { grant_types: ["implicit"] }, { response_types: ["token"] }, { response_types: ["code", "token"] }]) {
      const res = await registerEndpoint(json({ ...good, ...patch }), deps);
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect((await res.json()).error).toBe("invalid_client_metadata");
    }
    expect(db.calls).toEqual([]);
  });

  it("refuses hostile redirect URIs with invalid_redirect_uri and never reaches the database", async () => {
    for (const uri of ["https://evil.com@claude.ai/cb", "javascript:alert(1)", "http://claude.ai/cb", "https://*.claude.ai/cb", "https://claude.ai/cb#x", "myapp://x"]) {
      const res = await registerEndpoint(json({ ...good, redirect_uris: [uri] }), deps);
      expect(res.status, uri).toBe(400);
      expect((await res.json()).error).toBe("invalid_redirect_uri");
    }
    for (const uris of [[], Array.from({ length: 6 }, (_, i) => `https://a${i}.example.com/cb`), "https://claude.ai/cb", null, [5]]) {
      const res = await registerEndpoint(json({ ...good, redirect_uris: uris }), deps);
      expect((await res.json()).error).toBe("invalid_redirect_uri");
    }
    expect(db.calls).toEqual([]);
  });

  it("refuses a name that passes itself off as Nightshift, shows nothing, or is too long, with a normal invalid_client_metadata", async () => {
    const names = ["Nightshift", "Night\u200bshift", "N1ghtsh1ft", "Ｎｉｇｈｔｓｈｉｆｔ", "N\u0456ghtsh\u0456ft", "\u200b\u202e", "", "   ", "x".repeat(81)];
    for (const client_name of names) {
      const res = await registerEndpoint(json({ ...good, client_name }), deps);
      expect(res.status, JSON.stringify(client_name)).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_client_metadata");
      expect(body.error_description).toMatch(/client_name/);
    }
    expect(db.calls).toEqual([]);
  });

  it("is bounded: JSON only, size capped, an object", async () => {
    expect((await registerEndpoint(new Request(ORIGIN, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), deps)).status).toBe(415);
    expect((await registerEndpoint(json({ ...good, client_name: "x".repeat(20000) }), deps)).status).toBe(413);
    expect((await registerEndpoint(new Request(ORIGIN, { method: "POST", headers: { "content-type": "application/json" }, body: "[1]" }), deps)).status).toBe(400);
    expect((await registerEndpoint(new Request(ORIGIN, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" }), deps)).status).toBe(400);
  });

  it("cleans the name it will show a person, and falls back to the host", async () => {
    await registerEndpoint(json({ ...good, client_name: "Claude‮\n Desktop" }), deps);
    await registerEndpoint(json({ ...good, client_name: undefined }), deps);
    expect([...db.clients.values()].map((c) => c.name)).toEqual(["Claude Desktop", "claude.ai"]);
  });

  it("passes the caller's address to the per-address limit, and answers 429 when the database says so", async () => {
    await registerEndpoint(json(good, { "cf-connecting-ip": "203.0.113.9" }), deps);
    expect(db.calls[0].args.p_ip).toBe("203.0.113.9");
    deps.rpc = async () => ({ data: { ok: false, error: "rate_limited", description: "later" }, error: null });
    const res = await registerEndpoint(json(good), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("600");
  });

  it("is a 503 with a retry hint when the database is down, never a 200", async () => {
    deps.rpc = async () => ({ data: null, error: { code: "x", message: "down" } });
    const res = await registerEndpoint(json(good), deps);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
  });
});

/** A person approved: a code the client can redeem, with its PKCE verifier. */
async function approved(redirect = REDIRECT) {
  const reg = db.oauth_register_client({ p_name: "App", p_redirect_uris: [redirect] });
  const verifier = "v".repeat(64);
  const challenge = await pkceChallenge(verifier);
  const secretHash = "s" + Math.random();
  db.begin({ clientId: reg.client_id, redirectUri: redirect, secretHash, codeChallenge: challenge, state: "st", scope: null, resource: RESOURCE });
  const code = newAuthorizationCode();
  db.decide({ secretHash, allow: true, limit: 300, codeHash: await hashSecret(code) });
  return { clientId: reg.client_id, verifier, code, redirect };
}

describe("POST /oauth/token — authorization_code", () => {
  it("exchanges a code with its PKCE verifier for tokens, no-store, with the scope and a 1 hour life", async () => {
    const a = await approved();
    const res = await tokenEndpoint(form({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect, client_id: a.clientId, resource: RESOURCE }), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const body = await res.json();
    expect(body.access_token).toMatch(ACCESS_TOKEN_RE);
    expect(body.refresh_token).toMatch(REFRESH_TOKEN_RE);
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "videos:read videos:create videos:publish" });
    // The database got hashes of every token and of the code, never one itself. The PKCE verifier is
    // the one raw value it is given (single use, worthless without the code): the function is callable
    // with the public key, so it checks the S256 digest itself instead of trusting one from a caller.
    const sent = JSON.stringify(db.calls);
    expect(sent).not.toContain(body.access_token);
    expect(sent).not.toContain(body.refresh_token);
    expect(sent).not.toContain(a.code);
    expect(db.calls[0].args.p_verifier).toBe(a.verifier);
    expect(db.calls[0].args).not.toHaveProperty("p_challenge");
    expect(db.calls[0].args.p_access_hash).toBe(await hashSecret(body.access_token));
  });

  it("a replayed code is refused (invalid_grant) and the first use's tokens die", async () => {
    const a = await approved();
    const req = () => form({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect, client_id: a.clientId });
    const first = await (await tokenEndpoint(req(), deps)).json();
    const second = await tokenEndpoint(req(), deps);
    expect(second.status).toBe(400);
    expect((await second.json()).error).toBe("invalid_grant");
    expect((await db.oauth_check({ p_token_hash: await hashSecret(first.access_token) })).ok).toBe(false);
  });

  it("a wrong verifier, redirect or client is invalid_grant — one answer, no oracle", async () => {
    for (const patch of [{ code_verifier: "w".repeat(64) }, { redirect_uri: "https://claude.ai/other" }]) {
      const a = await approved();
      const res = await tokenEndpoint(form({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect, client_id: a.clientId, ...patch }), deps);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_grant");
    }
  });

  it("refuses malformed input before the database", async () => {
    const calls = () => db.calls.length;
    const base = { grant_type: "authorization_code", code: newAuthorizationCode(), code_verifier: "v".repeat(64), redirect_uri: REDIRECT, client_id: "00000000-0000-4000-8000-000000000001" };
    const bad = [
      [{ ...base, code_verifier: "short" }, "invalid_grant"],
      [{ ...base, code: "nso_ac_x" }, "invalid_grant"],
      [{ ...base, code: "" }, "invalid_request"],
      [{ ...base, redirect_uri: "" }, "invalid_request"],
      [{ ...base, client_id: "x" }, "invalid_client"],
      [{ ...base, grant_type: "password" }, "unsupported_grant_type"],
      [{ ...base, grant_type: "client_credentials" }, "unsupported_grant_type"],
      [{ ...base, resource: "https://evil.example/mcp" }, "invalid_target"],
    ] as const;
    for (const [params, error] of bad) {
      const res = await tokenEndpoint(form(params as Record<string, string>), deps);
      expect((await res.json()).error, JSON.stringify(params)).toBe(error);
    }
    expect(calls()).toBe(0);
  });

  it("is form-encoded only, never a query string, never a repeated parameter, never client authentication", async () => {
    const base = "grant_type=refresh_token&refresh_token=x&client_id=00000000-0000-4000-8000-000000000001";
    // Parameters in the URL are not read at all: the body is empty, so there is no client.
    expect((await tokenEndpoint(new Request(ORIGIN + "/oauth/token?" + base, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" }), deps)).status).toBe(401);
    expect((await tokenEndpoint(new Request(ORIGIN, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), deps)).status).toBe(400);
    expect((await tokenEndpoint(new Request(ORIGIN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: base + "&client_id=00000000-0000-4000-8000-000000000002" }), deps)).status).toBe(400);
    // A password in Basic is a secret nobody issued; client_id with an empty password is tolerated.
    const withSecret = await tokenEndpoint(form({ grant_type: "refresh_token" }, { authorization: "Basic eDp5" }), deps);
    expect(withSecret.status).toBe(401);
    expect((await withSecret.json()).error).toBe("invalid_client");
    const wrongId = await tokenEndpoint(
      form({ grant_type: "refresh_token", client_id: "00000000-0000-4000-8000-000000000002" }, { authorization: "Basic " + btoa("00000000-0000-4000-8000-000000000001:") }),
      deps,
    );
    expect(wrongId.status).toBe(401);
    expect(db.calls).toEqual([]);
  });

  it("answers invalid_grant for a lapsed plan (the client starts over and the consent page explains), without spending anything", async () => {
    const a = await approved();
    db.entitled = false;
    const res = await tokenEndpoint(form({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect, client_id: a.clientId }), deps);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toContain(ORIGIN + "/pricing");
    db.entitled = true;
    const again = await tokenEndpoint(form({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect, client_id: a.clientId }), deps);
    expect(again.status).toBe(200);
  });
});

describe("POST /oauth/token — refresh_token", () => {
  async function connected() {
    const a = await approved();
    const t = await (await tokenEndpoint(form({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect, client_id: a.clientId }), deps)).json();
    return { a, t };
  }
  const refresh = (rt: string, clientId: string, extra: Record<string, string> = {}) => form({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId, ...extra });

  it("rotates: new access and refresh tokens, the spent one cannot be used again, and reuse revokes the family", async () => {
    const { a, t } = await connected();
    const r1 = await (await tokenEndpoint(refresh(t.refresh_token, a.clientId), deps)).json();
    expect(r1.refresh_token).not.toBe(t.refresh_token);
    expect((await db.oauth_check({ p_token_hash: await hashSecret(t.access_token) })).ok).toBe(false);
    const reuse = await tokenEndpoint(refresh(t.refresh_token, a.clientId), deps);
    expect(reuse.status).toBe(400);
    expect((await reuse.json()).error).toBe("invalid_grant");
    expect((await db.oauth_check({ p_token_hash: await hashSecret(r1.access_token) })).ok).toBe(false);
    expect((await tokenEndpoint(refresh(r1.refresh_token, a.clientId), deps)).status).toBe(400);
  });

  it("is bound to the client and to the resource", async () => {
    const { a, t } = await connected();
    const other = db.oauth_register_client({ p_name: "Other", p_redirect_uris: [REDIRECT] }).client_id;
    expect((await tokenEndpoint(refresh(t.refresh_token, other), deps)).status).toBe(400);
    expect((await (await tokenEndpoint(refresh(t.refresh_token, a.clientId, { resource: "https://evil.example/mcp" }), deps)).json()).error).toBe("invalid_target");
    expect((await tokenEndpoint(refresh(t.refresh_token, a.clientId, { resource: RESOURCE + "/" }), deps)).status).toBe(200);
  });

  it("refuses an access token or garbage presented as a refresh token before the database", async () => {
    const { a, t } = await connected();
    const before = db.calls.length;
    expect((await (await tokenEndpoint(refresh(t.access_token, a.clientId), deps)).json()).error).toBe("invalid_grant");
    expect((await (await tokenEndpoint(refresh("nope", a.clientId), deps)).json()).error).toBe("invalid_grant");
    expect(db.calls.length).toBe(before);
  });
});

describe("POST /oauth/token — a library that sends the client_id as Basic with no password", () => {
  it("is served: the client_id is read from the header, there is still no secret to check", async () => {
    const a = await approved();
    const res = await tokenEndpoint(
      form({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect }, { authorization: "Basic " + btoa(`${a.clientId}:`) }),
      deps,
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /oauth/revoke (RFC 7009)", () => {
  it("revokes the whole connection with either token and always answers 200 {}", async () => {
    const a = await approved();
    const t = await (await tokenEndpoint(form({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect, client_id: a.clientId }), deps)).json();
    const res = await revokeEndpoint(form({ token: t.refresh_token, client_id: a.clientId }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect((await db.oauth_check({ p_token_hash: await hashSecret(t.access_token) })).ok).toBe(false);
    // An unknown or malformed token gets the same answer: no oracle.
    for (const token of ["nso_at_" + "x".repeat(43), "junk"]) {
      const r = await revokeEndpoint(form({ token, client_id: a.clientId }), deps);
      expect(r.status).toBe(200);
    }
  });

  it("a different client cannot revoke a connection it does not own", async () => {
    const a = await approved();
    const t = await (await tokenEndpoint(form({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirect, client_id: a.clientId }), deps)).json();
    const other = db.oauth_register_client({ p_name: "Other", p_redirect_uris: [REDIRECT] }).client_id;
    await revokeEndpoint(form({ token: t.access_token, client_id: other }), deps);
    expect((await db.oauth_check({ p_token_hash: await hashSecret(t.access_token) })).ok).toBe(true);
  });

  it("needs a token and a client_id", async () => {
    expect((await revokeEndpoint(form({ client_id: "00000000-0000-4000-8000-000000000001" }), deps)).status).toBe(400);
    expect((await revokeEndpoint(form({ token: "x" }), deps)).status).toBe(401);
  });
});
