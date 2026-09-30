import { beforeEach, describe, expect, it, vi } from "vitest";

// The route's collaborators: the anon-key SSR client (the browser's session),
// a stateless anon client that verifies a token_hash link without touching
// that session, and the cookie jar. Each test sets what they answer.
type Session = { refresh_token: string; user: { email: string } } | null;
const auth = vi.hoisted(() => ({
  exchange: vi.fn(async (_code: string) => ({ error: null as { code?: string } | null })),
  verify: vi.fn(async (_args: unknown) => ({
    data: { session: null as Session, user: null as { email: string } | null },
    error: null as { code?: string } | null,
  })),
  sessionVerify: vi.fn(async (_args: unknown) => ({ error: null })),
  refresh: vi.fn(async (_args: unknown) => ({ error: null as { code?: string } | null })),
  jar: new Map<string, string>(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { exchangeCodeForSession: auth.exchange, verifyOtp: auth.sessionVerify, refreshSession: auth.refresh },
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { verifyOtp: auth.verify } }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (auth.jar.has(name) ? { name, value: auth.jar.get(name)! } : undefined),
    set: (name: string, value: string, opts?: { maxAge?: number }) => {
      if (opts?.maxAge === 0) auth.jar.delete(name);
      else auth.jar.set(name, value);
    },
  }),
}));

const { GET, POST } = await import("@/app/auth/callback/route");
const { PENDING_COOKIE, decodePending } = await import("@/lib/auth-confirm");

async function land(query: string) {
  const res = await GET(new Request(`https://nightshift.test/auth/callback${query}`));
  const location = new URL(res.headers.get("location")!);
  return { origin: location.origin, path: location.pathname + location.search };
}

const VICTIM_SESSION = { refresh_token: "rt-owner", user: { email: "owner@a.test" } };

beforeEach(() => {
  auth.exchange.mockClear();
  auth.verify.mockClear();
  auth.sessionVerify.mockClear();
  auth.refresh.mockClear();
  auth.jar.clear();
  auth.exchange.mockResolvedValue({ error: null });
  auth.verify.mockResolvedValue({ data: { session: VICTIM_SESSION, user: VICTIM_SESSION.user }, error: null });
  auth.refresh.mockResolvedValue({ error: null });
  delete process.env.APP_ORIGIN;
});

function confirmPost(fields: Record<string, string>, headers: Record<string, string> = { origin: "https://nightshift.test" }) {
  const body = new URLSearchParams(fields);
  return POST(
    new Request("https://nightshift.test/auth/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body,
    }),
  );
}

async function pendingFromLink() {
  await land("?token_hash=h&type=email&next=/welcome");
  const pending = decodePending(auth.jar.get(PENDING_COOKIE));
  expect(pending).not.toBeNull();
  return pending!;
}

describe("/auth/callback", () => {
  it("exchanges the code and continues to /welcome", async () => {
    expect(await land("?code=abc&next=/welcome")).toEqual({ origin: "https://nightshift.test", path: "/welcome" });
    expect(auth.exchange).toHaveBeenCalledWith("abc");
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil.com"])("never forwards off-site (next=%s)", async (next) => {
    const out = await land(`?code=abc&next=${encodeURIComponent(next)}`);
    expect(out).toEqual({ origin: "https://nightshift.test", path: "/welcome" });
  });

  it("redirects on the configured public origin, not the bind address", async () => {
    process.env.APP_ORIGIN = "https://nightshift-ai.studio";
    expect((await land("?code=abc")).origin).toBe("https://nightshift-ai.studio");
  });

  it("sends an expired link to /login with a fixed code", async () => {
    const out = await land("?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid");
    expect(out.path).toBe("/login?error=link_expired");
    expect(auth.exchange).not.toHaveBeenCalled();
  });

  // Usually the link was opened in another browser; the address is confirmed
  // and signing in works, which is what the login page then says.
  it("sends a failed exchange to /login without Supabase's text", async () => {
    auth.exchange.mockResolvedValue({ error: { code: "bad_code_verifier" } });
    expect((await land("?code=abc")).path).toBe("/login?error=link_invalid");
  });

  it("verifies a token_hash link only for sign-up confirmation types", async () => {
    expect((await land("?token_hash=h&type=signup")).path).toBe("/auth/confirm?next=%2Fwelcome");
    expect(auth.verify).toHaveBeenCalledWith({ token_hash: "h", type: "signup" });
    expect((await land("?token_hash=h&type=recovery")).path).toBe("/login?error=link_invalid");
  });

  // P2: a token_hash link is not bound to the browser that asked for it, so
  // opening one must not sign that browser in by itself (login CSRF).
  it("never signs a browser in straight from a token_hash link", async () => {
    const out = await land("?token_hash=h&type=email&next=/welcome");
    expect(out.path).toBe("/auth/confirm?next=%2Fwelcome");
    expect(auth.sessionVerify).not.toHaveBeenCalled();
    expect(auth.refresh).not.toHaveBeenCalled();
    const pending = decodePending(auth.jar.get(PENDING_COOKIE));
    expect(pending).toMatchObject({ email: "owner@a.test", rt: "rt-owner" });
    expect(pending!.csrf).toMatch(/^[0-9a-f]{48}$/);
  });

  it("finishes the sign-in only on a same-origin Continue carrying the pending token", async () => {
    const pending = await pendingFromLink();
    const res = await confirmPost({ action: "continue", csrf: pending.csrf, next: "/welcome" });
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/welcome");
    expect(auth.refresh).toHaveBeenCalledWith({ refresh_token: "rt-owner" });
    expect(auth.jar.has(PENDING_COOKIE)).toBe(false);
  });

  it.each([
    ["another site's form", { origin: "https://evil.test" }],
    ["a cross-site fetch", { origin: "https://nightshift.test", "sec-fetch-site": "cross-site" }],
    ["no Origin at all", {} as Record<string, string>],
  ])("refuses %s and keeps nothing signed in", async (_name, headers) => {
    const pending = await pendingFromLink();
    const res = await confirmPost({ action: "continue", csrf: pending.csrf, next: "/welcome" }, headers);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it("refuses a Continue without the pending token, or with no pending sign-in", async () => {
    await pendingFromLink();
    const wrong = await confirmPost({ action: "continue", csrf: "0".repeat(48), next: "/welcome" });
    expect(new URL(wrong.headers.get("location")!).search).toBe("?error=link_invalid");
    expect(auth.jar.has(PENDING_COOKIE)).toBe(false);
    const none = await confirmPost({ action: "continue", csrf: "0".repeat(48), next: "/welcome" });
    expect(new URL(none.headers.get("location")!).search).toBe("?error=link_invalid");
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it("cancels: drops the pending sign-in, signs nobody in", async () => {
    const pending = await pendingFromLink();
    const res = await confirmPost({ action: "cancel", csrf: pending.csrf, next: "/welcome" });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(auth.jar.has(PENDING_COOKIE)).toBe(false);
  });

  it("never forwards off-site after Continue", async () => {
    const pending = await pendingFromLink();
    const res = await confirmPost({ action: "continue", csrf: pending.csrf, next: "//evil.com" });
    expect(new URL(res.headers.get("location")!).origin).toBe("https://nightshift.test");
  });

  it("a pending sign-in expires", async () => {
    const pending = await pendingFromLink();
    const later = pending.iat + 11 * 60;
    expect(decodePending(auth.jar.get(PENDING_COOKIE), later)).toBeNull();
  });

  it("sends a spent token_hash link to /login", async () => {
    auth.verify.mockResolvedValue({ data: { session: null, user: null }, error: { code: "otp_expired" } });
    expect((await land("?token_hash=h&type=email")).path).toBe("/login?error=link_expired");
    expect(auth.jar.has(PENDING_COOKIE)).toBe(false);
  });

  it("treats a bare visit as an invalid link", async () => {
    expect((await land("")).path).toBe("/login?error=link_invalid");
  });
});

describe("/auth/confirm", () => {
  it("is reachable signed out and signed in, like the callback", async () => {
    const { gateDecision } = await import("@/lib/public-paths");
    expect(gateDecision("/auth/confirm", false)).toBe("pass");
    expect(gateDecision("/auth/confirm", true)).toBe("pass");
    expect(gateDecision("/auth/confirmx", false)).toBe("to-login");
  });

  it("treats a tampered or foreign pending cookie as no pending sign-in", async () => {
    const { encodePending, isSameOriginPost } = await import("@/lib/auth-confirm");
    const now = Math.floor(Date.now() / 1000);
    expect(decodePending("not-base64-json")).toBeNull();
    expect(decodePending(encodePending({ rt: "r", email: "a@b.c", csrf: "short", iat: now }))).toBeNull();
    expect(decodePending(encodePending({ rt: "", email: "a@b.c", csrf: "a".repeat(48), iat: now }))).toBeNull();
    expect(decodePending(encodePending({ rt: "r", email: "a@b.c", csrf: "a".repeat(48), iat: now + 3600 }))).toBeNull();
    const ok = ["https://nightshift.test"];
    expect(isSameOriginPost(new Headers({ origin: "https://nightshift.test", "sec-fetch-site": "same-origin" }), ok)).toBe(true);
    expect(isSameOriginPost(new Headers({ origin: "null" }), ok)).toBe(false);
    expect(isSameOriginPost(new Headers({ origin: "https://nightshift.test", "sec-fetch-site": "same-site" }), ok)).toBe(false);
  });
});
