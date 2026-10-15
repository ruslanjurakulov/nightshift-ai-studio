import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90";
const NONCE = "n".repeat(32);

const s = {
  user: { id: "u1" } as { id: string } | null,
  org: { supported: true, orgs: [], current: { id: ORG, name: "A", slug: "a", role: "editor", is_default: false } } as unknown,
  role: { ok: true, role: "editor", orgId: ORG, source: "org" } as unknown,
  stored: [] as Record<string, unknown>[],
  storeResult: "connected" as string,
  audits: [] as { action: string; detail?: Record<string, unknown> }[],
};

vi.mock("@/lib/supabase/server", () => ({ getUser: async () => s.user, createClient: async () => null }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => s.org }));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => s.role }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async (e: never) => void s.audits.push(e) }));
vi.mock("@/lib/server/social-accounts", () => ({
  storeSocialAccount: async (o: Record<string, unknown>) => {
    s.stored.push(o);
    return { result: s.storeResult, accountId: "acc-1" };
  },
}));

process.env.INSTAGRAM_APP_ID = "1234567890";
process.env.INSTAGRAM_APP_SECRET = "ig-secret";
process.env.TIKTOK_CLIENT_KEY = "ttkey";
process.env.TIKTOK_CLIENT_SECRET = "tt-secret";
delete process.env.APP_ORIGIN;

const { startSocialConnect, finishSocialConnect, confirmSocialPick } = await import("../lib/server/social-connect");
const { encodeSocialState, decodeSocialState } = await import("../lib/server/social-oauth");
const pending = await import("../lib/server/connect-pending");

const ORIGIN = "https://nightshift-ai.studio";
const loc = (r: Response) => new URL(r.headers.get("location") ?? "");
const cookies = (r: Response) => r.headers.getSetCookie().join("\n");
const cb = (platform: "instagram" | "tiktok", cookie: string, pick = true) => {
  const u = new URL(`${ORIGIN}/api/oauth/${platform}/callback`);
  u.searchParams.set("code", "c");
  u.searchParams.set("state", encodeSocialState({ org: ORG, nonce: NONCE, ...(pick ? { pick: true as const } : {}) }));
  return new Request(u, { headers: { cookie } });
};
function fakeTiktok() {
  const f = vi.spyOn(globalThis, "fetch");
  f.mockResolvedValueOnce(
    Response.json({ access_token: "act.SECRET", refresh_token: "rft.SECRET", expires_in: 86400, refresh_expires_in: 31536000, open_id: "oid-1", scope: "user.info.basic,video.publish,video.upload" }),
  );
  f.mockResolvedValueOnce(Response.json({ data: { user: { open_id: "oid-1", display_name: "Brand", avatar_url: "https://p.tiktokcdn.com/a.jpg" } } }));
  return f;
}
function fakeInstagram() {
  const f = vi.spyOn(globalThis, "fetch");
  f.mockResolvedValueOnce(Response.json({ data: [{ access_token: "IGshort", user_id: 17841400000000000, permissions: "instagram_business_basic,instagram_business_content_publish" }] }));
  f.mockResolvedValueOnce(Response.json({ access_token: "IGlong", expires_in: 5184000 }));
  f.mockResolvedValueOnce(Response.json({ user_id: "17841400000000000", username: "brand", name: "Brand", account_type: "BUSINESS", profile_picture_url: "https://x.cdninstagram.com/p.jpg" }));
  return f;
}
const handleOf = (r: Response) => /ns_connect_pending=([^;]+)/.exec(cookies(r))?.[1];

beforeEach(() => {
  vi.restoreAllMocks();
  s.user = { id: "u1" };
  s.role = { ok: true, role: "editor", orgId: ORG, source: "org" };
  s.stored = [];
  s.storeResult = "connected";
  s.audits = [];
  pending.dropUserPending("u1");
});

describe("start (pick flow)", () => {
  it("carries the pick flag in the state and refuses a non-editor on the Add channel screen", async () => {
    const res = await startSocialConnect(new Request(`${ORIGIN}/api/oauth/instagram/start?pick=1`), "instagram");
    expect(decodeSocialState(loc(res).searchParams.get("state"))).toMatchObject({ org: ORG, pick: true });
    s.role = { ok: false, status: 403, error: "forbidden" };
    const refused = await startSocialConnect(new Request(`${ORIGIN}/api/oauth/instagram/start?pick=1`), "instagram");
    expect(loc(refused).pathname).toBe("/all-channels/channels/new");
    expect(loc(refused).searchParams.get("connect")).toBe("forbidden");
    expect(loc(refused).searchParams.get("platform")).toBe("instagram");
  });
  it("leaves the classic start exactly as it was (no pick flag, answers on the Channels page)", async () => {
    const res = await startSocialConnect(new Request(`${ORIGIN}/api/oauth/instagram/start`), "instagram");
    expect(decodeSocialState(loc(res).searchParams.get("state"))?.pick).toBeUndefined();
    s.role = { ok: false, status: 403, error: "forbidden" };
    const refused = await startSocialConnect(new Request(`${ORIGIN}/api/oauth/instagram/start`), "instagram");
    expect(loc(refused).pathname).toBe("/all-channels/channels");
    expect(loc(refused).searchParams.get("social")).toBe("forbidden");
  });
});

describe("callback (pick flow): hold, do not store", () => {
  it.each([
    ["tiktok", fakeTiktok, `tt_oauth_nonce=${NONCE}; tt_oauth_pkce=VERIFIER`, "oid-1"],
    ["instagram", fakeInstagram, `ig_oauth_nonce=${NONCE}`, "17841400000000000"],
  ] as const)("%s: nothing is stored and the redirect carries no token", async (platform, fake, cookie, externalId) => {
    fake();
    const res = await finishSocialConnect(cb(platform, cookie), platform);
    expect(loc(res).pathname).toBe("/all-channels/channels/connect");
    expect(s.stored).toEqual([]);
    expect(`${res.headers.get("location")}\n${cookies(res)}`).not.toMatch(/SECRET|IGlong|IGshort/);
    const held = pending.readPending(handleOf(res), { userId: "u1", orgId: ORG });
    expect(held?.grant.platform === platform && held.grant.profile.externalId).toBe(externalId);
  });
  it("never keeps an avatar that is not an https picture", async () => {
    const f = fakeTiktok();
    f.mockReset();
    f.mockResolvedValueOnce(Response.json({ access_token: "a", refresh_token: "r", expires_in: 1, refresh_expires_in: 1, open_id: "o", scope: "user.info.basic,video.publish" }));
    f.mockResolvedValueOnce(Response.json({ data: { user: { open_id: "o", display_name: "B", avatar_url: "javascript:alert(1)" } } }));
    const res = await finishSocialConnect(cb("tiktok", `tt_oauth_nonce=${NONCE}; tt_oauth_pkce=V`), "tiktok");
    const held = pending.readPending(handleOf(res), { userId: "u1", orgId: ORG });
    expect(held?.grant.platform === "tiktok" && held.grant.profile.avatarUrl).toBeNull();
  });
  it("still refuses a bad nonce and returns to the Add channel screen", async () => {
    const res = await finishSocialConnect(cb("tiktok", `tt_oauth_nonce=${"m".repeat(32)}; tt_oauth_pkce=V`), "tiktok");
    expect(loc(res).pathname).toBe("/all-channels/channels/new");
    expect(loc(res).searchParams.get("connect")).toBe("bad_state");
    expect(pending.pendingCount()).toBe(0);
  });
  it("without the flag the classic callback stores immediately, as before", async () => {
    fakeTiktok();
    const res = await finishSocialConnect(cb("tiktok", `tt_oauth_nonce=${NONCE}; tt_oauth_pkce=V`, false), "tiktok");
    expect(loc(res).searchParams.get("social")).toBe("connected");
    expect(s.stored).toHaveLength(1);
  });
});

describe("confirm", () => {
  async function held(platform: "tiktok" | "instagram" = "tiktok") {
    if (platform === "tiktok") fakeTiktok();
    else fakeInstagram();
    const res = await finishSocialConnect(cb(platform, platform === "tiktok" ? `tt_oauth_nonce=${NONCE}; tt_oauth_pkce=V` : `ig_oauth_nonce=${NONCE}`), platform);
    return handleOf(res);
  }
  it("stores the held grant through the existing helper and audits it by the existing action", async () => {
    const handle = await held();
    expect(await confirmSocialPick({ userId: "u1", handle, platform: "tiktok" })).toEqual({ result: "connected", platform: "tiktok" });
    expect(s.stored[0]).toMatchObject({ orgId: ORG, platform: "tiktok", accessToken: "act.SECRET", refreshToken: "rft.SECRET" });
    expect(s.audits.map((a) => a.action)).toEqual(["social.tiktok.connect"]);
    expect(JSON.stringify(s.audits)).not.toMatch(/SECRET/);
  });
  it("is single use", async () => {
    const handle = await held();
    await confirmSocialPick({ userId: "u1", handle, platform: "tiktok" });
    expect((await confirmSocialPick({ userId: "u1", handle, platform: "tiktok" })).result).toBe("expired");
    expect(s.stored).toHaveLength(1);
  });
  it("refuses a screen for the other platform, another user, and a lost role", async () => {
    const handle = await held();
    expect((await confirmSocialPick({ userId: "u1", handle, platform: "instagram" })).result).toBe("expired");
    expect((await confirmSocialPick({ userId: "u1", handle, platform: "tiktok" })).result).toBe("expired");
    const again = await held();
    expect((await confirmSocialPick({ userId: "u2", handle: again, platform: "tiktok" })).result).toBe("expired");
    s.role = { ok: false, status: 403, error: "forbidden" };
    expect((await confirmSocialPick({ userId: "u1", handle: again, platform: "tiktok" })).result).toBe("forbidden");
    expect(s.stored).toEqual([]);
  });
  it("lets a failed store be tried again and says unavailable when the table is missing", async () => {
    const handle = await held();
    s.storeResult = "failed";
    expect((await confirmSocialPick({ userId: "u1", handle, platform: "tiktok" })).result).toBe("failed");
    s.storeResult = "not_available";
    expect((await confirmSocialPick({ userId: "u1", handle, platform: "tiktok" })).result).toBe("unavailable");
    s.storeResult = "connected";
    expect((await confirmSocialPick({ userId: "u1", handle, platform: "tiktok" })).result).toBe("connected");
    expect(s.audits.map((a) => a.action)).toEqual(["social.tiktok.connect_failed", "social.tiktok.connect_failed", "social.tiktok.connect"]);
  });
});
