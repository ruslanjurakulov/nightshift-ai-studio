/**
 * Breach, PR #862 (Instagram API with Unified Login): the OAuth state / nonce, the open redirect, the pick hold, and
 * which IG account ends up bound to which workspace. Route-level, with fetch mocked: nothing here calls Meta.
 *
 * Every test here is an attack that the change is expected to refuse; one that starts failing is a hole.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90";
const OFF_LIST = "11111111-2222-4333-8444-555555555555";
const NONCE = "n".repeat(32);
const TOKEN = "EAAB-BISU-SECRET-TOKEN";
const CODE = "AQD-attacker-code-SECRET";

const s = {
  user: { id: "u1" } as { id: string } | null,
  orgId: ORG,
  role: { ok: true, role: "editor", orgId: ORG, source: "org" } as unknown,
  stored: [] as Record<string, unknown>[],
  audits: [] as unknown[],
  storeDelay: 0,
};

vi.mock("@/lib/supabase/server", () => ({ getUser: async () => s.user, createClient: async () => null }));
vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => ({
    supported: true,
    orgs: [],
    current: { id: s.orgId, name: "A", slug: "a", role: "editor", is_default: false },
  }),
}));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => s.role }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async (e: unknown) => void s.audits.push(e) }));
vi.mock("@/lib/server/social-accounts", () => ({
  storeSocialAccount: async (o: Record<string, unknown>) => {
    if (s.storeDelay) await new Promise((r) => setTimeout(r, s.storeDelay));
    s.stored.push(o);
    return { result: "connected", accountId: "acc-1" };
  },
}));

process.env.INSTAGRAM_APP_ID = "1234567890";
process.env.INSTAGRAM_APP_SECRET = "ig-app-SECRET";
process.env.INSTAGRAM_CONFIG_ID = "987654321012345";
process.env.INSTAGRAM_UNIFIED_ORGS = ORG;
process.env.TIKTOK_CLIENT_KEY = "ttkey";
process.env.TIKTOK_CLIENT_SECRET = "tt-SECRET";
process.env.APP_ORIGIN = "https://nightshift-ai.studio";

const { startSocialConnect, finishSocialConnect, confirmSocialPick } = await import("../lib/server/social-connect");
const { encodeSocialState, decodeSocialState } = await import("../lib/server/social-oauth");
const pending = await import("../lib/server/connect-pending");

const APP = "https://nightshift-ai.studio";
const EVIL = "https://evil.example";
const loc = (r: Response) => new URL(r.headers.get("location") ?? "");
const setCookies = (r: Response) => r.headers.getSetCookie().join("\n");
const handleOf = (r: Response) => /ns_connect_pending=([^;]+)/.exec(setCookies(r))?.[1];

function callback(platform: "instagram" | "tiktok", q: Record<string, string>, cookie = "", base = APP, headers: Record<string, string> = {}) {
  const u = new URL(`${base}/api/oauth/${platform}/callback`);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return new Request(u, { headers: { ...(cookie ? { cookie } : {}), ...headers } });
}
const igState = (extra: Record<string, unknown> = {}) => encodeSocialState({ org: ORG, nonce: NONCE, ...extra });

function fakeMeta(accounts: { id: unknown; username?: string }[] = [{ id: "17841400000000001", username: "brand" }], biz: unknown = "555") {
  const f = vi.spyOn(globalThis, "fetch");
  f.mockResolvedValueOnce(Response.json({ access_token: TOKEN, token_type: "bearer" }));
  f.mockResolvedValueOnce(Response.json({ client_business_id: biz }));
  f.mockResolvedValueOnce(Response.json({ data: accounts }));
  return f;
}

beforeEach(() => {
  vi.restoreAllMocks();
  s.user = { id: "u1" };
  s.orgId = ORG;
  s.role = { ok: true, role: "editor", orgId: ORG, source: "org" };
  s.stored = [];
  s.audits = [];
  s.storeDelay = 0;
  process.env.INSTAGRAM_UNIFIED_ORGS = ORG;
  pending.dropUserPending("u1");
  pending.dropUserPending("u2");
});

describe("OAuth state and CSRF", () => {
  it("a forged state (not base64 JSON, wrong shape, extra authority fields, oversized) never reaches Meta", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    const forged = [
      "",
      "not-base64!!",
      Buffer.from(JSON.stringify({ org: "x", nonce: NONCE })).toString("base64url"),
      Buffer.from(JSON.stringify({ org: ORG, nonce: "short" })).toString("base64url"),
      Buffer.from(JSON.stringify({ org: ORG, nonce: NONCE, pad: "x".repeat(600) })).toString("base64url"),
    ];
    for (const st of forged) {
      const res = await finishSocialConnect(callback("instagram", { code: CODE, state: st }, `ig_oauth_nonce=${NONCE}`), "instagram");
      expect(loc(res).searchParams.get("social")).toBe("bad_state");
    }
    // Extra fields are dropped by the decoder: a state cannot carry a user, a platform or a target.
    expect(decodeSocialState(Buffer.from(JSON.stringify({ org: ORG, nonce: NONCE, user: "u9", platform: "tiktok", next: EVIL })).toString("base64url"))).toEqual({
      org: ORG,
      nonce: NONCE,
    });
    expect(f).not.toHaveBeenCalled();
    expect(s.stored).toEqual([]);
  });

  it("a TikTok nonce cookie does not open the Instagram callback (and the reverse): the cookies are per platform", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    const ig = await finishSocialConnect(callback("instagram", { code: CODE, state: igState() }, `tt_oauth_nonce=${NONCE}`), "instagram");
    expect(loc(ig).searchParams.get("social")).toBe("bad_state");
    const tt = await finishSocialConnect(callback("tiktok", { code: CODE, state: igState() }, `ig_oauth_nonce=${NONCE}; tt_oauth_pkce=V`), "tiktok");
    expect(loc(tt).searchParams.get("social")).toBe("bad_state");
    expect(f).not.toHaveBeenCalled();
  });

  it("login CSRF: the attacker's code + state in the victim's browser (victim's own nonce cookie, or none) binds nothing", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    // The attacker started a connect in their own browser and knows their own nonce, not the victim's.
    const attackerState = encodeSocialState({ org: ORG, nonce: "a".repeat(32) });
    for (const cookie of ["", `ig_oauth_nonce=${"v".repeat(32)}`]) {
      const res = await finishSocialConnect(callback("instagram", { code: CODE, state: attackerState }, cookie), "instagram");
      expect(loc(res).searchParams.get("social")).toBe("bad_state");
    }
    expect(f).not.toHaveBeenCalled();
    expect(s.stored).toEqual([]);
  });

  it("a state minted in another workspace, or a user who switched workspace mid-flow, is refused before the exchange", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    const other = await finishSocialConnect(
      callback("instagram", { code: CODE, state: encodeSocialState({ org: OFF_LIST, nonce: NONCE }) }, `ig_oauth_nonce=${NONCE}`),
      "instagram",
    );
    expect(loc(other).searchParams.get("social")).toBe("bad_state");
    // Started in ORG (allowlisted), now viewing OFF_LIST, with a state hand-edited to OFF_LIST: refused by the allowlist.
    s.orgId = OFF_LIST;
    s.role = { ok: true, role: "editor", orgId: OFF_LIST, source: "org" };
    const edited = await finishSocialConnect(
      callback("instagram", { code: CODE, state: encodeSocialState({ org: OFF_LIST, nonce: NONCE }) }, `ig_oauth_nonce=${NONCE}`),
      "instagram",
    );
    expect(loc(edited).searchParams.get("social")).toBe("not_configured");
    expect(f).not.toHaveBeenCalled();
  });

  it("a callback reached directly, without a start, by a viewer of an allowlisted workspace is refused before the exchange", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    s.role = { ok: false, status: 403, error: "forbidden" };
    const res = await finishSocialConnect(callback("instagram", { code: CODE, state: igState() }, `ig_oauth_nonce=${NONCE}`), "instagram");
    expect(loc(res).searchParams.get("social")).toBe("forbidden");
    expect(f).not.toHaveBeenCalled();
  });

  it("the authorization code is never echoed: not in the redirect, not in a cookie, not in the audit", async () => {
    fakeMeta();
    const res = await finishSocialConnect(callback("instagram", { code: CODE, state: igState() }, `ig_oauth_nonce=${NONCE}`), "instagram");
    expect(loc(res).searchParams.get("social")).toBe("connected");
    const out = `${res.headers.get("location")}\n${setCookies(res)}\n${JSON.stringify(s.audits)}`;
    expect(out).not.toContain(CODE);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("ig-app-SECRET");
    // The nonce is spent in the browser.
    expect(setCookies(res)).toMatch(/ig_oauth_nonce=;/);
  });
});

describe("open redirect and redirect_uri", () => {
  it("start ignores next / return_to / redirect / redirect_uri and a spoofed Host: only APP_ORIGIN is used", async () => {
    const res = await startSocialConnect(
      new Request(`${EVIL}/api/oauth/instagram/start?next=${EVIL}&return_to=${EVIL}&redirect=${EVIL}&redirect_uri=${EVIL}/cb`, {
        headers: { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
      }),
      "instagram",
    );
    const to = loc(res);
    expect(to.origin + to.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(to.searchParams.get("redirect_uri")).toBe(`${APP}/api/oauth/instagram/callback`);
    expect([...to.searchParams.keys()].sort()).toEqual(["client_id", "config_id", "redirect_uri", "response_type", "state"]);
    expect(decodeSocialState(to.searchParams.get("state"))).toEqual({ org: ORG, nonce: expect.any(String) });
  });

  it("the exchange's redirect_uri and every callback redirect use APP_ORIGIN, whatever the Host header says", async () => {
    const f = fakeMeta();
    const res = await finishSocialConnect(
      callback("instagram", { code: CODE, state: igState(), next: EVIL, return_to: EVIL }, `ig_oauth_nonce=${NONCE}`, EVIL, {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
      }),
      "instagram",
    );
    expect(loc(res).origin).toBe(APP);
    const exchange = new URL(String(f.mock.calls[0][0]));
    expect(exchange.origin + exchange.pathname).toBe("https://graph.facebook.com/v27.0/oauth/access_token");
    expect(exchange.searchParams.get("redirect_uri")).toBe(`${APP}/api/oauth/instagram/callback`);
    // Every Meta call stays on graph.facebook.com: the answer cannot steer the server to another host.
    for (const [u] of f.mock.calls) expect(new URL(String(u)).host).toBe("graph.facebook.com");
  });

  it("a denied consent (or an attacker's ?error= link) goes to the fixed page and echoes nothing", async () => {
    const res = await finishSocialConnect(
      callback("instagram", { error: `${EVIL}/x`, error_description: "<script>", state: igState({ pick: true }) }),
      "instagram",
    );
    expect(loc(res).origin).toBe(APP);
    expect(res.headers.get("location")).not.toMatch(/evil|script/);
  });
});

describe("Meta's answer cannot choose a foreign account id", () => {
  it("non-numeric, path-like and duplicated ids are dropped; the list is capped; a bad portfolio id is null", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: String(17841400000000100 + i * 1000) }));
    fakeMeta(
      [{ id: "../../me" }, { id: "1784 OR 1=1" }, { id: "17841400000000001" }, { id: "17841400000000001" }, ...many],
      "555; drop",
    );
    const res = await finishSocialConnect(callback("instagram", { code: CODE, state: igState() }, `ig_oauth_nonce=${NONCE}`), "instagram");
    const held = pending.readPending(handleOf(res), { userId: "u1", orgId: ORG });
    if (!held || held.grant.platform === "youtube") throw new Error("expected a held Instagram grant");
    const ids = held.grant.profiles.map((p) => p.externalId);
    expect(ids.length).toBe(50);
    expect(new Set(ids).size).toBe(50);
    expect(ids.every((x) => /^[0-9]{1,64}$/.test(x))).toBe(true);
    expect(held.grant.instagram).toEqual({ clientBusinessId: null, configId: "987654321012345" });
  });
});

describe("the pick hold", () => {
  async function holdTwo(user = "u1") {
    s.user = { id: user };
    fakeMeta([
      { id: "17841400000000001", username: "first" },
      { id: "17841400000000002", username: "second" },
    ]);
    const res = await finishSocialConnect(callback("instagram", { code: CODE, state: igState() }, `ig_oauth_nonce=${NONCE}`), "instagram");
    return handleOf(res) as string;
  }

  it("a portfolio with several accounts is held (not stored) even from the Channels page, and the hold holds no token in the browser", async () => {
    const handle = await holdTwo();
    expect(s.stored).toEqual([]);
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(handle).not.toContain(TOKEN);
  });

  it("confirm with an id not in the held list (another org's, or never offered) stores nothing", async () => {
    const handle = await holdTwo();
    for (const externalId of ["17841499999999999", "17841400000000001 ", "17841400000000001\u0000", "*"]) {
      const out = await confirmSocialPick({ userId: "u1", handle, platform: "instagram", externalId });
      expect(out.result).toBe("not_in_list");
    }
    expect(s.stored).toEqual([]);
  });

  it("another user's hold, or the same user's hold seen from another workspace, reads as expired", async () => {
    const handle = await holdTwo("u1");
    expect((await confirmSocialPick({ userId: "u2", handle, platform: "instagram", externalId: "17841400000000001" })).result).toBe("expired");
    s.orgId = OFF_LIST;
    s.role = { ok: true, role: "editor", orgId: OFF_LIST, source: "org" };
    process.env.INSTAGRAM_UNIFIED_ORGS = `${ORG},${OFF_LIST}`;
    expect((await confirmSocialPick({ userId: "u1", handle, platform: "instagram", externalId: "17841400000000001" })).result).toBe("expired");
    expect(s.stored).toEqual([]);
  });

  it("an expired hold cannot be confirmed", async () => {
    const handle = await holdTwo();
    const later = Date.now() + pending.PENDING_TTL_MS + 1;
    expect(pending.claimPending(handle, { userId: "u1", orgId: ORG }, later)).toBeNull();
    expect((await confirmSocialPick({ userId: "u1", handle, platform: "instagram", externalId: "17841400000000001" })).result).toBe("expired");
    expect(s.stored).toEqual([]);
  });

  it("two confirms racing (two tabs, two accounts) store exactly one; the other is 'busy', never a second write", async () => {
    const handle = await holdTwo();
    s.storeDelay = 20;
    const [a, b] = await Promise.all([
      confirmSocialPick({ userId: "u1", handle, platform: "instagram", externalId: "17841400000000001" }),
      confirmSocialPick({ userId: "u1", handle, platform: "instagram", externalId: "17841400000000002" }),
    ]);
    expect([a.result, b.result].sort()).toEqual(["busy", "connected"]);
    expect(s.stored).toHaveLength(1);
    // Lens M2: the hold stays for the other account of the same sign-in, and the used one cannot be stored twice.
    const usedId = (s.stored[0] as { profile: { externalId: string } }).profile.externalId;
    const otherId = usedId === "17841400000000001" ? "17841400000000002" : "17841400000000001";
    expect((await confirmSocialPick({ userId: "u1", handle, platform: "instagram", externalId: usedId })).result).toBe("not_in_list");
    expect(await confirmSocialPick({ userId: "u1", handle, platform: "instagram", externalId: otherId })).toMatchObject({ result: "connected", remaining: 0 });
    expect(s.stored).toHaveLength(2);
    // Every account used: the hold (and its token) is gone.
    expect((await confirmSocialPick({ userId: "u1", handle, platform: "instagram", externalId: otherId })).result).toBe("expired");
    expect(pending.readPending(handle, { userId: "u1", orgId: ORG })).toBeNull();
  });

  it("a workspace taken off the allowlist while the pick was open cannot confirm, and the held token is dropped", async () => {
    const handle = await holdTwo();
    process.env.INSTAGRAM_UNIFIED_ORGS = "";
    expect((await confirmSocialPick({ userId: "u1", handle, platform: "instagram", externalId: "17841400000000001" })).result).toBe("not_configured");
    expect(pending.readPending(handle, { userId: "u1", orgId: ORG })).toBeNull();
    expect(s.stored).toEqual([]);
  });

  it("a confirm whose role was lost (editor -> viewer) stores nothing", async () => {
    const handle = await holdTwo();
    s.role = { ok: false, status: 403, error: "forbidden" };
    expect((await confirmSocialPick({ userId: "u1", handle, platform: "instagram", externalId: "17841400000000001" })).result).toBe("forbidden");
    expect(s.stored).toEqual([]);
  });

  it("the confirm stores the chosen account with the deployment's configuration, never one the browser names", async () => {
    const handle = await holdTwo();
    await confirmSocialPick({ userId: "u1", handle, platform: "instagram", externalId: "17841400000000002" });
    expect(s.stored).toEqual([
      expect.objectContaining({
        orgId: ORG,
        profile: expect.objectContaining({ externalId: "17841400000000002" }),
        instagram: { clientBusinessId: "555", configId: "987654321012345" },
      }),
    ]);
    expect(JSON.stringify(s.audits)).not.toContain(TOKEN);
  });
});
