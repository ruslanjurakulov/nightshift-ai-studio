import { createHash } from "crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

process.env.INSTAGRAM_APP_ID = "1234567890";
process.env.INSTAGRAM_APP_SECRET = "ig-secret";
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
  it("Instagram: business scopes, our callback, the state", () => {
    const url = new URL(mod.buildInstagramAuthUrl({ origin: "https://nightshift-ai.studio/", state: "S" }));
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("1234567890");
    expect(url.searchParams.get("redirect_uri")).toBe("https://nightshift-ai.studio/api/oauth/instagram/callback");
    expect(url.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_content_publish");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("S");
    expect(url.toString()).not.toContain("ig-secret");
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
  it("refuses a personal Instagram account", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({ user_id: "17841", username: "me", account_type: "PERSONAL" }));
    await expect(mod.fetchInstagramProfile("tok")).rejects.toMatchObject({ message: "not_business" });
    f.mockResolvedValueOnce(
      Response.json({ user_id: "17841", username: "me", name: "Me", account_type: "BUSINESS", profile_picture_url: "https://cdn.test/a.jpg" }),
    );
    await expect(mod.fetchInstagramProfile("tok")).resolves.toEqual({
      externalId: "17841",
      username: "me",
      displayName: "Me",
      avatarUrl: "https://cdn.test/a.jpg",
    });
    f.mockRestore();
  });
  it("accepts both short-token response shapes and returns the long-lived token", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(
      Response.json({ data: [{ access_token: "short", user_id: 42, permissions: "instagram_business_basic,instagram_business_content_publish" }] }),
    );
    f.mockResolvedValueOnce(Response.json({ access_token: "long", token_type: "bearer", expires_in: 5183944 }));
    const g = await mod.exchangeInstagramCode({ code: "c", origin: "https://a.test" });
    expect(g).toEqual({ accessToken: "long", expiresIn: 5183944, userId: "42", scopes: ["instagram_business_basic", "instagram_business_content_publish"] });
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
      { id: "1", org_id: ORG, platform: "instagram", external_id: "178", username: "brand", status: "connected" },
      { id: "2", org_id: ORG, platform: "tiktok", external_id: "o", display_name: "Brand TT", status: "expired" },
      { id: "3", org_id: ORG, platform: "tiktok", external_id: "p", status: "revoked" },
    ]);
    expect(pure.toConnectedAccounts(rows)).toEqual([
      { platform: "instagram", id: "1", name: "@brand", avatarUrl: null, connected: true },
      { platform: "tiktok", id: "2", name: "Brand TT", avatarUrl: null, connected: false },
    ]);
  });
  it("maps store errors to words without reading the message", () => {
    expect(pure.socialStoreErrorResult({ code: "42501", message: "token abc" })).toBe("forbidden");
    expect(pure.socialStoreErrorResult({ code: "PGRST202" })).toBe("not_available");
    expect(pure.socialStoreErrorResult({ code: "22023" })).toBe("failed");
  });
});
