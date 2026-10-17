import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * A signed-out call to /api/* is a 401 JSON answer, never a redirect. fetch() follows a 307 to /login and returns the
 * sign-in page as a 200, so every owner button that only read `res.ok` reported success for something that never ran.
 * Page navigations keep the redirect to /login.
 */
const auth = vi.hoisted(() => ({ user: null as { id: string } | null, error: null as null | { name: string; status: number }, clearCookie: false }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_u: string, _k: string, opts: { cookies: { setAll: (c: { name: string; value: string; options: object }[]) => void } }) => ({
    auth: { getUser: async () => {
      // What auth-js does with a dead session: it clears the cookie it was handed.
      if (auth.clearCookie) opts.cookies.setAll([{ name: "sb-project-auth-token", value: "", options: { maxAge: 0, path: "/" } }]);
      return { data: { user: auth.user }, error: auth.error };
    }, mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" } }) } },
    rpc: async () => ({ data: false, error: null }),
  }),
}));
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://project.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));

const { middleware } = await import("@/middleware");
const call = (path: string, method = "GET") => middleware(new NextRequest(`https://nightshift.test${path}`, { method }));

beforeEach(() => {
  auth.user = null;
  auth.error = null;
  auth.clearCookie = false;
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

describe("how a request says it is a navigation", () => {
  const url = "https://nightshift.test/api/alerts/test";
  it("HEAD with the navigation mark is a navigation", async () => {
    const res = await middleware(new NextRequest(url, { method: "HEAD", headers: { "sec-fetch-mode": "navigate" } }));
    expect(res.status).toBe(307);
  });
  it("an old browser (no Sec-Fetch-Mode) that accepts HTML is a navigation; one that asks for JSON or anything is a call", async () => {
    const html = await middleware(new NextRequest(url, { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } }));
    expect(html.status).toBe(307);
    for (const accept of ["application/json", "*/*"]) {
      const call = await middleware(new NextRequest(url, { headers: { accept } }));
      expect(call.status, accept).toBe(401);
    }
    expect((await middleware(new NextRequest(url))).status).toBe(401);
  });
  it("Sec-Fetch-Mode wins over Accept: a fetch that accepts HTML is still a call", async () => {
    const res = await middleware(new NextRequest(url, { headers: { "sec-fetch-mode": "cors", accept: "text/html" } }));
    expect(res.status).toBe(401);
  });
  it("the 401 and the redirect both vary on the fetch headers (a cache must not swap one for the other)", async () => {
    const call = await middleware(new NextRequest(url));
    const nav = await middleware(new NextRequest(url, { headers: { "sec-fetch-mode": "navigate" } }));
    expect(call.headers.get("vary")).toContain("Sec-Fetch-Mode");
    expect(call.headers.get("vary")).toContain("Sec-Fetch-Dest");
    expect(nav.headers.get("vary")).toContain("Sec-Fetch-Mode");
  });
  it("the OAuth callback opened in the browser is sent to /login", async () => {
    const res = await middleware(new NextRequest("https://nightshift.test/api/oauth/youtube/callback?code=x", { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "https://x/").pathname).toBe("/login");
  });
});

describe("routes that are public signed out stay as they were (no 401)", () => {
  it.each([
    ["POST", "/api/email/unsubscribe"],
    ["GET", "/api/handle-available?h=abc"],
    ["POST", "/api/mcp"],
    ["GET", "/api/media/file/3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e/thumb"],
    ["GET", "/api/v1/videos"],
  ])("%s %s", async (method, path) => {
    const res = await call(path, method);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("the auth server did not answer (not the same as signed out)", () => {
  it("a retryable auth failure answers an API call 503 auth_unavailable, no-store", async () => {
    auth.error = { name: "AuthRetryableFetchError", status: 0 };
    const res = await call("/api/billing/topup", "POST");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "auth_unavailable" });
  });
  it("so does a 5xx from the auth server", async () => {
    auth.error = { name: "AuthApiError", status: 502 };
    expect((await call("/api/alerts/test", "POST")).status).toBe(503);
  });
  it("'no session' errors are still 401", async () => {
    auth.error = { name: "AuthSessionMissingError", status: 400 };
    expect((await call("/api/alerts/test", "POST")).status).toBe(401);
    auth.error = { name: "AuthApiError", status: 401 };
    expect((await call("/api/alerts/test", "POST")).status).toBe(401);
  });
  it("page navigations are unchanged: still the redirect to /login", async () => {
    auth.error = { name: "AuthRetryableFetchError", status: 0 };
    const res = await middleware(new NextRequest("https://nightshift.test/chronos/billing", { headers: { "sec-fetch-mode": "navigate" } }));
    expect(res.status).toBe(307);
  });
});

describe("cookies the auth client cleared reach the browser on the 401", () => {
  it("the cleared session cookie is on the response", async () => {
    auth.clearCookie = true;
    const res = await call("/api/billing/refresh", "POST");
    expect(res.status).toBe(401);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toContain("sb-project-auth-token=");
    expect(set).toMatch(/Max-Age=0|Expires=/i);
  });
});
