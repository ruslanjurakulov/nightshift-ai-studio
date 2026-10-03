import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DEV_PAGE_PATHS, devPageDecision, devPagesEnabled, isDevPagePath } from "@/lib/dev-pages";
import {
  INFO_PATHS,
  RESERVED_ROOT_SEGMENTS,
  SITEMAP_PATHS,
  gateDecision,
  isAlwaysPublicPath,
  isUnknownDocsPath,
} from "@/lib/public-paths";

/**
 * The developer pages' routes. /mcp is public always, named exactly. /docs/cli
 * and /docs/skills are public only while DEV_CLI_PAGE=1 (lib/dev-pages.ts): off,
 * they are the public 404 for everyone, in no sitemap and no link.
 */

const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: auth.user } }) },
  }),
}));
vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon",
  isSupabaseConfigured: true,
}));

const { middleware } = await import("@/middleware");

async function visit(path: string, signedIn: boolean) {
  auth.user = signedIn ? { id: "u1" } : null;
  const res = await middleware(new NextRequest(`https://nightshift.test${path}`));
  const location = res.headers.get("location");
  const rewrite = res.headers.get("x-middleware-rewrite");
  return { res, redirect: location ? new URL(location).pathname : null, rewrite: rewrite ? new URL(rewrite).pathname : null };
}

beforeEach(() => {
  auth.user = null;
  vi.stubEnv("DEV_CLI_PAGE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the DEV_CLI_PAGE flag", () => {
  it("is on only for the literal 1", () => {
    expect(devPagesEnabled({ DEV_CLI_PAGE: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1", "1 ", "on"]) expect(devPagesEnabled({ DEV_CLI_PAGE: v })).toBe(false);
  });

  it("reads the process environment at call time, never a build-time value", () => {
    expect(devPagesEnabled()).toBe(false);
    vi.stubEnv("DEV_CLI_PAGE", "1");
    expect(devPagesEnabled()).toBe(true);
  });

  it("decides for exactly the two pages, with or without a trailing slash", () => {
    for (const p of ["/docs/cli", "/docs/cli/", "/docs/skills", "/docs/skills/"]) {
      expect(isDevPagePath(p), p).toBe(true);
      expect(devPageDecision(p, true), p).toBe("serve");
      expect(devPageDecision(p, false), p).toBe("hide");
    }
    for (const p of ["/docs", "/docs/api", "/docs/cli/x", "/docs/clix", "/docs/skills/x", "/docs/CLI", "/docs/cli.rsc", "/cli", "/mcp"]) {
      expect(isDevPagePath(p), p).toBe(false);
      expect(devPageDecision(p, true), p).toBe("none");
      expect(devPageDecision(p, false), p).toBe("none");
    }
  });
});

describe("with the flag off, /docs/cli and /docs/skills are the public 404", () => {
  it.each([...DEV_PAGE_PATHS, "/docs/cli/", "/docs/skills/"])("%s: signed out and signed in", async (path) => {
    for (const signedIn of [false, true]) {
      const { res, redirect, rewrite } = await visit(path, signedIn);
      expect(res.status, `${path} signedIn=${signedIn}`).toBe(404);
      expect(redirect).toBeNull();
      expect(rewrite).toBe("/_not-found");
    }
  });

  it("are in no sitemap list and no always-public list", () => {
    for (const p of DEV_PAGE_PATHS) {
      expect((SITEMAP_PATHS as readonly string[]).includes(p)).toBe(false);
      expect(isAlwaysPublicPath(p)).toBe(false);
    }
  });

  it("the page itself is a 404 too, if a request ever reached it", async () => {
    const { default: Cli } = await import("@/app/docs/cli/page");
    const { default: Skills } = await import("@/app/docs/skills/page");
    await expect(Cli()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    await expect(Skills()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });
});

describe("with the flag on, the two pages are public pages", () => {
  beforeEach(() => vi.stubEnv("DEV_CLI_PAGE", "1"));

  it.each([...DEV_PAGE_PATHS, "/docs/cli/"])("%s opens signed out, with no redirect and no 404", async (path) => {
    const { res, redirect, rewrite } = await visit(path, false);
    expect(res.status).toBe(200);
    expect(redirect).toBeNull();
    expect(rewrite).toBeNull();
  });

  it.each(["/docs/cli/x", "/docs/clix", "/docs/skills/x", "/docs/skillsx", "/docs/CLI", "/docs/cli.rsc", "/docs/anything"])(
    "a look-alike, %s, is still the 404 signed out (never a sign-in form for a page that is not there)",
    async (path) => {
      const { res, redirect, rewrite } = await visit(path, false);
      expect(redirect).toBeNull();
      expect(res.status).toBe(404);
      expect(rewrite).toBe("/_not-found");
    },
  );

  it("the sitemap lists them, and only now", async () => {
    vi.stubEnv("APP_ORIGIN", "https://nightshift.test");
    const { default: sitemap } = await import("@/app/sitemap");
    const on = sitemap().map((e) => new URL(e.url).pathname);
    expect(on).toEqual(expect.arrayContaining(["/docs/api", "/mcp", "/docs/cli", "/docs/skills"]));
    vi.stubEnv("DEV_CLI_PAGE", "");
    const off = sitemap().map((e) => new URL(e.url).pathname);
    expect(off).toContain("/mcp");
    expect(off).not.toContain("/docs/cli");
    expect(off).not.toContain("/docs/skills");
  });
});

describe("/mcp is public, exactly", () => {
  it("is in the info and sitemap lists, and reserved as a root segment", () => {
    expect(INFO_PATHS).toContain("/mcp");
    expect(SITEMAP_PATHS).toContain("/mcp");
    expect(RESERVED_ROOT_SEGMENTS).toContain("mcp");
  });

  it.each(["/mcp", "/mcp/"])("%s opens signed out", async (path) => {
    const { redirect, res } = await visit(path, false);
    expect(redirect).toBeNull();
    expect(res.status).toBe(200);
  });

  it("opens signed in too, as a page (not as a channel screen)", () => {
    expect(gateDecision("/mcp", true)).toBe("pass");
  });

  it("is not the MCP server: /api/mcp stays exactly the API key door", () => {
    expect(gateDecision("/api/mcp", false)).toBe("pass");
    expect(gateDecision("/api/mcpx", false)).toBe("to-login");
  });

  it.each(["/mcp/providers", "/mcp/x"])("a deeper path, %s, is an app URL: sent to /login signed out", async (path) => {
    expect((await visit(path, false)).redirect).toBe("/login");
  });

  it("a one-segment look-alike gets the 404", async () => {
    const { redirect, res } = await visit("/mcpx", false);
    expect(redirect).toBeNull();
    expect(res.status).toBe(404);
  });
});

describe("an unknown /docs path signed out", () => {
  it("is the 404, while /docs itself and the real pages keep their behaviour", async () => {
    expect(isUnknownDocsPath("/docs/nope")).toBe(true);
    expect(isUnknownDocsPath("/docs/nope/")).toBe(true);
    for (const p of ["/docs", "/docs/api", "/docs/api/", "/docs/api/openapi.json", "/pricing"]) expect(isUnknownDocsPath(p), p).toBe(false);
    expect((await visit("/docs/nope", false)).res.status).toBe(404);
    expect((await visit("/docs", false)).redirect).toBe("/login");
    expect((await visit("/docs/api", false)).redirect).toBeNull();
    expect((await visit("/docs/api/openapi.json", false)).redirect).toBeNull();
  });
});
