import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

/**
 * The Atelier concept prototypes (lib/concepts.ts) are not public pages.
 * Off (the default) the whole /atelier namespace is the public 404, signed in
 * or out; on, exactly three URLs are served, noindex; they are in no sitemap,
 * robots rule or public-path list; and the BR-H-001 gate answers the same as
 * before for these paths.
 */

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

const { middleware } = await import("@/middleware");
const {
  CONCEPT_FLAG,
  CONCEPT_PATHS,
  CONCEPT_VARIANTS,
  conceptDecision,
  conceptsEnabled,
  inConceptNamespace,
} = await import("@/lib/concepts");
const publicPaths = await import("@/lib/public-paths");
const { default: sitemap } = await import("@/app/sitemap");
const { default: robots } = await import("@/app/robots");

beforeEach(() => {
  auth.user = null;
  auth.calls = 0;
  vi.unstubAllEnvs();
});

async function visit(path: string, signedIn = false) {
  auth.user = signedIn ? { id: "u1" } : null;
  const res = await middleware(new NextRequest(`https://nightshift.test${path}`));
  const rewrite = res.headers.get("x-middleware-rewrite");
  const location = res.headers.get("location");
  return {
    res,
    notFound: res.status === 404 && Boolean(rewrite?.endsWith("/_not-found")),
    redirect: location ? new URL(location).pathname : null,
    served: res.status === 200 && !rewrite && !location,
  };
}

describe("the flag", () => {
  it("is on only for the literal 1", () => {
    expect(CONCEPT_FLAG).toBe("ATELIER_CONCEPTS");
    expect(conceptsEnabled({ ATELIER_CONCEPTS: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1", "1 ", "on"]) {
      expect(conceptsEnabled({ ATELIER_CONCEPTS: v })).toBe(false);
    }
    expect(conceptsEnabled({})).toBe(false);
  });

  it("is a server variable, never a NEXT_PUBLIC one", () => {
    expect(CONCEPT_FLAG.startsWith("NEXT_PUBLIC_")).toBe(false);
  });
});

describe("conceptDecision", () => {
  it("does not touch paths outside the namespace", () => {
    for (const p of ["/", "/pricing", "/login", "/chronos/videos", "/atelierx/a", "/x/atelier/a", "//atelier/a"]) {
      expect(conceptDecision(p, true)).toBe("none");
      expect(conceptDecision(p, false)).toBe("none");
    }
  });

  it("hides everything under /atelier when off", () => {
    for (const p of ["/atelier", "/atelier/", "/atelier/a", "/atelier/b", "/atelier/c", "/atelier/d", "/Atelier/a", "/atelier/a/x"]) {
      expect(conceptDecision(p, false)).toBe("hide");
    }
  });

  it("serves exactly three URLs when on, and hides every other spelling", () => {
    expect(CONCEPT_PATHS).toEqual(["/atelier/a", "/atelier/b", "/atelier/c"]);
    for (const p of CONCEPT_PATHS) expect(conceptDecision(p, true)).toBe("serve");
    expect(conceptDecision("/atelier/a/", true)).toBe("serve");
    for (const p of ["/atelier", "/atelier/", "/atelier/d", "/atelier/A", "/atelier/%61", "/atelier/a/b", "/atelier/a%2fb", "/ATELIER/a", "/atelier/a.json", "/atelier/../chronos"]) {
      expect(conceptDecision(p, true)).toBe("hide");
    }
  });

  it("recognises the namespace case-insensitively", () => {
    expect(inConceptNamespace("/ATELIER/x")).toBe(true);
    expect(inConceptNamespace("/atelier")).toBe(true);
    expect(inConceptNamespace("/atelierx")).toBe(false);
  });
});

describe("middleware, flag off (production default)", () => {
  it.each(["/atelier", "/atelier/a", "/atelier/b", "/atelier/c", "/atelier/zzz", "/atelier/a/x"])(
    "%s is the public 404 signed out and signed in, never a sign-in redirect",
    async (path) => {
      for (const signedIn of [false, true]) {
        const r = await visit(path, signedIn);
        expect(r.notFound).toBe(true);
        expect(r.redirect).toBeNull();
      }
    },
  );

  it("a value other than 1 is still off", async () => {
    vi.stubEnv("ATELIER_CONCEPTS", "true");
    expect((await visit("/atelier/a")).notFound).toBe(true);
  });
});

describe("middleware, flag on", () => {
  beforeEach(() => vi.stubEnv("ATELIER_CONCEPTS", "1"));

  it.each(["/atelier/a", "/atelier/b", "/atelier/c", "/atelier/a/"])("%s is served, noindex, to a signed-out visitor", async (path) => {
    const r = await visit(path);
    expect(r.served).toBe(true);
    expect(r.res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it.each(["/atelier", "/atelier/d", "/atelier/a/x", "/atelier/%61", "/ATELIER/a"])("%s stays a 404", async (path) => {
    expect((await visit(path)).notFound).toBe(true);
  });

  // BR-L-161: the served response must be built with { request }, or the CSP
  // nonce set on the request never reaches the renderer and an enforced policy
  // blocks the page's scripts.
  it("forwards the CSP nonce to the renderer (response built with { request })", async () => {
    vi.stubEnv("CSP_MODE", "enforce");
    const r = await visit("/atelier/a");
    expect(r.served).toBe(true);
    expect(r.res.headers.get("content-security-policy")).toMatch(/'nonce-[^']+'/);
    const forwarded = r.res.headers.get("x-middleware-request-content-security-policy");
    expect(forwarded).toMatch(/'nonce-[^']+'/);
    expect(r.res.headers.get("x-middleware-override-headers")).toContain("content-security-policy");
  });

  it("is decided before the gate: no session round trip for a served concept", async () => {
    await visit("/atelier/b");
    expect(auth.calls).toBe(0);
    await visit("/atelier/zzz");
    expect(auth.calls).toBe(0);
    await visit("/chronos/videos");
    expect(auth.calls).toBe(1);
  });

  it("does not open any other private path", async () => {
    expect((await visit("/chronos/videos")).redirect).toBe("/login");
    expect((await visit("/welcome")).redirect).toBe("/login");
    expect((await visit("/atelierx/a")).notFound).toBe(false);
  });
});

describe("the gate is not weakened and the paths are in no public list", () => {
  it("gateDecision answers as before: signed out, a concept URL is private", () => {
    for (const p of [...CONCEPT_PATHS, "/atelier"]) {
      expect(publicPaths.gateDecision(p, false)).toBe("to-login");
      expect(publicPaths.isPublicPath(p)).toBe(false);
      expect(publicPaths.isAlwaysPublicPath(p)).toBe(false);
    }
  });

  it("no public-path list names /atelier", () => {
    const lists = [
      publicPaths.PUBLIC_PATHS,
      publicPaths.ALWAYS_PUBLIC_PATHS,
      publicPaths.SITEMAP_PATHS,
      publicPaths.INFO_PATHS,
      publicPaths.SOLUTION_PATHS,
      publicPaths.CRAWLER_PATHS,
      publicPaths.PUBLIC_FONT_PATHS,
    ];
    for (const list of lists) for (const p of list) expect(p.toLowerCase()).not.toContain("atelier");
  });

  it("the sitemap does not list the concepts, with or without an origin", () => {
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    vi.stubEnv("ATELIER_CONCEPTS", "1");
    const urls = sitemap().map((e) => e.url);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.join("\n").toLowerCase()).not.toContain("atelier");
  });

  it("robots.txt neither allows nor names the concepts (a rule would publish the path)", () => {
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    vi.stubEnv("ATELIER_CONCEPTS", "1");
    expect(JSON.stringify(robots()).toLowerCase()).not.toContain("atelier");
  });

  it("the middleware matcher is the one BR-H-001 pins: it does not name /atelier", () => {
    const src = readFileSync(join(__dirname, "..", "middleware.ts"), "utf8");
    const matcher = src.slice(src.indexOf("export const config"));
    expect(matcher.toLowerCase()).not.toContain("atelier");
  });
});

describe("the page checks the flag itself", () => {
  it("the route file calls notFound() before reading anything when the flag is off", () => {
    const src = readFileSync(join(__dirname, "..", "app/(concepts)/atelier/[variant]/page.tsx"), "utf8");
    expect(src).toMatch(/dynamic = "force-dynamic"/);
    expect(src).toMatch(/robots: \{ index: false, follow: false/);
    expect(src.indexOf("if (!conceptsEnabled()) notFound();")).toBeGreaterThan(-1);
    expect(src.indexOf("if (!conceptsEnabled()) notFound();")).toBeLessThan(src.indexOf("getDictionary()"));
    expect(CONCEPT_VARIANTS).toEqual(["a", "b", "c"]);
  });
});
