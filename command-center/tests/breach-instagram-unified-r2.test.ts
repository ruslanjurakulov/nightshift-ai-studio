/**
 * Breach, PR #862 round 2: the pick hold that now outlives a confirm (markPendingUsed + the pending route's
 * `remaining`), the callback checking state and nonce before `?error=`, and paging on /me/assigned_instagram_accounts.
 * Route-level, fetch mocked: nothing here calls Meta.
 *
 * Every test is an attack the change is expected to refuse; one that starts failing is a hole.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90";
const OTHER = "11111111-2222-4333-8444-555555555555";
const NONCE = "n".repeat(32);
const TOKEN = "EAAB-BISU-SECRET-TOKEN";
const CODE = "AQD-code";
const A1 = "17841400000000001";
const A2 = "17841400000000002";
const A3 = "17841400000000003";

const s = {
  user: { id: "u1" } as { id: string } | null,
  orgId: ORG,
  role: { ok: true, role: "editor", orgId: ORG, source: "org" } as unknown,
  stored: [] as Record<string, unknown>[],
  storeDelay: 0,
  storeResult: "connected",
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
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/server/connect-youtube", () => ({ confirmYoutubePick: async () => ({ result: "expired" }) }));
vi.mock("@/lib/server/social-accounts", () => ({
  storeSocialAccount: async (o: Record<string, unknown>) => {
    if (s.storeDelay) await new Promise((r) => setTimeout(r, s.storeDelay));
    if (s.storeResult !== "connected") return { result: s.storeResult, accountId: null };
    s.stored.push(o);
    return { result: "connected", accountId: `acc-${s.stored.length}` };
  },
}));

process.env.INSTAGRAM_APP_ID = "1234567890";
process.env.INSTAGRAM_APP_SECRET = "ig-app-SECRET";
process.env.INSTAGRAM_CONFIG_ID = "987654321012345";
process.env.INSTAGRAM_UNIFIED_ORGS = ORG;
process.env.TIKTOK_CLIENT_KEY = "ttkey";
process.env.TIKTOK_CLIENT_SECRET = "tt-SECRET";
process.env.APP_ORIGIN = "https://nightshift-ai.studio";

const { finishSocialConnect, confirmSocialPick } = await import("../lib/server/social-connect");
const { encodeSocialState, fetchInstagramAccounts } = await import("../lib/server/social-oauth");
const pending = await import("../lib/server/connect-pending");
const { POST } = await import("../app/api/connect/pending/route");

const APP = "https://nightshift-ai.studio";
const setCookies = (r: Response) => r.headers.getSetCookie().join("\n");
const handleOf = (r: Response) => /ns_connect_pending=([^;]+)/.exec(setCookies(r))?.[1];
const st = (extra: Record<string, unknown> = {}) => encodeSocialState({ org: ORG, nonce: NONCE, ...extra });

function callback(platform: "instagram" | "tiktok", q: Record<string, string>, cookie = "") {
  const u = new URL(`${APP}/api/oauth/${platform}/callback`);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return new Request(u, { headers: cookie ? { cookie } : {} });
}

function fakeMeta(ids: string[]) {
  const f = vi.spyOn(globalThis, "fetch");
  f.mockResolvedValueOnce(Response.json({ access_token: TOKEN }));
  f.mockResolvedValueOnce(Response.json({ client_business_id: "555" }));
  f.mockResolvedValueOnce(Response.json({ data: ids.map((id) => ({ id, username: `u${id.slice(-1)}` })) }));
  return f;
}

async function holdThree(user = "u1"): Promise<string> {
  s.user = { id: user };
  fakeMeta([A1, A2, A3]);
  const res = await finishSocialConnect(callback("instagram", { code: CODE, state: st() }, `ig_oauth_nonce=${NONCE}`), "instagram");
  vi.restoreAllMocks();
  return handleOf(res) as string;
}

const routePost = (handle: string, body: unknown) =>
  POST(
    new Request(`${APP}/api/connect/pending`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP, cookie: `${pending.PENDING_COOKIE}=${handle}` },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.restoreAllMocks();
  s.user = { id: "u1" };
  s.orgId = ORG;
  s.role = { ok: true, role: "editor", orgId: ORG, source: "org" };
  s.stored = [];
  s.storeDelay = 0;
  s.storeResult = "connected";
  process.env.INSTAGRAM_UNIFIED_ORGS = ORG;
  pending.dropUserPending("u1");
  pending.dropUserPending("u2");
});

describe("r2: the hold that stays open after a confirm", () => {
  it("the same account confirmed twice, or by its used id with odd spacing/case, is stored once", async () => {
    const h = await holdThree();
    expect((await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A1 })).result).toBe("connected");
    for (const id of [A1, ` ${A1}`, `${A1} `]) {
      expect((await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: id })).result).toBe("not_in_list");
    }
    expect(s.stored).toHaveLength(1);
  });

  it("with no external_id after one of three is used, the server does not guess between the two left", async () => {
    const h = await holdThree();
    await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A1 });
    expect((await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram" })).result).toBe("not_in_list");
    expect(s.stored).toHaveLength(1);
  });

  it("N confirms racing for the same account store it exactly once", async () => {
    const h = await holdThree();
    s.storeDelay = 15;
    const outs = await Promise.all(
      Array.from({ length: 8 }, () => confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A2 })),
    );
    expect(outs.filter((o) => o.result === "connected")).toHaveLength(1);
    expect(outs.filter((o) => o.result === "busy")).toHaveLength(7);
    expect(s.stored).toHaveLength(1);
    // After the race, the same account again is refused, never a second row.
    expect((await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A2 })).result).toBe("not_in_list");
  });

  it("N confirms racing for every account store each one at most once, and the hold dies when all are used", async () => {
    const h = await holdThree();
    s.storeDelay = 5;
    for (let round = 0; round < 4; round++) {
      await Promise.all([A1, A2, A3, A1, A2, A3].map((id) => confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: id })));
    }
    const ids = s.stored.map((o) => (o.profile as { externalId: string }).externalId).sort();
    expect(ids).toEqual([A1, A2, A3]);
    expect(pending.readPending(h, { userId: "u1", orgId: ORG })).toBeNull();
    expect(pending.pendingCount()).toBe(0);
  });

  it("after the first confirm, the allowlist removed drops the hold: the second account is not stored", async () => {
    const h = await holdThree();
    await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A1 });
    process.env.INSTAGRAM_UNIFIED_ORGS = "";
    expect((await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A2 })).result).toBe("not_configured");
    process.env.INSTAGRAM_UNIFIED_ORGS = ORG;
    expect((await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A2 })).result).toBe("expired");
    expect(s.stored).toHaveLength(1);
  });

  it("after the first confirm, the role lost stores nothing more", async () => {
    const h = await holdThree();
    await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A1 });
    s.role = { ok: false, status: 403, error: "forbidden" };
    expect((await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A2 })).result).toBe("forbidden");
    expect(s.stored).toHaveLength(1);
  });

  it("a store refused as forbidden by the database mid-way ends the hold (no retry with the same token)", async () => {
    const h = await holdThree();
    await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A1 });
    s.storeResult = "forbidden";
    expect((await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A2 })).result).toBe("forbidden");
    s.storeResult = "connected";
    expect((await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A3 })).result).toBe("expired");
    expect(s.stored).toHaveLength(1);
  });

  it("after a confirm, another user, another workspace, or the wrong platform cannot use the rest of the hold", async () => {
    const h = await holdThree("u1");
    await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A1 });
    expect((await confirmSocialPick({ userId: "u2", handle: h, platform: "instagram", externalId: A2 })).result).toBe("expired");
    s.orgId = OTHER;
    s.role = { ok: true, role: "owner", orgId: OTHER, source: "org" };
    process.env.INSTAGRAM_UNIFIED_ORGS = `${ORG},${OTHER}`;
    expect((await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A2 })).result).toBe("expired");
    s.orgId = ORG;
    s.role = { ok: true, role: "editor", orgId: ORG, source: "org" };
    // A TikTok-labelled confirm against the Instagram hold spends it, never stores into TikTok.
    expect((await confirmSocialPick({ userId: "u1", handle: h, platform: "tiktok", externalId: A2 })).result).toBe("expired");
    expect((await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A2 })).result).toBe("expired");
    expect(s.stored.map((o) => o.orgId)).toEqual([ORG]);
  });

  it("every extra account of the hold is stored into the workspace the sign-in started in, as its own call", async () => {
    const h = await holdThree();
    for (const id of [A1, A2, A3]) await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: id });
    expect(s.stored.map((o) => [o.orgId, (o.profile as { externalId: string }).externalId])).toEqual([
      [ORG, A1],
      [ORG, A2],
      [ORG, A3],
    ]);
  });

  it("confirming does not extend the hold: it still ends ten minutes after the sign-in", async () => {
    const h = await holdThree();
    const before = pending.readPending(h, { userId: "u1", orgId: ORG })?.expiresAt;
    await confirmSocialPick({ userId: "u1", handle: h, platform: "instagram", externalId: A1 });
    const after = pending.readPending(h, { userId: "u1", orgId: ORG })?.expiresAt;
    expect(after).toBe(before);
    const late = (before as number) + 1;
    expect(pending.claimPending(h, { userId: "u1", orgId: ORG }, late)).toBeNull();
  });

  it("the route's `remaining` answer carries a count only, keeps the cookie untouched until the last, then clears it", async () => {
    const h = await holdThree();
    const r1 = await routePost(h, { action: "confirm", platform: "instagram", external_id: A1 });
    const b1 = await r1.text();
    expect(JSON.parse(b1)).toEqual({ ok: true, result: "connected", remaining: 2 });
    expect(b1).not.toContain(h);
    expect(b1).not.toContain(TOKEN);
    // No Set-Cookie at all: the hold's cookie is not re-issued with a fresh max-age.
    expect(setCookies(r1)).toBe("");
    await routePost(h, { action: "confirm", platform: "instagram", external_id: A2 });
    const r3 = await routePost(h, { action: "confirm", platform: "instagram", external_id: A3 });
    expect(await r3.json()).toEqual({ ok: true, result: "connected", remaining: 0 });
    expect(setCookies(r3)).toMatch(/__Host-ns_connect_pending=;/);
    // The handle after all accounts are used is dead.
    const r4 = await routePost(h, { action: "confirm", platform: "instagram", external_id: A3 });
    expect((await r4.json()).result).toBe("expired");
    expect(s.stored).toHaveLength(3);
  });

  it("a new sign-in by the same user replaces a half-used hold: the old handle reads nothing", async () => {
    const h1 = await holdThree();
    await confirmSocialPick({ userId: "u1", handle: h1, platform: "instagram", externalId: A1 });
    const h2 = await holdThree();
    expect((await confirmSocialPick({ userId: "u1", handle: h1, platform: "instagram", externalId: A2 })).result).toBe("expired");
    // The new hold starts with nothing used: A1 may be reconfirmed from the fresh sign-in (an upsert of the same row).
    expect(pending.readPending(h2, { userId: "u1", orgId: ORG })?.grant).not.toHaveProperty("used");
  });
});

describe("r2: state and nonce before ?error=", () => {
  for (const platform of ["instagram", "tiktok"] as const) {
    const nonceName = platform === "instagram" ? "ig_oauth_nonce" : "tt_oauth_nonce";

    it(`${platform}: a forged, foreign or absent state with ?error= keeps the person's nonce (and PKCE)`, async () => {
      const f = vi.spyOn(globalThis, "fetch");
      const cookie = `${nonceName}=${NONCE}; tt_oauth_pkce=${"v".repeat(43)}`;
      const queries: Record<string, string>[] = [
        { error: "access_denied" },
        { error: "access_denied", state: "garbage" },
        { error: "access_denied", state: encodeSocialState({ org: ORG, nonce: "x".repeat(32) }) },
        { error: "access_denied", state: encodeSocialState({ org: ORG, nonce: "x".repeat(32), pick: true }) },
      ];
      for (const q of queries) {
        const res = await finishSocialConnect(callback(platform, q, cookie), platform);
        expect(new URL(res.headers.get("location") ?? "").search).toMatch(/bad_state/);
        expect(setCookies(res)).not.toMatch(new RegExp(`${nonceName}=;`));
        expect(setCookies(res)).not.toMatch(/tt_oauth_pkce=;/);
      }
      expect(f).not.toHaveBeenCalled();
    });

    it(`${platform}: a real decline with our state spends the nonce and reports denied, without any exchange`, async () => {
      const f = vi.spyOn(globalThis, "fetch");
      const res = await finishSocialConnect(
        callback(platform, { error: "access_denied", code: CODE, state: st() }, `${nonceName}=${NONCE}; tt_oauth_pkce=${"v".repeat(43)}`),
        platform,
      );
      expect(res.headers.get("location")).toMatch(/denied/);
      expect(setCookies(res)).toMatch(new RegExp(`${nonceName}=;`));
      if (platform === "tiktok") expect(setCookies(res)).toMatch(/tt_oauth_pkce=;/);
      expect(setCookies(res)).not.toMatch(/ns_connect_pending=[A-Za-z0-9_-]/);
      // ?error= with a code beside it never exchanges the code: a valid state does not skip to the store.
      expect(f).not.toHaveBeenCalled();
      expect(s.stored).toEqual([]);
    });
  }

  it("an empty ?error= with our state does not count as a decline but still runs every later check", async () => {
    // error="" is falsy: the flow continues to the org / allowlist / code checks, which still refuse a missing code.
    const f = vi.spyOn(globalThis, "fetch");
    const res = await finishSocialConnect(callback("instagram", { error: "", state: st() }, `ig_oauth_nonce=${NONCE}`), "instagram");
    expect(res.headers.get("location")).toMatch(/bad_state/);
    expect(f).not.toHaveBeenCalled();
  });

  it("our state + ?error= from a user now off the allowlist / not an editor still only says denied and stores nothing", async () => {
    s.role = { ok: false, status: 403, error: "forbidden" };
    process.env.INSTAGRAM_UNIFIED_ORGS = "";
    const res = await finishSocialConnect(callback("instagram", { error: "x", state: st() }, `ig_oauth_nonce=${NONCE}`), "instagram");
    expect(res.headers.get("location")).toMatch(/denied/);
    expect(s.stored).toEqual([]);
  });
});

describe("r2: paging on /me/assigned_instagram_accounts", () => {
  function pages(first: unknown, ...rest: unknown[]) {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({ client_business_id: "555" }));
    f.mockResolvedValueOnce(Response.json(first));
    for (const p of rest) f.mockResolvedValueOnce(Response.json(p));
    return f;
  }
  const hosts = (f: ReturnType<typeof vi.spyOn>) => f.mock.calls.map(([u]: unknown[]) => new URL(String(u)));

  it("a paging.next to another host, http, a port, userinfo, a trailing dot, or a look-alike is never fetched", async () => {
    for (const next of [
      "https://evil.example/v23.0/me?access_token=x",
      "http://graph.facebook.com/v23.0/me/assigned_instagram_accounts?after=1",
      "https://graph.facebook.com:8443/v23.0/x",
      "https://user:pass@graph.facebook.com/v23.0/x",
      "https://graph.facebook.com@evil.example/x",
      "https://graph.facebook.com./x",
      "https://graph.facebook.com.evil.example/x",
      "https://evil.example\\@graph.facebook.com/x",
      "//evil.example/x",
      "/v23.0/me",
      "javascript:alert(1)",
      "https://GRAPH.facebook.com%2eevil.example/x",
    ]) {
      vi.restoreAllMocks();
      const f = pages({ data: [{ id: A1 }], paging: { next } });
      const out = await fetchInstagramAccounts(TOKEN);
      expect(out.accounts.map((a) => a.externalId)).toEqual([A1]);
      for (const u of hosts(f)) {
        expect(u.protocol).toBe("https:");
        expect(u.host).toBe("graph.facebook.com");
        expect(u.username + u.password).toBe("");
      }
      expect(f).toHaveBeenCalledTimes(2);
    }
  });

  it("a self-referencing paging loop stops at 10 pages", async () => {
    const loop = { data: [{ id: A1 }], paging: { next: "https://graph.facebook.com/v23.0/me/assigned_instagram_accounts?after=A" } };
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({ client_business_id: "555" }));
    f.mockImplementation(async () => Response.json(loop));
    const out = await fetchInstagramAccounts(TOKEN);
    expect(out.accounts).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(1 + 10);
  });

  it("more than 50 accounts across pages are cut at 50 and no further page is fetched", async () => {
    let n = 0;
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({ client_business_id: "555" }));
    f.mockImplementation(async () =>
      Response.json({
        data: Array.from({ length: 30 }, () => ({ id: `178414${String(n++).padStart(11, "0")}` })),
        paging: { next: `https://graph.facebook.com/v23.0/me/assigned_instagram_accounts?after=${n}` },
      }),
    );
    const out = await fetchInstagramAccounts(TOKEN);
    expect(out.accounts).toHaveLength(50);
    expect(f).toHaveBeenCalledTimes(1 + 2);
  });

  it("an oversized paging.next is not followed", async () => {
    const f = pages({ data: [{ id: A1 }], paging: { next: `https://graph.facebook.com/x?${"a".repeat(5000)}` } });
    await fetchInstagramAccounts(TOKEN);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a later page that fails ends the whole read with our word only, nothing half-held", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(Response.json({ client_business_id: "555" }));
    f.mockResolvedValueOnce(Response.json({ data: [{ id: A1 }], paging: { next: "https://graph.facebook.com/v23.0/n" } }));
    f.mockResolvedValueOnce(new Response(`{"error":{"message":"${TOKEN}"}}`, { status: 500 }));
    await expect(fetchInstagramAccounts(TOKEN)).rejects.toThrow(/^failed$/);
  });
});
