import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isUnknownRootPath } from "@/lib/channels";

// A site with no backend configured: the shape Pixel scored, and any deploy
// that has not been given its database yet.
vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  isSupabaseConfigured: false,
}));

const { middleware } = await import("@/middleware");

function visit(path: string) {
  return middleware(new NextRequest(`https://nightshift.test${path}`));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a built site with no backend", () => {
  it.each(["/blog", "/about", "/contact", "/no-such-page-xyz", "/xyz/videos", "/chronos/command-center", "/welcome"])(
    "answers the app URL %s with the public 404, never the app frame or its setup notice",
    async (path) => {
      vi.stubEnv("NODE_ENV", "production");
      const res = await visit(path);
      expect(res.status).toBe(404);
      expect(new URL(res.headers.get("x-middleware-rewrite") ?? "").pathname).toBe("/_not-found");
    },
  );

  it.each(["/", "/pricing", "/privacy", "/terms", "/solutions", "/login", "/signup", "/docs/api", "/api/v1/models", "/api/credits"])(
    "serves %s as it is",
    async (path) => {
      vi.stubEnv("NODE_ENV", "production");
      const res = await visit(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    },
  );

  it("keeps the setup notice under `next dev`, for whoever is wiring the site up", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await visit("/blog");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

describe("isUnknownRootPath", () => {
  it("is a single segment that is no section, no every-channel view and no reserved page", () => {
    for (const p of ["/blog", "/about", "/blog/", "/chronos", "/x"]) expect(isUnknownRootPath(p)).toBe(true);
    for (const p of ["/", "/videos", "/all-channels", "/welcome", "/auth", "/docs", "/api", "/login", "/a/b", "/chronos/videos"]) {
      expect(isUnknownRootPath(p)).toBe(false);
    }
  });
});

describe("the app frame's own backstop", () => {
  // If a request ever reached the app layout of a built site with no backend,
  // it 404s there too, rather than render setup copy to a visitor.
  it("calls notFound() for a production build with no backend", () => {
    const src = readFileSync(join(__dirname, "..", "app", "(app)", "layout.tsx"), "utf8");
    expect(src).toMatch(/if \(!isSupabaseConfigured && process\.env\.NODE_ENV === "production"\) notFound\(\);/);
  });
});
