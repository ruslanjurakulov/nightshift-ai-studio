import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * BR-L-161: with no backend configured the middleware has an early block that
 * answers the public 404 for every private-looking path. The concept decision
 * runs before it, so flag on serves the three pages with no backend, and flag
 * off is the 404 (not a pass-through to the page).
 */
vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  isSupabaseConfigured: false,
}));

const { middleware } = await import("@/middleware");

async function visit(path: string) {
  const res = await middleware(new NextRequest(`https://nightshift.test${path}`));
  const rewrite = res.headers.get("x-middleware-rewrite");
  return { res, notFound: res.status === 404 && Boolean(rewrite?.endsWith("/_not-found")), served: res.status === 200 && !rewrite };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "production");
});

describe("no backend configured, production build", () => {
  it("flag on: the three concept URLs are served (noindex), not the no-backend 404", async () => {
    vi.stubEnv("ATELIER_CONCEPTS", "1");
    for (const p of ["/atelier/a", "/atelier/b", "/atelier/c"]) {
      const r = await visit(p);
      expect(r.served).toBe(true);
      expect(r.res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });

  it("flag on: anything else under /atelier is still the 404", async () => {
    vi.stubEnv("ATELIER_CONCEPTS", "1");
    for (const p of ["/atelier", "/atelier/d", "/atelier/a/x"]) expect((await visit(p)).notFound).toBe(true);
  });

  it("flag off: the whole namespace is the 404", async () => {
    for (const p of ["/atelier", "/atelier/a", "/atelier/b", "/atelier/c"]) expect((await visit(p)).notFound).toBe(true);
  });

  it("the no-backend 404 for private paths is unchanged", async () => {
    vi.stubEnv("ATELIER_CONCEPTS", "1");
    expect((await visit("/chronos/videos")).notFound).toBe(true);
    expect((await visit("/")).served).toBe(true);
  });
});
