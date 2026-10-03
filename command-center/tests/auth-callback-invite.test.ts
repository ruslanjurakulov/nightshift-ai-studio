import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The confirmation callback is the one moment a friend's invite may count:
// the address is confirmed and the person is signed in. These pin that the
// callback hands the cookie to the database after a real session exists, never
// before, and never lets a failure there stop the sign-in.
const h = vi.hoisted(() => ({
  exchange: vi.fn(async (_code: string) => ({ error: null as { code?: string } | null })),
  refresh: vi.fn(async (_args: unknown) => ({ error: null as { code?: string } | null })),
  rpc: vi.fn(async (_fn: string, _args?: unknown) => ({ data: true as unknown, error: null as unknown })),
  jar: new Map<string, string>(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { exchangeCodeForSession: h.exchange, refreshSession: h.refresh, verifyOtp: vi.fn() },
    rpc: h.rpc,
  }),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { verifyOtp: vi.fn() } }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string, opts?: { maxAge?: number }) => {
      if (opts?.maxAge === 0) h.jar.delete(name);
      else h.jar.set(name, value);
    },
  }),
}));

const { GET, POST } = await import("@/app/auth/callback/route");
const { INVITE_COOKIE } = await import("@/lib/friend-invites");
const { PENDING_COOKIE, encodePending, newCsrfToken } = await import("@/lib/auth-confirm");

const TOKEN = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
  h.exchange.mockReset().mockResolvedValue({ error: null });
  h.refresh.mockReset().mockResolvedValue({ error: null });
  h.rpc.mockReset().mockResolvedValue({ data: true, error: null });
  h.jar.clear();
});

const joined = () => h.rpc.mock.calls.filter((c) => c[0] === "join_friend_invite");

describe("the confirmation callback and a friend's invite", () => {
  it("counts the invite once the code is exchanged for a session, and clears the cookie", async () => {
    h.jar.set(INVITE_COOKIE, TOKEN);
    const res = await GET(new Request("https://nightshift.test/auth/callback?code=abc&next=/welcome"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/welcome");
    expect(joined()).toEqual([["join_friend_invite", { p_token: TOKEN }]]);
    expect(h.jar.has(INVITE_COOKIE)).toBe(false);
  });

  it("does not count it when the code is refused (no session, no confirmed e-mail)", async () => {
    h.jar.set(INVITE_COOKIE, TOKEN);
    h.exchange.mockResolvedValue({ error: { code: "otp_expired" } });
    const res = await GET(new Request("https://nightshift.test/auth/callback?code=abc&next=/welcome"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.jar.get(INVITE_COOKIE)).toBe(TOKEN);
  });

  it("does not count it from an error redirect either", async () => {
    h.jar.set(INVITE_COOKIE, TOKEN);
    await GET(new Request("https://nightshift.test/auth/callback?error=access_denied&error_code=otp_expired"));
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a database failure never stops the sign-in", async () => {
    h.jar.set(INVITE_COOKIE, TOKEN);
    h.rpc.mockRejectedValue(new Error("down"));
    const res = await GET(new Request("https://nightshift.test/auth/callback?code=abc&next=/welcome"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/welcome");
  });

  it("without the cookie nothing extra happens", async () => {
    await GET(new Request("https://nightshift.test/auth/callback?code=abc&next=/welcome"));
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("the unbound-link path counts it only after the person presses Continue", async () => {
    h.jar.set(INVITE_COOKIE, TOKEN);
    const csrf = newCsrfToken();
    h.jar.set(PENDING_COOKIE, encodePending({ rt: "rt", email: "a@b.test", csrf, iat: Math.floor(Date.now() / 1000) }));
    const post = (action: string) =>
      POST(
        new Request("https://nightshift.test/auth/callback", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://nightshift.test" },
          body: new URLSearchParams({ csrf, action, next: "/welcome" }),
        }),
      );
    await post("cancel");
    expect(h.rpc).not.toHaveBeenCalled();
    h.jar.set(PENDING_COOKIE, encodePending({ rt: "rt", email: "a@b.test", csrf, iat: Math.floor(Date.now() / 1000) }));
    await post("continue");
    expect(joined()).toHaveLength(1);
  });
});
