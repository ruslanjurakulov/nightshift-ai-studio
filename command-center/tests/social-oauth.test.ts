import { createHash } from "crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

process.env.INSTAGRAM_APP_ID = "1234567890";
process.env.INSTAGRAM_APP_SECRET = "ig-secret";
process.env.INSTAGRAM_CONFIG_ID = "987654321012345";
process.env.INSTAGRAM_UNIFIED_ORGS = "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90";
process.env.TIKTOK_CLIENT_KEY = "ttkey";
process.env.TIKTOK_CLIENT_SECRET = "tt-secret";

let mod: typeof import("../lib/server/social-oauth");
let pure: typeof import("../lib/social-accounts");
beforeAll(async () => {
  mod = await import("../lib/server/social-oauth");
  pure = await import("../lib/social-accounts");
});

const ORG = "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90";

describe("state", () => {
  it("round-trips org + nonce", () => {
    const nonce = mod.newNonce();
    expect(mod.decodeSocialState(mod.encodeSocialState({ org: ORG, nonce }))).toEqual({ org: ORG, nonce });
  });
  it("refuses garbage, a non-uuid org, a short nonce and oversized input", () => {
    expect(mod.decodeSocialState("not-json")).toBeNull();
    expect(mod.decodeSocialState(null)).toBeNull();
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(mod.decodeSocialState(enc({ org: "evil", nonce: mod.newNonce() }))).toBeNull();
    expect(mod.decodeSocialState(enc({ org: ORG, nonce: "short" }))).toBeNull();
    expect(mod.decodeSocialState(enc({ org: ORG, nonce: "a".repeat(20), next: "https://evil" }))).toEqual({
      org: ORG,
      nonce: "a".repeat(20),
    });
    expect(mod.decodeSocialState("x".repeat(600))).toBeNull();
  });
  it("compares nonces exactly", () => {
    expect(mod.nonceMatches("abc", "abc")).toBe(true);
    expect(mod.nonceMatches("abc", "abd")).toBe(false);
    expect(mod.nonceMatches("abc", "abcd")).toBe(false);
    expect(mod.nonceMatches(undefined, "abc")).toBe(false);
    expect(mod.nonceMatches("", "")).toBe(false);
  });
  it("reads a cookie by exact name", () => {
    const req = new Request("https://x.test/", { headers: { cookie: "a=1; ig_oauth_nonce=NONCE; ig_oauth_nonce2=bad" } });
    expect(mod.readCookie(req, "ig_oauth_nonce")).toBe("NONCE");
    expect(mod.readCookie(req, "missing")).toBeUndefined();
  });
});

describe("consent URLs", () => {
  it("Instagram (Unified Login): the Facebook dialog with config_id and NO scope, our callback, the state", () => {
    const url = new URL(mod.buildInstagramAuthUrl({ origin: "https://nightshift-ai.studio/", state: "S" }));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("1234567890");
    expect(url.searchParams.get("config_id")).toBe("987654321012345");
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.get("redirect_uri")).toBe("https://nightshift-ai.studio/api/oauth/instagram/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("S");
    expect(url.toString()).not.toContain("ig-secret");
  });
  it("Instagram without a usable INSTAGRAM_CONFIG_ID is not configured, and never builds a login without it", () => {
    const saved = process.env.INSTAGRAM_CONFIG_ID;
    for (const bad of ["", "  ", "abc", "123 456", "1".repeat(65)]) {
      process.env.INSTAGRAM_CONFIG_ID = bad;
      expect(mod.isSocialConfigured("instagram")).toBe(false);
      expect(() => mod.buildInstagramAuthUrl({ origin: "https://a.test", state: "S" })).toThrow("not_configured");
    }
    process.env.INSTAGRAM_CONFIG_ID = saved;
    expect(mod.isSocialConfigured("instagram")).toBe(true);
  });
  it("TikTok: PKCE with a HEX sha256 challenge, publish scopes", () => {
    const verifier = mod.newCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const challenge = mod.tiktokCodeChallenge(verifier);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("hex"));
    const url = new URL(mod.buildTiktokAuthUrl({ origin: "https://nightshift-ai.studio", state: "S", codeChallenge: challenge }));
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("client_key")).toBe("ttkey");
    expect(url.searchParams.get("redirect_uri")).toBe("https://nightshift-ai.studio/api/oauth/tiktok/callback");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.publish,video.upload");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.toString()).not.toContain("tt-secret");
  });
  it("opens the Instagram connect only to INSTAGRAM_UNIFIED_ORGS (empty = nobody); TikTok is not behind it", () => {
    const saved = process.env.INSTAGRAM_UNIFIED_ORGS;
    process.env.INSTAGRAM_UNIFIED_ORGS = ` ${ORG.toUpperCase()}, junk ,`;
    expect(mod.socialConnectOpen("instagram", ORG)).toBe(true);
    expect(mod.socialConnectOpen("instagram", "11111111-2222-4333-8444-555555555555")).toBe(false);
    expect(mod.socialConnectOpen("instagram", null)).toBe(false);
    process.env.INSTAGRAM_UNIFIED_ORGS = "";
    expect(mod.socialConnectOpen("instagram", ORG)).toBe(false);
    expect(mod.socialConnectOpen("tiktok", null)).toBe(true);
    process.env.INSTAGRAM_UNIFIED_ORGS = saved;
  });
  it("reports configuration per platform from env", () => {
    expect(mod.isSocialConfigured("instagram")).toBe(true);
    const saved = process.env.TIKTOK_CLIENT_SECRET;
    process.env.TIKTOK_CLIENT_SECRET = "";
    expect(mod.isSocialConfigured("tiktok")).toBe(false);
    process.env.TIKTOK_CLIENT_SECRET = saved;
  });
});

describe("exchange errors never carry a token or body", () => {
  it("maps a 400 to exchange_rejected and a TikTok error body to exchange_rejected", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(new Response('{"error":"leaky ig-secret"}', { status: 400 }));
    await expect(mod.exchangeInstagramCode({ code: "c", origin: "https://a.test" })).rejects.toMatchObject({
      message: "exchange_rejected",
    });
    f.mockResolvedValueOnce(new Response('{"error":"invalid_grant","error_description":"x"}', { status: 200 }));
    await expect(mod.exchangeTiktokCode({ code: "c", origin: "https://a.test", codeVerifier: "v" })).rejects.toMatchObject({
      message: "exchange_rejected",
    });
    f.mockRestore();
  });
  it("exchanges the code in ONE call on graph.facebook.com v27, sending the same redirect_uri", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({ access_token: "EAAB-bisu", token_type: "bearer" }));
    const g = await mod.exchangeInstagramCode({ code: "the-code", origin: "https://nightshift-ai.studio" });
    expect(g).toEqual({ accessToken: "EAAB-bisu", expiresIn: null });
    expect(f).toHaveBeenCalledTimes(1);
    const url = new URL(String(f.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://graph.facebook.com/v27.0/oauth/access_token");
    expect(url.searchParams.get("client_id")).toBe("1234567890");
    expect(url.searchParams.get("code")).toBe("the-code");
    expect(url.searchParams.get("redirect_uri")).toBe("https://nightshift-ai.studio/api/oauth/instagram/callback");
    f.mockRestore();
  });
  it("refuses a redirect on every Graph call (the exchange, /me and its paging), so a 3xx is never followed to another host", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({ access_token: "EAAB-bisu" }));
    await mod.exchangeInstagramCode({ code: "c", origin: "https://nightshift-ai.studio" });
    f.mockResolvedValueOnce(Response.json({ client_business_id: "77" }));
    f.mockResolvedValueOnce(
      Response.json({ data: [{ id: "101", username: "a" }], paging: { next: "https://graph.facebook.com/v27.0/me/assigned_instagram_accounts?after=x" } }),
    );
    f.mockResolvedValueOnce(Response.json({ data: [{ id: "102", username: "b" }] }));
    await mod.fetchInstagramAccounts("EAAB-bisu");
    expect(f.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of f.mock.calls) expect((call[1] as RequestInit | undefined)?.redirect).toBe("error");
    f.mockRestore();
  });
  it("reads a missing, 0 or odd expires_in as 'no expiry stated' (null), never as a number", async () => {
    for (const expires_in of [undefined, 0, -5, "5184000", null, Number.NaN]) {
      const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ access_token: "EAAB-bisu", expires_in }));
      await expect(mod.exchangeInstagramCode({ code: "c", origin: "https://a.test" })).resolves.toEqual({ accessToken: "EAAB-bisu", expiresIn: null });
      f.mockRestore();
    }
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ access_token: "EAAB-bisu", expires_in: 3600 }));
    await expect(mod.exchangeInstagramCode({ code: "c", origin: "https://a.test" })).resolves.toEqual({ accessToken: "EAAB-bisu", expiresIn: 3600 });
    f.mockRestore();
  });
  it("reads the portfolio and the assigned IG accounts (not /me/accounts), deduplicated", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({ client_business_id: "555", id: "sys" }));
    f.mockResolvedValueOnce(
      Response.json({ data: [{ id: "17841400000000001", username: "first" }, { id: "17841400000000001" }, { id: "bad id" }, { id: "17841400000000002", username: "second" }] }),
    );
    await expect(mod.fetchInstagramAccounts("tok")).resolves.toEqual({
      clientBusinessId: "555",
      accounts: [
        { externalId: "17841400000000001", username: "first", displayName: null, avatarUrl: null },
        { externalId: "17841400000000002", username: "second", displayName: null, avatarUrl: null },
      ],
    });
    const urls = f.mock.calls.map((c) => new URL(String(c[0])));
    expect(urls.map((u) => u.pathname)).toEqual(["/v27.0/me", "/v27.0/me/assigned_instagram_accounts"]);
    expect(urls[0].searchParams.get("fields")).toBe("client_business_id");
    expect(urls[1].searchParams.get("fields")).toBe("id,username");
    expect(urls.every((u) => u.origin === "https://graph.facebook.com")).toBe(true);
    f.mockRestore();
  });
  it("accepts IG ids only as JSON strings: a number (which cannot hold 17 digits exactly) is dropped", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({ client_business_id: "555" }));
    f.mockResolvedValueOnce(Response.json({ data: [{ id: 17841400000000001 }, { id: "17841400000000002" }] }));
    const got = await mod.fetchInstagramAccounts("tok");
    expect(got.accounts.map((a) => a.externalId)).toEqual(["17841400000000002"]);
    f.mockRestore();
  });
  it("follows paging.next on graph.facebook.com only, up to the cap", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({ client_business_id: "555" }));
    f.mockResolvedValueOnce(
      Response.json({ data: [{ id: "17841400000000001" }], paging: { next: "https://graph.facebook.com/v27.0/me/assigned_instagram_accounts?after=A&access_token=tok" } }),
    );
    f.mockResolvedValueOnce(Response.json({ data: [{ id: "17841400000000002" }], paging: { next: "https://evil.example/steal?access_token=tok" } }));
    const got = await mod.fetchInstagramAccounts("tok");
    expect(got.accounts.map((a) => a.externalId)).toEqual(["17841400000000001", "17841400000000002"]);
    expect(f).toHaveBeenCalledTimes(3);
    expect(f.mock.calls.every((c) => new URL(String(c[0])).host === "graph.facebook.com")).toBe(true);
    f.mockRestore();
    // A next link that is not https, or carries credentials, is not followed either.
    for (const next of ["http://graph.facebook.com/v27.0/x", "https://u:p@graph.facebook.com/v27.0/x", "https://graph.facebook.com.evil.example/x"]) {
      const g = vi.spyOn(globalThis, "fetch");
      g.mockResolvedValueOnce(Response.json({}));
      g.mockResolvedValueOnce(Response.json({ data: [{ id: "17841400000000001" }], paging: { next } }));
      await mod.fetchInstagramAccounts("tok");
      expect(g).toHaveBeenCalledTimes(2);
      g.mockRestore();
    }
  });
  it("no assigned account is no_account; no portfolio id is null, not guessed", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({}));
    f.mockResolvedValueOnce(Response.json({ data: [] }));
    await expect(mod.fetchInstagramAccounts("tok")).rejects.toMatchObject({ message: "no_account" });
    f.mockResolvedValueOnce(Response.json({}));
    f.mockResolvedValueOnce(Response.json({ data: [{ id: "17841400000000001" }] }));
    await expect(mod.fetchInstagramAccounts("tok")).resolves.toMatchObject({ clientBusinessId: null });
    f.mockRestore();
  });
});

describe("pure helpers", () => {
  it("parses only known result words and builds one fixed return path", () => {
    expect(pure.parseSocialResult("connected")).toBe("connected");
    expect(pure.parseSocialResult("<script>")).toBeNull();
    expect(pure.parseSocialResult("https://evil.example")).toBeNull();
    expect(pure.socialReturnPath("tiktok", "denied")).toBe("/all-channels/channels?social=denied&platform=tiktok");
  });
  it("coerces rows and drops unsafe avatars and unknown platforms", () => {
    const rows = pure.coerceSocialAccounts([
      { id: "1", org_id: ORG, platform: "instagram", external_id: "178", avatar_url: "javascript:alert(1)", status: "connected" },
      { id: "2", org_id: ORG, platform: "facebook", external_id: "x" },
      { id: "3", org_id: ORG, platform: "tiktok", external_id: "oid", avatar_url: "https://p16.tiktokcdn.com/a.jpg", status: "weird" },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["1", "3"]);
    expect(rows[0].avatar_url).toBeNull();
    expect(rows[1].avatar_url).toBe("https://p16.tiktokcdn.com/a.jpg");
    expect(rows[1].status).toBe("error");
  });
  it("offers Connect to editors only when configured, Disconnect to editors", () => {
    expect(pure.socialPanelActions({ role: "viewer", configured: true, available: true })).toEqual({ connect: false, disconnect: false });
    expect(pure.socialPanelActions({ role: "editor", configured: true, available: true })).toEqual({ connect: true, disconnect: true });
    expect(pure.socialPanelActions({ role: "admin", configured: false, available: true })).toEqual({ connect: false, disconnect: true });
    expect(pure.socialPanelActions({ role: "owner", configured: true, available: false })).toEqual({ connect: false, disconnect: false });
  });
  it("maps rows to the header list shape", () => {
    const rows = pure.coerceSocialAccounts([
      { id: "1", org_id: ORG, platform: "instagram", external_id: "178", username: "brand", status: "connected", auth_flow: "unified_login" },
      { id: "2", org_id: ORG, platform: "tiktok", external_id: "o", display_name: "Brand TT", status: "expired" },
      { id: "3", org_id: ORG, platform: "tiktok", external_id: "p", status: "revoked" },
      { id: "4", org_id: ORG, platform: "instagram", external_id: "179", username: "old", status: "connected" },
    ]);
    expect(pure.toConnectedAccounts(rows)).toEqual([
      { platform: "instagram", id: "1", name: "@brand", avatarUrl: null, connected: true },
      { platform: "tiktok", id: "2", name: "Brand TT", avatarUrl: null, connected: false },
      { platform: "instagram", id: "4", name: "@old", avatarUrl: null, connected: false },
    ]);
  });
  it("an old Instagram Login row (no auth_flow) reads 'reconnect' and is not publishable; TikTok is unaffected", () => {
    const rows = pure.coerceSocialAccounts([
      { id: "1", org_id: ORG, platform: "instagram", external_id: "178", status: "connected" },
      { id: "2", org_id: ORG, platform: "instagram", external_id: "179", status: "connected", auth_flow: "unified_login" },
      { id: "3", org_id: ORG, platform: "instagram", external_id: "180", status: "connected", auth_flow: "something" },
      { id: "4", org_id: ORG, platform: "tiktok", external_id: "o", status: "connected" },
      { id: "5", org_id: ORG, platform: "instagram", external_id: "181", status: "expired" },
    ]);
    expect(rows.map(pure.accountView)).toEqual(["reconnect", "connected", "reconnect", "connected", "expired"]);
    expect(rows.map(pure.isPublishable)).toEqual([false, true, false, true, false]);
  });
  it("maps store errors to words without reading the message", () => {
    expect(pure.socialStoreErrorResult({ code: "42501", message: "token abc" })).toBe("forbidden");
    expect(pure.socialStoreErrorResult({ code: "PGRST202" })).toBe("not_available");
    expect(pure.socialStoreErrorResult({ code: "22023" })).toBe("failed");
    // 0028's store_social_account, before 0205: the remedy is the migration, not another try.
    expect(pure.socialStoreErrorResult({ code: "22023", message: "meta has an unknown key" })).toBe("needs_migration");
  });
});
