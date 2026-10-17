import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * A signed-out call to /api/* is a 401 JSON answer, never a redirect. fetch() follows a 307 to /login and returns the
 * sign-in page as a 200, so every owner button that only read `res.ok` reported success for something that never ran.
 * Page navigations keep the redirect to /login.
 */
const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: auth.user } }), mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" } }) } },
    rpc: async () => ({ data: false, error: null }),
  }),
}));
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://project.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));

const { middleware } = await import("@/middleware");
const call = (path: string, method = "GET") => middleware(new NextRequest(`https://nightshift.test${path}`, { method }));

beforeEach(() => {
  auth.user = null;
  vi.unstubAllEnvs();
  vi.stubEnv("NIGHTSHIFT_ADMIN_MFA", "");
});

describe("signed out, /api/*", () => {
  it.each([
    ["POST", "/api/billing/refresh"],
    ["POST", "/api/alerts/test"],
    ["POST", "/api/billing/topup"],
    ["POST", "/api/billing/settings"],
    ["POST", "/api/setup/secrets"],
    ["GET", "/api/alerts/test"],
    ["PUT", "/api/anything"],
    ["DELETE", "/api/anything"],
  ])("%s %s answers 401 JSON with no redirect", async (method, path) => {
    const res = await call(path, method);
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("the public API and the page-view beacon stay public (no 401)", async () => {
    expect((await call("/api/v1/videos")).status).toBe(200);
    expect((await call("/api/pv", "POST")).status).toBe(200);
  });
});

describe("signed out, a browser navigation to an API-shaped URL", () => {
  const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  it("keeps the redirect to /login (the YouTube connect link opened from the app)", async () => {
    const res = await middleware(new NextRequest("https://nightshift.test/api/oauth/youtube/start", { headers: nav }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "https://x/").pathname).toBe("/login");
  });
  it("but a POST is never a navigation, whatever headers it carries", async () => {
    const res = await middleware(new NextRequest("https://nightshift.test/api/billing/refresh", { method: "POST", headers: nav }));
    expect(res.status).toBe(401);
  });
  it("and a fetch (Sec-Fetch-Mode: same-origin) is a call", async () => {
    const res = await middleware(new NextRequest("https://nightshift.test/api/alerts/test", { headers: { "sec-fetch-mode": "same-origin", "sec-fetch-dest": "empty" } }));
    expect(res.status).toBe(401);
  });
});

describe("signed out, pages", () => {
  it("still redirect to /login", async () => {
    const res = await call("/chronos/billing");
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "https://x/").pathname).toBe("/login");
  });
});

describe("signed in, /api/*", () => {
  it("passes through to the route (the route does its own role check)", async () => {
    auth.user = { id: "u1" };
    const res = await call("/api/alerts/test", "POST");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});
