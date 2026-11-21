import { beforeEach, describe, expect, it, vi } from "vitest";

// Password recovery through /auth/callback: the PKCE code (same browser) and
// the token_hash link (any browser, through the "continue as <email>?" step).
// What matters: a recovery link only ever ends at /reset-password, a token_hash
// link never becomes a session without the confirm step, a failed link goes to
// /forgot-password with a fixed code, and nothing of Supabase's text leaks.
const UID = "6f1c7a4e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const h = vi.hoisted(() => ({
  exchange: vi.fn(),
  verify: vi.fn(),
  refresh: vi.fn(),
  rpc: vi.fn(async (_fn: string, _args?: unknown) => ({ data: null as unknown, error: null as unknown })),
  jar: new Map<string, string>(),
  cookieOpts: new Map<string, Record<string, unknown>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { exchangeCodeForSession: h.exchange, refreshSession: h.refresh, getUser: async () => ({ data: { user: null } }) },
    rpc: h.rpc,
  }),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { verifyOtp: h.verify } }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string, opts?: Record<string, unknown>) => {
      h.cookieOpts.set(name, opts ?? {});
      if (opts?.maxAge === 0) h.jar.delete(name);
      else h.jar.set(name, value);
    },
  }),
}));

const { GET, POST } = await import("@/app/auth/callback/route");
const { PENDING_COOKIE, decodePending } = await import("@/lib/auth-confirm");
const { RECOVERY_COOKIE, decodeRecovery } = await import("@/lib/recovery");

const where = async (query: string) => {
  const res = await GET(new Request(`https://nightshift.test/auth/callback${query}`));
  const loc = new URL(res.headers.get("location")!);
  return { path: loc.pathname + loc.search, res };
};
const recoverySession = { refresh_token: "rt-ana", user: { id: UID, email: "ana@a.test" } };
const post = (fields: Record<string, string>, headers: Record<string, string> = { origin: "https://nightshift.test" }) =>
  POST(
    new Request("https://nightshift.test/auth/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields),
    }),
  );

beforeEach(() => {
  h.exchange.mockReset().mockResolvedValue({ data: { user: { id: UID }, session: null, redirectType: "PASSWORD_RECOVERY" }, error: null });
  h.verify.mockReset().mockResolvedValue({ data: { session: recoverySession, user: recoverySession.user }, error: null });
  h.refresh.mockReset().mockResolvedValue({ data: { user: { id: UID }, session: recoverySession }, error: null });
  h.rpc.mockClear();
  h.jar.clear();
  h.cookieOpts.clear();
});

describe("PKCE recovery code (the browser that asked)", () => {
  it("becomes a recovery session at once and goes to /reset-password, marked for that account", async () => {
    const { path } = await where("?code=abc&next=/reset-password");
    expect(path).toBe("/reset-password");
    expect(h.exchange).toHaveBeenCalledWith("abc");
    const marker = decodeRecovery(h.jar.get(RECOVERY_COOKIE));
    expect(marker?.uid).toBe(UID);
    expect(h.cookieOpts.get(RECOVERY_COOKIE)).toMatchObject({ path: "/reset-password", httpOnly: true, sameSite: "lax" });
  });

  it("goes to /reset-password whatever `next` said, and never forwards off-site", async () => {
    for (const next of ["/welcome", "//evil.com", "https://evil.com/x", "/command-center"]) {
      h.jar.clear();
      const { path } = await where(`?code=abc&next=${encodeURIComponent(next)}`);
      expect(path).toBe("/reset-password");
      expect(decodeRecovery(h.jar.get(RECOVERY_COOKIE))?.uid).toBe(UID);
    }
  });

  it("does not run the invite or the sign-up username steps for a recovery", async () => {
    await where("?code=abc&next=/reset-password");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a failed exchange asks for a new link, with a fixed code and no provider text", async () => {
    h.exchange.mockResolvedValue({ data: { user: null, session: null }, error: { code: "bad_code_verifier", message: "PKCE code verifier not found in storage" } });
    const { path } = await where("?code=abc&next=/reset-password");
    expect(path).toBe("/forgot-password?s=expired");
    expect(path).not.toMatch(/verifier|PKCE/i);
    expect(h.jar.has(RECOVERY_COOKIE)).toBe(false);
  });

  it("an ordinary sign-up code (not a recovery) is unchanged and leaves no marker", async () => {
    h.exchange.mockResolvedValue({ data: { user: { id: UID }, session: null, redirectType: null }, error: null });
    expect((await where("?code=abc&next=/welcome")).path).toBe("/welcome");
    expect(h.jar.has(RECOVERY_COOKIE)).toBe(false);
  });

  it("Supabase's own error on the redirect (expired link) goes to /forgot-password", async () => {
    const { path } = await where("?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid&next=/reset-password");
    expect(path).toBe("/forgot-password?s=expired");
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it("an error on a non-recovery link still goes to /login", async () => {
    expect((await where("?error=access_denied&error_code=otp_expired&next=/welcome")).path).toBe("/login?error=link_expired");
  });
});

describe("token_hash recovery link (any browser)", () => {
  it("is verified into a PENDING sign-in, never a session, and sent to the confirm step", async () => {
    const { path } = await where("?token_hash=h&type=recovery&next=/reset-password");
    expect(path).toBe("/auth/confirm?next=%2Freset-password");
    expect(h.verify).toHaveBeenCalledWith({ token_hash: "h", type: "recovery" });
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.jar.has(RECOVERY_COOKIE)).toBe(false);
    const pending = decodePending(h.jar.get(PENDING_COOKIE));
    expect(pending).toMatchObject({ email: "ana@a.test", rec: true });
  });

  it("only a same-origin Continue carrying the pending token finishes it, then marks it and goes to /reset-password", async () => {
    await where("?token_hash=h&type=recovery");
    const pending = decodePending(h.jar.get(PENDING_COOKIE))!;
    const res = await post({ action: "continue", csrf: pending.csrf, next: "/welcome" });
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/reset-password");
    expect(h.refresh).toHaveBeenCalledWith({ refresh_token: "rt-ana" });
    expect(decodeRecovery(h.jar.get(RECOVERY_COOKIE))?.uid).toBe(UID);
    expect(h.jar.has(PENDING_COOKIE)).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["another site's form", { origin: "https://evil.test" }],
    ["a cross-site fetch", { origin: "https://nightshift.test", "sec-fetch-site": "cross-site" }],
    ["no Origin", {} as Record<string, string>],
  ])("refuses %s: no session, no marker", async (_n, headers) => {
    await where("?token_hash=h&type=recovery");
    const pending = decodePending(h.jar.get(PENDING_COOKIE))!;
    const res = await post({ action: "continue", csrf: pending.csrf, next: "/reset-password" }, headers);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.jar.has(RECOVERY_COOKIE)).toBe(false);
  });

  it("a wrong pending token is refused", async () => {
    await where("?token_hash=h&type=recovery");
    const res = await post({ action: "continue", csrf: "0".repeat(48), next: "/reset-password" });
    expect(new URL(res.headers.get("location")!).search).toBe("?error=link_invalid");
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.jar.has(RECOVERY_COOKIE)).toBe(false);
  });

  it("Not me — cancel signs nobody in", async () => {
    await where("?token_hash=h&type=recovery");
    const pending = decodePending(h.jar.get(PENDING_COOKIE))!;
    const res = await post({ action: "cancel", csrf: pending.csrf, next: "/reset-password" });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("a spent or invalid recovery link asks for a new one, with a fixed code", async () => {
    h.verify.mockResolvedValue({ data: { session: null, user: null }, error: { code: "otp_expired", message: "Token has expired or is invalid" } });
    const { path } = await where("?token_hash=h&type=recovery");
    expect(path).toBe("/forgot-password?s=expired");
    expect(h.jar.has(PENDING_COOKIE)).toBe(false);
  });

  it("a session that cannot be refreshed at Continue asks for a new link", async () => {
    await where("?token_hash=h&type=recovery");
    const pending = decodePending(h.jar.get(PENDING_COOKIE))!;
    h.refresh.mockResolvedValue({ data: { user: null, session: null }, error: { code: "refresh_token_not_found" } });
    const res = await post({ action: "continue", csrf: pending.csrf, next: "/reset-password" });
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe("/forgot-password?s=expired");
    expect(h.jar.has(RECOVERY_COOKIE)).toBe(false);
  });

  it("an ordinary sign-up confirmation is not a recovery: no marker, to its own next", async () => {
    h.verify.mockResolvedValue({ data: { session: recoverySession, user: recoverySession.user }, error: null });
    await where("?token_hash=h&type=signup&next=/welcome");
    const pending = decodePending(h.jar.get(PENDING_COOKIE))!;
    expect(pending.rec).toBeUndefined();
    const res = await post({ action: "continue", csrf: pending.csrf, next: "/welcome" });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/welcome");
    expect(h.jar.has(RECOVERY_COOKIE)).toBe(false);
  });
});
