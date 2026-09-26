import { beforeEach, describe, expect, it, vi } from "vitest";

// The route's only collaborator is the anon-key SSR client; each test sets
// what the code exchange answers.
const auth = vi.hoisted(() => ({
  exchange: vi.fn(async (_code: string) => ({ error: null as { code?: string } | null })),
  verify: vi.fn(async (_args: unknown) => ({ error: null as { code?: string } | null })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { exchangeCodeForSession: auth.exchange, verifyOtp: auth.verify },
  }),
}));

const { GET } = await import("@/app/auth/callback/route");

async function land(query: string) {
  const res = await GET(new Request(`https://nightshift.test/auth/callback${query}`));
  const location = new URL(res.headers.get("location")!);
  return { origin: location.origin, path: location.pathname + location.search };
}

beforeEach(() => {
  auth.exchange.mockClear();
  auth.verify.mockClear();
  auth.exchange.mockResolvedValue({ error: null });
  auth.verify.mockResolvedValue({ error: null });
  delete process.env.APP_ORIGIN;
});

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
    expect((await land("?token_hash=h&type=signup")).path).toBe("/welcome");
    expect(auth.verify).toHaveBeenCalledWith({ token_hash: "h", type: "signup" });
    expect((await land("?token_hash=h&type=recovery")).path).toBe("/login?error=link_invalid");
  });

  it("treats a bare visit as an invalid link", async () => {
    expect((await land("")).path).toBe("/login?error=link_invalid");
  });
});
