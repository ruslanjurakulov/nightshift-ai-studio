import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Every auth cookie the middleware sets when it refreshes the session (BR-S-021). The fake client plays what
 * @supabase/ssr does on a refresh: it calls `setAll` with its own defaults (path /, Lax, not HttpOnly, 400 days).
 * In a production build each must leave with Secure, Lax and at most 30 days; a deletion stays a deletion; and the
 * refresh path still delivers the cookie to the browser.
 */

const LIB_DEFAULT = { path: "/", sameSite: "lax", httpOnly: false, maxAge: 400 * 24 * 60 * 60 } as const;

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_u: string, _k: string, opts: { cookies: { setAll: (c: unknown[]) => void } }) => ({
    auth: {
      getUser: async () => {
        opts.cookies.setAll([
          { name: "sb-p-auth-token.0", value: "chunk0", options: { ...LIB_DEFAULT } },
          { name: "sb-p-auth-token.1", value: "chunk1", options: { ...LIB_DEFAULT } },
          { name: "sb-p-old-token", value: "", options: { ...LIB_DEFAULT, maxAge: 0 } },
        ]);
        return { data: { user: { id: "c1", factors: [] } } };
      },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" } }) },
    },
    rpc: async () => ({ data: false, error: null }),
  }),
}));
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://project.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));

const { middleware } = await import("@/middleware");

afterEach(() => vi.unstubAllEnvs());

function setCookies(res: Response): string[] {
  return (res.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
}

describe("middleware session cookies", () => {
  it("production: every refreshed auth cookie is Secure, SameSite=Lax and at most 30 days; deletion stays 0", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await middleware(new NextRequest("https://nightshift.test/chronos/videos"));
    const cookies = setCookies(res);
    expect(cookies.length).toBe(3);
    for (const c of cookies.slice(0, 2)) {
      expect(c, c).toMatch(/; Secure/i);
      expect(c, c).toMatch(/SameSite=lax/i);
      expect(c, c).toMatch(/Max-Age=2592000(;|$)/);
      expect(c, c).not.toMatch(/HttpOnly/i);
    }
    expect(cookies[2]).toMatch(/Max-Age=0/);
    expect(cookies[2]).toMatch(/; Secure/i);
  });

  it("outside production the cookie is not Secure (http://localhost keeps working) but is still capped", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const res = await middleware(new NextRequest("http://localhost:3000/chronos/videos"));
    const cookies = setCookies(res);
    expect(cookies.length).toBe(3);
    for (const c of cookies.slice(0, 2)) {
      expect(c).not.toMatch(/; Secure/i);
      expect(c).toMatch(/Max-Age=2592000(;|$)/);
    }
  });
});
