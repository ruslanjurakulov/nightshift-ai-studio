import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The accounts kept on one device (lib/device-accounts.ts, lib/server/device-accounts.ts, app/api/account/accounts/*).
 *
 * What would break without these:
 * - a parked account's session readable as the active one (by RLS, by a page script) or leaking to the browser in a list;
 * - a switch that trusts the browser: a forged POST from another site, an unknown slot, a cookie edited to name another
 *   user, or a stored session the auth server refuses being read as "switch anyway" or "switch to someone else";
 * - a fourth account on one device; "log out" of one account signing out the others; "Add account" ending the session it
 *   parks instead of keeping it;
 * - one account's second factor covering another: a password-only session of an account with an authenticator must land on
 *   the code page for that account;
 * - an audit row that carries a token or an address.
 */
vi.mock("server-only", () => ({}));

type Cookie = { name: string; value: string; options?: Record<string, unknown> };

const h = vi.hoisted(() => ({
  jar: new Map<string, Cookie>(),
  active: null as null | { id: string; email: string; factors?: Array<{ status: string; factor_type: string }> },
  activeRt: "rt-active",
  setSession: [] as Array<{ access_token: string; refresh_token: string }>,
  setSessionFails: false,
  signOuts: 0,
  /** refresh_token → what the auth server answers */
  refresh: new Map<string, { user?: { id: string; email: string; factors?: Array<{ status: string; factor_type: string }> }; aal?: string; status?: number; throws?: boolean }>(),
  audits: [] as Array<Record<string, unknown>>,
}));

function jwt(aal: string) {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256" })}.${b({ aal })}.sig`;
}

vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://lab.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => h.jar.get(name),
    getAll: () => [...h.jar.values()],
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      if (options && typeof options.maxAge === "number" && options.maxAge <= 0) h.jar.delete(name);
      else h.jar.set(name, { name, value, options });
    },
  }),
  headers: async () => new Headers(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.active,
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: h.active }, error: h.active ? null : { message: "no user" } }),
      getSession: async () => ({ data: { session: h.active ? { access_token: jwt("aal2"), refresh_token: h.activeRt } : null } }),
      setSession: async (s: { access_token: string; refresh_token: string }) => {
        if (h.setSessionFails) return { error: { message: "nope" } };
        h.setSession.push(s);
        return { error: null };
      },
    },
  }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      refreshSession: async ({ refresh_token }: { refresh_token: string }) => {
        const a = h.refresh.get(refresh_token);
        if (!a) return { data: { session: null, user: null }, error: { status: 400, message: "Invalid Refresh Token" } };
        if (a.throws) throw new Error("network");
        if (a.status) return { data: { session: null, user: null }, error: { status: a.status, message: "x" } };
        return {
          data: { session: { access_token: jwt(a.aal ?? "aal1"), refresh_token: `${refresh_token}-rotated` }, user: a.user },
          error: null,
        };
      },
      setSession: async () => ({ error: null }),
      signOut: async () => {
        h.signOuts += 1;
        return { error: null };
      },
    },
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        h.audits.push(row);
        return { error: null };
      },
    }),
  }),
}));

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const lib = await import("@/lib/server/device-accounts");
const shared = await import("@/lib/device-accounts");
const paths = await import("@/lib/public-paths");
const { POST: SWITCH } = await import("../app/api/account/accounts/switch/route");
const { POST: ADD } = await import("../app/api/account/accounts/add/route");
const { POST: LOGOUT } = await import("../app/api/account/accounts/logout/route");
const { GET: LIST } = await import("../app/api/account/accounts/route");

const ORIGIN = "http://localhost";
const post = (path: string, body: unknown, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function park(slot: 1 | 2, uid: string, email: string, rt: string, extra: Record<string, unknown> = {}) {
  h.jar.set(lib.parkedCookieName(slot), {
    name: lib.parkedCookieName(slot),
    value: lib.encodeParked({ uid, email, name: null, rt, iat: 1_700_000_000, ...extra }),
  });
}
const slotOf = (slot: 1 | 2) => lib.decodeParked(h.jar.get(lib.parkedCookieName(slot))?.value);

beforeEach(() => {
  h.jar.clear();
  h.active = { id: A, email: "owner@lab.test" };
  h.activeRt = "rt-active";
  h.setSession = [];
  h.setSessionFails = false;
  h.signOuts = 0;
  h.refresh.clear();
  h.audits = [];
  h.jar.set("sb-lab-auth-token", { name: "sb-lab-auth-token", value: "active-session" });
});

describe("what the browser is shown", () => {
  it("masks an email to its first letter and domain, and never shows a malformed one", () => {
    expect(shared.maskEmail("john.doe@gmail.com")).toBe("j***@gmail.com");
    expect(shared.maskEmail("not-an-address")).toBe("***");
    expect(shared.maskEmail(null)).toBe("***");
  });

  it("lists the accounts with no token and no full address, and a parked copy of the active account only once", async () => {
    park(1, B, "customer@lab.test", "rt-secret-b");
    park(2, A, "owner@lab.test", "rt-old-a");
    const body = JSON.stringify(await (await LIST()).json());
    expect(body).not.toContain("rt-secret-b");
    expect(body).not.toContain("customer@lab.test");
    expect(body).not.toContain("owner@lab.test");
    const data = JSON.parse(body) as { accounts: Array<{ slot: number | null; current: boolean }>; canAdd: boolean };
    expect(data.accounts.map((a) => a.slot)).toEqual([null, 1]);
    expect(data.accounts[0].current).toBe(true);
  });
});

describe("a parked account can do nothing on its own", () => {
  it("is kept under a name no Supabase client reads as a session, httpOnly, and __Host- in production", () => {
    for (const slot of shared.PARKED_SLOTS) {
      for (const prod of [true, false]) expect(lib.parkedCookieName(slot, prod)).not.toMatch(/^sb-.+-auth-token/);
    }
    expect(lib.parkedCookieName(1, true)).toBe("__Host-ns_acct_1");
    expect(lib.parkedCookieOptions(true)).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  });

  it("is not a session to the real Supabase SSR client: with only a parked cookie the request is signed out (RLS sees no one)", async () => {
    const { createServerClient } = await vi.importActual<typeof import("@supabase/ssr")>("@supabase/ssr");
    const cookie = { name: lib.parkedCookieName(1, true), value: lib.encodeParked({ uid: B, email: "b@x.y", name: null, rt: "rt", iat: 1 }) };
    const client = createServerClient("https://lab.supabase.test", "anon", { cookies: { getAll: () => [cookie], setAll: () => undefined } });
    const { data } = await client.auth.getSession();
    expect(data.session).toBeNull();
  });

  it("drops a cookie that is not one of ours (edited, truncated, another version) instead of acting on it", () => {
    expect(lib.decodeParked("garbage")).toBeNull();
    expect(lib.decodeParked(Buffer.from(JSON.stringify({ v: 1, uid: "not-a-uuid", rt: "x", iat: 1 })).toString("base64url"))).toBeNull();
    expect(lib.decodeParked(Buffer.from(JSON.stringify({ v: 2, uid: B, rt: "x", iat: 1 })).toString("base64url"))).toBeNull();
  });
});

describe("POST switch", () => {
  it("refuses another site, a missing Origin, a body that is not a slot, and a slot with nothing in it", async () => {
    park(1, B, "b@lab.test", "rt-b");
    expect((await SWITCH(post("/api/account/accounts/switch", { slot: 1 }, "https://evil.example"))).status).toBe(403);
    expect((await SWITCH(post("/api/account/accounts/switch", { slot: 1 }, null))).status).toBe(403);
    for (const slot of [0, 3, "1", null, [1], 1.5]) {
      expect((await SWITCH(post("/api/account/accounts/switch", { slot })))?.status, String(slot)).toBe(400);
    }
    expect((await SWITCH(post("/api/account/accounts/switch", "not json"))).status).toBe(400);
    expect((await SWITCH(post("/api/account/accounts/switch", { slot: 2 }))).status).toBe(404);
    expect(h.setSession).toHaveLength(0);
  });

  it("switches to the parked account and parks the one that was active in its place, nothing signed out", async () => {
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    const res = await SWITCH(post("/api/account/accounts/switch", { slot: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ to: "/" });
    expect(h.setSession).toEqual([expect.objectContaining({ refresh_token: "rt-b-rotated" })]);
    expect(slotOf(1)).toMatchObject({ uid: A, rt: "rt-active" });
    expect(h.signOuts).toBe(0);
  });

  it("refuses a cookie edited to name another user than its session belongs to, and drops it", async () => {
    park(1, C, "victim@lab.test", "rt-attacker");
    h.refresh.set("rt-attacker", { user: { id: B, email: "attacker@lab.test" } });
    const res = await SWITCH(post("/api/account/accounts/switch", { slot: 1 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("account_mismatch");
    expect(h.setSession).toHaveLength(0);
    expect(slotOf(1)).toBeNull();
  });

  it("keeps a refused session as 'Sign in again' and switches to no one else", async () => {
    park(1, B, "b@lab.test", "rt-revoked");
    park(2, C, "c@lab.test", "rt-c");
    h.refresh.set("rt-c", { user: { id: C, email: "c@lab.test" } });
    const res = await SWITCH(post("/api/account/accounts/switch", { slot: 1 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("session_expired");
    expect(slotOf(1)).toMatchObject({ uid: B, stale: true });
    expect(slotOf(2)).toMatchObject({ uid: C });
    expect(h.setSession).toHaveLength(0);
    const list = (await (await LIST()).json()) as { accounts: Array<{ slot: number | null; stale: boolean }> };
    expect(list.accounts.find((a) => a.slot === 1)?.stale).toBe(true);
  });

  it("answers 503 and changes nothing when the auth server cannot be asked", async () => {
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { throws: true });
    expect((await SWITCH(post("/api/account/accounts/switch", { slot: 1 }))).status).toBe(503);
    h.refresh.set("rt-b", { status: 502 });
    expect((await SWITCH(post("/api/account/accounts/switch", { slot: 1 }))).status).toBe(503);
    expect(slotOf(1)).toMatchObject({ uid: B, rt: "rt-b" });
    expect(slotOf(1)?.stale).toBeUndefined();
    expect(h.setSession).toHaveLength(0);
  });

  it("sends a password-only session of an account with an authenticator to the code page for THAT account", async () => {
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test", factors: [{ status: "verified", factor_type: "totp" }] }, aal: "aal1" });
    expect(await (await SWITCH(post("/api/account/accounts/switch", { slot: 1 }))).json()).toEqual({ to: "/login/verify?next=%2F" });
    // The same account with its code already given goes straight home; one without a factor too.
    park(1, B, "b@lab.test", "rt-b2");
    h.refresh.set("rt-b2", { user: { id: B, email: "b@lab.test", factors: [{ status: "verified", factor_type: "totp" }] }, aal: "aal2" });
    expect(await (await SWITCH(post("/api/account/accounts/switch", { slot: 1 }))).json()).toEqual({ to: "/" });
  });

  it("records account.switch with the two user ids only", async () => {
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    await SWITCH(post("/api/account/accounts/switch", { slot: 1 }));
    expect(h.audits).toEqual([expect.objectContaining({ action: "account.switch", actor_user_id: B, actor_email: null, detail: { from: A, to: B } })]);
    expect(JSON.stringify(h.audits)).not.toMatch(/rt-|@lab\.test|eyJ/);
  });

  it("works signed out (the sign-in page's 'continue as'), parking nothing", async () => {
    h.active = null;
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    expect((await SWITCH(post("/api/account/accounts/switch", { slot: 1 }))).status).toBe(200);
    expect(slotOf(1)).toBeNull();
  });
});

describe("POST add", () => {
  it("parks the active account without ending its session, clears the active cookie, and sends the browser to sign in", async () => {
    const res = await ADD(post("/api/account/accounts/add", {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ to: "/login?add=1" });
    expect(slotOf(1)).toMatchObject({ uid: A, rt: "rt-active" });
    expect(h.jar.has("sb-lab-auth-token")).toBe(false);
    expect(h.signOuts).toBe(0);
  });

  it("refuses a fourth account on one device", async () => {
    park(1, B, "b@lab.test", "rt-b");
    park(2, C, "c@lab.test", "rt-c");
    const res = await ADD(post("/api/account/accounts/add", {}));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("account_limit");
    expect(h.jar.has("sb-lab-auth-token")).toBe(true);
    const list = (await (await LIST()).json()) as { canAdd: boolean };
    expect(list.canAdd).toBe(false);
  });

  it("'Sign in again' frees only a refused row's place", async () => {
    park(1, B, "b@lab.test", "rt-b", { stale: true });
    park(2, C, "c@lab.test", "rt-c");
    expect((await ADD(post("/api/account/accounts/add", { replace: 2 }))).status).toBe(409);
    expect((await ADD(post("/api/account/accounts/add", { replace: 1 }))).status).toBe(200);
    expect(slotOf(1)).toMatchObject({ uid: A });
    expect(slotOf(2)).toMatchObject({ uid: C });
  });

  it("needs a signed-in account and our own page", async () => {
    expect((await ADD(post("/api/account/accounts/add", {}, "https://evil.example"))).status).toBe(403);
    h.active = null;
    expect((await ADD(post("/api/account/accounts/add", {}))).status).toBe(401);
  });
});

describe("POST logout", () => {
  it("signs one parked account out and keeps the active one and the other", async () => {
    park(1, B, "b@lab.test", "rt-b");
    park(2, C, "c@lab.test", "rt-c");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    expect((await LOGOUT(post("/api/account/accounts/logout", { slot: 1 }))).status).toBe(200);
    expect(h.signOuts).toBe(1);
    expect(slotOf(1)).toBeNull();
    expect(slotOf(2)).toMatchObject({ uid: C });
    expect(h.jar.has("sb-lab-auth-token")).toBe(true);
  });

  it("'all' clears every parked account (the browser then signs the active one out itself)", async () => {
    park(1, B, "b@lab.test", "rt-b");
    park(2, C, "c@lab.test", "rt-c", { stale: true });
    expect((await LOGOUT(post("/api/account/accounts/logout", { all: true }))).status).toBe(200);
    expect(slotOf(1)).toBeNull();
    expect(slotOf(2)).toBeNull();
  });

  it("refuses another site and a slot that is not one", async () => {
    park(1, B, "b@lab.test", "rt-b");
    expect((await LOGOUT(post("/api/account/accounts/logout", { slot: 1 }, "https://evil.example"))).status).toBe(403);
    expect((await LOGOUT(post("/api/account/accounts/logout", { slot: 9 }))).status).toBe(400);
    expect(slotOf(1)).toMatchObject({ uid: B });
  });
});

describe("the gate", () => {
  it("lets exactly these routes through signed out, where each decides for itself", () => {
    for (const p of ["/api/account/accounts", "/api/account/accounts/switch", "/api/account/accounts/add/"]) {
      expect(paths.isDeviceAccountsPath(p), p).toBe(true);
      expect(paths.gateDecision(p, false), p).toBe("pass");
    }
    for (const p of ["/api/account/accountsx", "/api/account", "/api/account/owner-mode"]) expect(paths.isDeviceAccountsPath(p), p).toBe(false);
  });
});
