import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { isSignedMediaPath } from "@/lib/public-paths";

// Pins on how the media routes (migration 0038) meet the middleware: an upload
// body must never pass through it (Next buffers it in RAM and cuts it at
// 10 MB), and a signed media link carries its own authorization.

const auth = vi.hoisted(() => ({ user: null as { id: string } | null, calls: 0 }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        auth.calls += 1;
        return { data: { user: auth.user } };
      },
    },
  }),
}));

vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon",
  isSupabaseConfigured: true,
}));

const { middleware, config } = await import("@/middleware");
// Next's own matcher compiler (not in its public types), so the test checks
// the regex Next actually builds, not a copy of it.
const { getMiddlewareMatchers } = (await import("next/dist/build/analysis/get-page-static-info")) as unknown as {
  getMiddlewareMatchers: (matcher: unknown, nextConfig: unknown) => { regexp: string }[];
};

const ID = "3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";

beforeEach(() => {
  auth.user = null;
  auth.calls = 0;
});

describe("the middleware matcher, compiled the way Next compiles it", () => {
  const re = getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));
  const runs = (p: string) => re.some((r) => r.test(p));

  it("never sees an upload body", () => {
    expect(runs(`/api/media/uploads/${ID}`)).toBe(false);
  });

  it("still gates everything else under /api/media", () => {
    for (const p of ["/api/media", "/api/media/uploads", `/api/media/${ID}`, `/api/media/file/${ID}/thumb`, "/chronos/videos"])
      expect(runs(p), p).toBe(true);
  });

  it("is what the upload route's comment says it is", () => {
    const src = readFileSync(join(__dirname, "..", "app/api/media/uploads/[ticket]/route.ts"), "utf8");
    expect(src).toContain("const user = await getUser();");
    expect(src).toContain('if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });');
  });
});

describe("signed media links pass the cookie gate", () => {
  it("serves /api/media/file/<id>/<variant> signed out, without a session lookup", async () => {
    const res = await middleware(new NextRequest(`https://nightshift.test/api/media/file/${ID}/thumb?exp=1&sig=x`));
    expect(res.headers.get("location")).toBeNull();
    expect(auth.calls).toBe(0);
  });

  it.each([
    "/api/media",
    `/api/media/${ID}`,
    "/api/media/uploads",
    `/api/media/file/${ID}`,
    `/api/media/file/${ID}/thumb/extra`,
    `/api/media/file/../../x/thumb`,
    `/api/media/filex/${ID}/thumb`,
  ])("%s stays behind sign-in", async (path) => {
    expect(isSignedMediaPath(path)).toBe(false);
    const res = await middleware(new NextRequest(`https://nightshift.test${path}`));
    expect(new URL(res.headers.get("location") ?? "https://x/").pathname).toBe("/login");
  });
});
