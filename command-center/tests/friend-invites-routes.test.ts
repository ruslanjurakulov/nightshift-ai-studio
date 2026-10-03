import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  peek: true as unknown,
  peekError: null as unknown,
  rpc: vi.fn(),
  jar: new Map<string, string>(),
}));

vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: h.rpc }),
  getUser: async () => h.user,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string, opts?: { maxAge?: number }) => {
      if (opts?.maxAge === 0) h.jar.delete(name);
      else h.jar.set(name, value);
    },
  }),
}));

const { GET } = await import("@/app/i/[token]/route");
const { POST: joinRoute } = await import("@/app/api/invite/join/route");
const { joinFromCookie, takeVisit, INVITE_VISIT_LIMIT } = await import("@/lib/server/friend-invites");
const { INVITE_COOKIE } = await import("@/lib/friend-invites");

const TOKEN = "0123456789abcdef0123456789abcdef";

function visit(token: string, headers: Record<string, string> = {}) {
  return GET(new Request(`https://nightshift.test/i/${token}`, { headers }), { params: Promise.resolve({ token }) });
}

beforeEach(() => {
  h.user = null;
  h.peek = true;
  h.peekError = null;
  h.jar.clear();
  h.rpc.mockReset();
  h.rpc.mockImplementation(async (fn: string) => {
    if (fn === "friend_invite_peek") return { data: h.peek, error: h.peekError };
    if (fn === "take_web_rate") return { data: true, error: null };
    return { data: { status: "counted" }, error: null };
  });
});

describe("GET /i/<token>", () => {
  it("a live link, signed out: cookie set, sent to /signup with no token anywhere in the address", async () => {
    const res = await visit(TOKEN, { "x-forwarded-for": "203.0.113.1" });
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname + location.search).toBe("/signup");
    expect(res.headers.get("location")).not.toContain(TOKEN);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${INVITE_COOKIE}=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=86400/i);
    expect(h.rpc).toHaveBeenCalledWith("friend_invite_peek", { p_token: TOKEN });
  });

  it("accepts an upper-case token and stores it normalised", async () => {
    const res = await visit(TOKEN.toUpperCase(), { "x-forwarded-for": "203.0.113.2" });
    expect(res.headers.get("set-cookie")).toContain(`${INVITE_COOKIE}=${TOKEN}`);
  });

  it.each(["short", "x".repeat(32), `${TOKEN}0`, "A".repeat(40)])(
    "%s is the one neutral page, with no database call and no cookie",
    async (token) => {
      const res = await visit(token, { "x-forwarded-for": "203.0.113.3" });
      expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe("/invite?s=invalid");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(h.rpc).not.toHaveBeenCalled();
    },
  );

  it("a link the database calls dead (unknown, switched off, errored) is the same one neutral page", async () => {
    const seen = new Set<string>();
    for (const [peek, error] of [[false, null], [null, null], [true, { code: "XX000" }]] as const) {
      h.peek = peek;
      h.peekError = error;
      const res = await visit(TOKEN, { "x-forwarded-for": "203.0.113.4" });
      seen.add(`${res.status} ${res.headers.get("location")} ${res.headers.get("set-cookie")}`);
    }
    expect([...seen]).toEqual(["307 https://nightshift.test/invite?s=invalid null"]);
  });

  it("signed in: told plainly that an invite is for new accounts; nothing stored, nothing asked", async () => {
    h.user = { id: "u1" };
    const res = await visit(TOKEN, { "x-forwarded-for": "203.0.113.5" });
    expect(res.headers.get("location")).toBe("https://nightshift.test/invite?s=existing");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("answers a visitor who asks too fast with the neutral page, never an error that says so", async () => {
    const ip = { "x-forwarded-for": "198.51.100.77" };
    let last = "";
    for (let i = 0; i < INVITE_VISIT_LIMIT.max + 3; i++) last = (await visit(TOKEN, ip)).headers.get("location") ?? "";
    expect(last).toBe("https://nightshift.test/invite?s=invalid");
  });

  it("the visit counter is per window and per address", () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < INVITE_VISIT_LIMIT.max; i++) expect(takeVisit("a", t0)).toBe(true);
    expect(takeVisit("a", t0)).toBe(false);
    expect(takeVisit("b", t0)).toBe(true);
    expect(takeVisit("a", t0 + INVITE_VISIT_LIMIT.windowMs)).toBe(true);
  });
});

describe("joining after the e-mail is confirmed", () => {
  it("does nothing without the cookie", async () => {
    await joinFromCookie({ rpc: h.rpc });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("asks the database once with the cookie's token, then clears the cookie", async () => {
    h.jar.set(INVITE_COOKIE, TOKEN);
    await joinFromCookie({ rpc: h.rpc });
    expect(h.rpc).toHaveBeenCalledWith("take_web_rate", expect.objectContaining({ p_bucket: "invite.join" }));
    expect(h.rpc).toHaveBeenCalledWith("join_friend_invite", { p_token: TOKEN });
    expect(h.jar.has(INVITE_COOKIE)).toBe(false);
  });

  it("never lets a failure touch the sign-in, and still clears the cookie", async () => {
    h.jar.set(INVITE_COOKIE, TOKEN);
    h.rpc.mockRejectedValue(new Error("down"));
    await expect(joinFromCookie({ rpc: h.rpc })).resolves.toBeUndefined();
    expect(h.jar.has(INVITE_COOKIE)).toBe(false);
  });

  it("a tampered cookie is dropped without a call", async () => {
    h.jar.set(INVITE_COOKIE, "not-a-token");
    await joinFromCookie({ rpc: h.rpc });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.jar.has(INVITE_COOKIE)).toBe(false);
  });

  it("an exhausted allowance skips the join", async () => {
    h.jar.set(INVITE_COOKIE, TOKEN);
    h.rpc.mockImplementation(async (fn: string) => ({ data: fn === "take_web_rate" ? false : { status: "counted" }, error: null }));
    await joinFromCookie({ rpc: h.rpc });
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(["take_web_rate"]);
  });

  const post = (headers: Record<string, string> = { origin: "https://nightshift.test", "sec-fetch-site": "same-origin" }) =>
    joinRoute(new Request("https://nightshift.test/api/invite/join", { method: "POST", headers }));

  it("POST /api/invite/join: signed out is 401; signed in answers the same whatever happened", async () => {
    const out = await post();
    expect(out.status).toBe(401);
    h.user = { id: "u1" };
    h.jar.set(INVITE_COOKIE, TOKEN);
    const ok = await post();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith("join_friend_invite", { p_token: TOKEN });
    h.rpc.mockRejectedValue(new Error("down"));
    h.jar.set(INVITE_COOKIE, TOKEN);
    expect(await (await post()).json()).toEqual({ ok: true });
  });

  it("POST /api/invite/join: a request from another site, or with no origin, joins nothing and keeps the cookie", async () => {
    h.user = { id: "u1" };
    for (const headers of [
      { origin: "https://evil.test", "sec-fetch-site": "cross-site" },
      { origin: "https://evil.test" },
      { origin: "null" },
      { "sec-fetch-site": "same-site", origin: "https://nightshift.test" },
      {},
    ] as Record<string, string>[]) {
      h.jar.set(INVITE_COOKIE, TOKEN);
      const res = await post(headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(h.jar.has(INVITE_COOKIE)).toBe(true);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
