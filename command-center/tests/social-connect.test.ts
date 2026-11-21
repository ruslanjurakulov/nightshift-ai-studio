import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90";
const OTHER = "11111111-2222-4333-8444-555555555555";

const state = {
  user: { id: "u1" } as { id: string } | null,
  org: { supported: true, orgs: [], current: { id: ORG, name: "A", slug: "a", role: "editor", is_default: false } } as unknown,
  role: { ok: true, role: "editor", orgId: ORG, source: "org" } as unknown,
  stored: [] as unknown[],
};

vi.mock("@/lib/supabase/server", () => ({ getUser: async () => state.user, createClient: async () => null }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => state.org }));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => state.role }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/server/social-accounts", () => ({
  storeSocialAccount: async (o: unknown) => {
    state.stored.push(o);
    return { result: "connected", accountId: "acc-1" };
  },
}));

process.env.INSTAGRAM_APP_ID = "1234567890";
process.env.INSTAGRAM_APP_SECRET = "ig-secret";
process.env.INSTAGRAM_CONFIG_ID = "987654321012345";
process.env.INSTAGRAM_UNIFIED_ORGS = "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90";
process.env.TIKTOK_CLIENT_KEY = "ttkey";
process.env.TIKTOK_CLIENT_SECRET = "tt-secret";
delete process.env.APP_ORIGIN;

const { startSocialConnect, finishSocialConnect } = await import("../lib/server/social-connect");
const { encodeSocialState } = await import("../lib/server/social-oauth");

const NONCE = "n".repeat(32);

function callback(platform: "instagram" | "tiktok", q: Record<string, string>, cookie = "") {
  const u = new URL(`https://nightshift-ai.studio/api/oauth/${platform}/callback`);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return new Request(u, { headers: cookie ? { cookie } : {} });
}

function location(res: Response): URL {
  return new URL(res.headers.get("location") ?? "");
}

beforeEach(() => {
  state.user = { id: "u1" };
  state.role = { ok: true, role: "editor", orgId: ORG, source: "org" };
  state.stored = [];
  vi.restoreAllMocks();
});

describe("start", () => {
  it("sets an httpOnly nonce cookie scoped to the platform's routes and a PKCE cookie for TikTok", async () => {
    const res = await startSocialConnect(new Request("https://nightshift-ai.studio/api/oauth/tiktok/start"), "tiktok");
    expect(location(res).host).toBe("www.tiktok.com");
    const set = res.headers.getSetCookie().join("\n");
    expect(set).toMatch(/tt_oauth_nonce=[^;]+;.*Path=\/api\/oauth\/tiktok/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/tt_oauth_pkce=/);
  });
  it("refuses a viewer before the consent screen", async () => {
    state.role = { ok: false, status: 403, error: "forbidden" };
    const res = await startSocialConnect(new Request("https://nightshift-ai.studio/api/oauth/instagram/start"), "instagram");
    const loc = location(res);
    expect(loc.origin).toBe("https://nightshift-ai.studio");
    expect(loc.searchParams.get("social")).toBe("forbidden");
  });
  it("says not_configured instead of breaking when the app keys are missing", async () => {
    const saved = process.env.INSTAGRAM_APP_SECRET;
    process.env.INSTAGRAM_APP_SECRET = "";
    const res = await startSocialConnect(new Request("https://nightshift-ai.studio/api/oauth/instagram/start"), "instagram");
    expect(location(res).searchParams.get("social")).toBe("not_configured");
    process.env.INSTAGRAM_APP_SECRET = saved;
  });
  it("fails early, before the login, when INSTAGRAM_CONFIG_ID is missing", async () => {
    const saved = process.env.INSTAGRAM_CONFIG_ID;
    delete process.env.INSTAGRAM_CONFIG_ID;
    const res = await startSocialConnect(new Request("https://nightshift-ai.studio/api/oauth/instagram/start"), "instagram");
    expect(location(res).host).toBe("nightshift-ai.studio");
    expect(location(res).searchParams.get("social")).toBe("not_configured");
    process.env.INSTAGRAM_CONFIG_ID = saved;
  });
  it("Instagram is open only to the allowlisted workspaces (the Meta app is Unpublished): others fail early, at start and callback", async () => {
    const saved = process.env.INSTAGRAM_UNIFIED_ORGS;
    for (const list of ["", OTHER, "not-a-uuid"]) {
      process.env.INSTAGRAM_UNIFIED_ORGS = list;
      const start = await startSocialConnect(new Request("https://nightshift-ai.studio/api/oauth/instagram/start"), "instagram");
      expect(location(start).host).toBe("nightshift-ai.studio");
      expect(location(start).searchParams.get("social")).toBe("not_configured");
      const f = vi.spyOn(globalThis, "fetch");
      const cb = await finishSocialConnect(
        callback("instagram", { code: "c", state: encodeSocialState({ org: ORG, nonce: NONCE }) }, `ig_oauth_nonce=${NONCE}`),
        "instagram",
      );
      expect(location(cb).searchParams.get("social")).toBe("not_configured");
      expect(f).not.toHaveBeenCalled(); // no code exchange for a workspace that is not let in
      f.mockRestore();
    }
    // TikTok is not behind it.
    const tt = await startSocialConnect(new Request("https://nightshift-ai.studio/api/oauth/tiktok/start"), "tiktok");
    expect(location(tt).host).toBe("www.tiktok.com");
    process.env.INSTAGRAM_UNIFIED_ORGS = saved;
  });
  it("sends Instagram to the Facebook login dialog with the configuration, the nonce in state, and no scope", async () => {
    const res = await startSocialConnect(new Request("https://nightshift-ai.studio/api/oauth/instagram/start"), "instagram");
    const loc = location(res);
    expect(loc.origin + loc.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(loc.searchParams.get("config_id")).toBe("987654321012345");
    expect(loc.searchParams.has("scope")).toBe(false);
    expect(res.headers.getSetCookie().join("\n")).toMatch(/ig_oauth_nonce=[^;]+;.*Path=\/api\/oauth\/instagram/);
  });
  it("401s a signed-out caller", async () => {
    state.user = null;
    const res = await startSocialConnect(new Request("https://nightshift-ai.studio/api/oauth/instagram/start"), "instagram");
    expect(res.status).toBe(401);
  });
});

describe("callback", () => {
  const good = () => encodeSocialState({ org: ORG, nonce: NONCE });

  it("refuses a missing or mismatched nonce cookie (CSRF) and stores nothing", async () => {
    for (const cookie of ["", `ig_oauth_nonce=${"m".repeat(32)}`]) {
      const res = await finishSocialConnect(callback("instagram", { code: "c", state: good() }, cookie), "instagram");
      expect(location(res).searchParams.get("social")).toBe("bad_state");
    }
    expect(state.stored).toHaveLength(0);
  });
  it("refuses a state minted for another organization", async () => {
    const st = encodeSocialState({ org: OTHER, nonce: NONCE });
    const res = await finishSocialConnect(callback("instagram", { code: "c", state: st }, `ig_oauth_nonce=${NONCE}`), "instagram");
    expect(location(res).searchParams.get("social")).toBe("bad_state");
    expect(state.stored).toHaveLength(0);
  });
  it("always redirects to the fixed same-origin page, whatever the query says", async () => {
    const res = await finishSocialConnect(
      callback("instagram", { error: "access_denied", next: "https://evil.example", state: good() }, `ig_oauth_nonce=${NONCE}`),
      "instagram",
    );
    const loc = location(res);
    expect(loc.origin).toBe("https://nightshift-ai.studio");
    expect(loc.pathname).toBe("/all-channels/channels");
    expect([...loc.searchParams.keys()].sort()).toEqual(["platform", "social"]);
    expect(loc.searchParams.get("social")).toBe("denied");
    expect(res.headers.getSetCookie().join("\n")).toMatch(/ig_oauth_nonce=;/);
  });
  it("refuses TikTok without the PKCE verifier cookie", async () => {
    const res = await finishSocialConnect(callback("tiktok", { code: "c", state: good() }, `tt_oauth_nonce=${NONCE}`), "tiktok");
    expect(location(res).searchParams.get("social")).toBe("bad_state");
  });
  it("connects TikTok: sends the verifier, stores both tokens through the RPC helper", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(
      Response.json({
        access_token: "act.x",
        refresh_token: "rft.y",
        expires_in: 86400,
        refresh_expires_in: 31536000,
        open_id: "oid-1",
        scope: "user.info.basic,video.publish,video.upload",
      }),
    );
    f.mockResolvedValueOnce(Response.json({ data: { user: { open_id: "oid-1", display_name: "Brand", avatar_url: "https://p.tiktokcdn.com/a.jpg" } } }));
    const res = await finishSocialConnect(
      callback("tiktok", { code: "c", state: good() }, `tt_oauth_nonce=${NONCE}; tt_oauth_pkce=VERIFIER`),
      "tiktok",
    );
    expect(location(res).searchParams.get("social")).toBe("connected");
    const body = String((f.mock.calls[0][1] as RequestInit).body);
    expect(body).toContain("code_verifier=VERIFIER");
    expect(state.stored).toHaveLength(1);
    expect(state.stored[0]).toMatchObject({
      orgId: ORG,
      platform: "tiktok",
      accessToken: "act.x",
      refreshToken: "rft.y",
      profile: { externalId: "oid-1", displayName: "Brand" },
    });
    // Nothing secret in the redirect.
    expect(res.headers.get("location")).not.toMatch(/act\.x|rft\.y/);
  });
  it("connects one Instagram account: one exchange, the two /me reads, stored with its portfolio and configuration", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({ access_token: "EAAB-bisu-token", token_type: "bearer" }));
    f.mockResolvedValueOnce(Response.json({ client_business_id: "555" }));
    f.mockResolvedValueOnce(Response.json({ data: [{ id: "17841400000000001", username: "brand" }] }));
    const res = await finishSocialConnect(callback("instagram", { code: "c", state: good() }, `ig_oauth_nonce=${NONCE}`), "instagram");
    expect(location(res).searchParams.get("social")).toBe("connected");
    expect(state.stored).toEqual([
      {
        orgId: ORG,
        platform: "instagram",
        accessToken: "EAAB-bisu-token",
        refreshToken: null,
        profile: { externalId: "17841400000000001", username: "brand", displayName: null, avatarUrl: null },
        // No scopes are claimed: the exchange returned none.
        scopes: [],
        // No expiry stated: stored as null, never a number.
        accessExpiresIn: null,
        refreshExpiresIn: null,
        instagram: { clientBusinessId: "555", configId: "987654321012345" },
      },
    ]);
    expect(res.headers.get("location")).not.toMatch(/EAAB/);
  });
  it("several Instagram accounts go to the pick screen even from the Channels page, and nothing is stored", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({ access_token: "EAAB-bisu-token" }));
    f.mockResolvedValueOnce(Response.json({ client_business_id: "555" }));
    f.mockResolvedValueOnce(Response.json({ data: [{ id: "17841400000000001" }, { id: "17841400000000002" }] }));
    const res = await finishSocialConnect(callback("instagram", { code: "c", state: good() }, `ig_oauth_nonce=${NONCE}`), "instagram");
    expect(location(res).pathname).toBe("/all-channels/channels/connect");
    expect(res.headers.getSetCookie().join("\n")).toMatch(/ns_connect_pending=/);
    expect(state.stored).toHaveLength(0);
  });
  it("a cancel on Facebook's screen is 'denied' and stores nothing", async () => {
    const res = await finishSocialConnect(
      callback("instagram", { error: "access_denied", error_reason: "user_denied", state: good() }, `ig_oauth_nonce=${NONCE}`),
      "instagram",
    );
    expect(location(res).searchParams.get("social")).toBe("denied");
    expect(state.stored).toHaveLength(0);
  });
  it("refuses a grant without the publish scope", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(
      Response.json({ access_token: "a".repeat(12), refresh_token: "r".repeat(12), open_id: "o", scope: "user.info.basic" }),
    );
    const res = await finishSocialConnect(
      callback("tiktok", { code: "c", state: good() }, `tt_oauth_nonce=${NONCE}; tt_oauth_pkce=V`),
      "tiktok",
    );
    expect(location(res).searchParams.get("social")).toBe("missing_scopes");
    expect(state.stored).toHaveLength(0);
  });
});
