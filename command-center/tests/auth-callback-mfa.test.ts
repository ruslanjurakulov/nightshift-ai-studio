import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /auth/callback with the second factor: a code exchange (Google, a
 * confirmation link) or the "continue as <email>?" step makes a password-class
 * session, and an account with a verified authenticator is not signed in until
 * it enters the code. What would break without this: Google sign-in skipping
 * the authenticator that the password path asks for.
 */

type User = { id: string; email: string; factors?: Array<{ status: string; factor_type: string }> };
const auth = vi.hoisted(() => ({
  user: { id: "u1", email: "me@a.test" } as User,
  jar: new Map<string, string>(),
  exchange: vi.fn(),
  refresh: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { exchangeCodeForSession: auth.exchange, refreshSession: auth.refresh, verifyOtp: vi.fn() },
  }),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { verifyOtp: auth.verify } }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (auth.jar.has(name) ? { name, value: auth.jar.get(name)! } : undefined),
    set: (name: string, value: string, opts?: { maxAge?: number }) => {
      if (opts?.maxAge === 0) auth.jar.delete(name);
      else auth.jar.set(name, value);
    },
    getAll: () => [],
  }),
}));
vi.mock("@/lib/server/friend-invites", () => ({ joinFromCookie: async () => undefined }));
vi.mock("@/lib/handles", async () => ({
  ...(await vi.importActual<object>("@/lib/handles")),
  applyPendingHandle: async () => undefined,
}));

const { GET, POST } = await import("@/app/auth/callback/route");
const { PENDING_COOKIE, decodePending } = await import("@/lib/auth-confirm");

const VERIFIED = [{ status: "verified", factor_type: "totp" }];
const where = (res: Response) => {
  const u = new URL(res.headers.get("location")!);
  return u.pathname + u.search;
};

beforeEach(() => {
  auth.jar.clear();
  auth.user = { id: "u1", email: "me@a.test" };
  auth.exchange.mockReset().mockImplementation(async () => ({ data: { user: auth.user, session: { user: auth.user } }, error: null }));
  auth.refresh.mockReset().mockImplementation(async () => ({ data: { user: auth.user, session: { user: auth.user } }, error: null }));
  auth.verify.mockReset().mockImplementation(async () => ({
    data: { session: { refresh_token: "rt", user: auth.user }, user: auth.user },
    error: null,
  }));
});

describe("code exchange", () => {
  it("an account with a verified authenticator goes to the code page, carrying where it was going", async () => {
    auth.user = { id: "u1", email: "me@a.test", factors: VERIFIED };
    const res = await GET(new Request("https://nightshift.test/auth/callback?code=abc&next=%2Fchronos%2Fbilling"));
    expect(where(res)).toBe("/login/verify?next=%2Fchronos%2Fbilling");
  });

  it("an account without one goes straight on, exactly as before", async () => {
    expect(where(await GET(new Request("https://nightshift.test/auth/callback?code=abc&next=%2Fwelcome")))).toBe("/welcome");
    auth.user = { id: "u1", email: "me@a.test", factors: [{ status: "unverified", factor_type: "totp" }] };
    expect(where(await GET(new Request("https://nightshift.test/auth/callback?code=abc&next=%2Fwelcome")))).toBe("/welcome");
  });

  it("an off-site next is still never followed, with or without a factor", async () => {
    auth.user = { id: "u1", email: "me@a.test", factors: VERIFIED };
    const res = await GET(new Request(`https://nightshift.test/auth/callback?code=abc&next=${encodeURIComponent("//evil.example")}`));
    expect(where(res)).toBe("/login/verify?next=%2Fwelcome");
  });
});

describe("the 'continue as <email>?' step", () => {
  async function continuePost() {
    await GET(new Request("https://nightshift.test/auth/callback?token_hash=h&type=email&next=%2Fwelcome"));
    const pending = decodePending(auth.jar.get(PENDING_COOKIE))!;
    return POST(
      new Request("https://nightshift.test/auth/callback", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://nightshift.test" },
        body: new URLSearchParams({ csrf: pending.csrf, action: "continue", next: "/welcome" }),
      }),
    );
  }

  it("with an authenticator: the code page first", async () => {
    auth.user = { id: "u1", email: "me@a.test", factors: VERIFIED };
    expect(where(await continuePost())).toBe("/login/verify?next=%2Fwelcome");
  });

  it("without: straight on", async () => {
    expect(where(await continuePost())).toBe("/welcome");
  });
});
