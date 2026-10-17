import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const s = {
  user: { id: "u1" } as { id: string } | null,
  yt: [] as unknown[],
  social: [] as unknown[],
};
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => s.user, createClient: async () => null }));
vi.mock("@/lib/server/connect-youtube", () => ({
  confirmYoutubePick: async (o: unknown) => {
    s.yt.push(o);
    return { result: "connected", channelId: "extinctworld" };
  },
}));
vi.mock("@/lib/server/social-connect", () => ({
  confirmSocialPick: async (o: unknown) => {
    s.social.push(o);
    return { result: "expired", platform: null };
  },
}));
delete process.env.APP_ORIGIN;

const { POST } = await import("../app/api/connect/pending/route");
const pending = await import("../lib/server/connect-pending");

const ORIGIN = "https://nightshift-ai.studio";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request(`${ORIGIN}/api/connect/pending`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: `${pending.PENDING_COOKIE}=HANDLE`, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  s.user = { id: "u1" };
  s.yt = [];
  s.social = [];
});

describe("POST /api/connect/pending", () => {
  it("401s a signed-out caller before reading anything", async () => {
    s.user = null;
    expect((await post({ action: "cancel" })).status).toBe(401);
  });
  it("refuses a cross-site post even with the cookies attached", async () => {
    expect((await post({ action: "cancel" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ action: "cancel" }, { origin: ORIGIN })).status).toBe(200);
  });
  it("passes only the handle cookie and the chosen id to the server half", async () => {
    const res = await post({ action: "confirm", platform: "youtube", channel_id: "UC1234567890abcdefghijkl", token: "x", org: "y" });
    expect(await res.json()).toEqual({ ok: true, result: "connected", channel_id: "extinctworld" });
    expect(s.yt).toEqual([{ userId: "u1", handle: "HANDLE", youtubeChannelId: "UC1234567890abcdefghijkl" }]);
    // Spent. A __Host- cookie is only cleared by a Secure Set-Cookie, so the clear carries Secure.
    expect(res.headers.getSetCookie().join("\n")).toMatch(/__Host-ns_connect_pending=;(?=.*Secure)/is);
  });
  it("rejects a malformed id, an unknown action or platform, and a body that is not JSON", async () => {
    expect((await post({ action: "confirm", platform: "youtube", channel_id: "../x" })).status).toBe(400);
    expect((await post({ action: "confirm", platform: "youtube" })).status).toBe(400);
    expect((await post({ action: "delete" })).status).toBe(400);
    expect((await post({ action: "confirm", platform: "myspace" })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect(s.yt).toEqual([]);
  });
  it("answers an expired authorisation with 410 and our own word only", async () => {
    const res = await post({ action: "confirm", platform: "instagram" });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ ok: false, result: "expired" });
    expect(s.social).toEqual([{ userId: "u1", handle: "HANDLE", platform: "instagram" }]);
  });
  it("cancel drops the user's held authorisation and clears the cookie", async () => {
    const h = pending.createPending({
      userId: "u1",
      orgId: "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90",
      grant: { platform: "tiktok", accessToken: "a", refreshToken: null, accessExpiresIn: null, refreshExpiresIn: null, scopes: [], profile: { externalId: "1", username: null, displayName: null, avatarUrl: null } },
    });
    const res = await post({ action: "cancel" });
    expect(res.headers.getSetCookie().join("\n")).toMatch(/ns_connect_pending=;/);
    expect(pending.readPending(h, { userId: "u1", orgId: "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90" })).toBeNull();
  });
});
