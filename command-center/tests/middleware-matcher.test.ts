import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";

/**
 * BR-H-001: the middleware matcher decides which requests the auth gate never
 * sees. Its `favicon.ico` exclusion was unanchored (and its dot unescaped), so
 * any path whose first segment STARTED with "favicon.ico" — or "faviconXico" —
 * skipped the gate: signed out, `/favicon.icox/providers` rendered the
 * operator console. The `.*\.png$` exclusion did the same for any app page
 * whose URL ends in an image extension (`/chronos/videos/x.png`).
 *
 * The matcher is compiled here by Next's own compiler (the regex Next ships in
 * middleware-manifest.json), and every hostile path must (a) be matched, so
 * the middleware runs, and (b) be sent to /login by the middleware when signed
 * out. The real static files must stay unmatched, so they stay public.
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

const { middleware, config } = await import("@/middleware");
const { getMiddlewareMatchers } = (await import("next/dist/build/analysis/get-page-static-info")) as unknown as {
  getMiddlewareMatchers: (matcher: unknown, nextConfig: unknown) => { regexp: string }[];
};

const matchers = getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));
/** Does the middleware run for this (raw, as sent) path? */
const runs = (path: string) => matchers.some((r) => r.test(path));

const ID = "3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const ROOT = join(__dirname, "..");

beforeEach(() => {
  auth.user = null;
});

/** The paths a signed-out visitor used, or could use, to get past the gate. */
const HOSTILE = [
  // The reported bypass and its siblings.
  "/favicon.icox/providers",
  "/favicon.ico/providers",
  "/favicon.ico.x/providers",
  "/favicon.icox/billing",
  "/favicon.icox/logs",
  "/favicon.icox/alerts",
  "/favicon.icox/getting-started",
  "/favicon.ico2/margin",
  "/favicon.ico/",
  "/favicon.ico.",
  "/favicon.ico./providers",
  "/favicon.icox",
  // The unescaped dot.
  "/faviconXico/providers",
  "/favicon-ico/providers",
  // Encoded variants (%2e is "."; %2f is "/"; %66 is "f").
  "/favicon%2eico/providers",
  "/favicon%2Eicox/providers",
  "/favicon.ico%2fproviders",
  "/favicon.ico%2Fproviders",
  "/%66avicon.ico/providers",
  "/favicon.ico%00/providers",
  // Double slashes and dot segments.
  "//favicon.icox/providers",
  "//favicon.ico",
  "/favicon.ico//providers",
  "/favicon.ico/../chronos/providers",
  "/favicon.ico/%2e%2e/chronos/providers",
  // Case variants.
  "/FAVICON.ICO/providers",
  "/Favicon.icox/providers",
  "/FAVICON.ICO",
  // Other static-file names as prefixes.
  "/icon.pngx/providers",
  "/icon.png/providers",
  "/apple-icon.png/providers",
  "/og.png/providers",
  "/og.pngx",
  "/robots.txt/providers",
  "/sitemap.xml/providers",
  // The gate's own public-path test was a prefix for /login (lib/public-paths.ts).
  "/loginx/providers",
  "/login/providers",
  "/login.x/billing",
  "/login-anything/alerts",
  // App pages whose URL merely ENDS in an image extension.
  "/chronos/videos/abc.png",
  "/chronos/editor/abc.png",
  "/chronos/workflows/abc.png",
  "/chronos/videos/storyboard/abc.svg",
  "/chronos.png",
  "/chronos.webp",
  "/x.svg/providers",
  "/chronos/providers.jpg",
  "/chronos/providers.jpeg",
  "/chronos/providers.gif",
  // /_next lookalikes.
  "/_next/staticx/providers",
  "/_next/static",
  "/_next/imagex/providers",
  "/_next/image/providers",
  "/_next/image.png",
  "/_nextx/static/providers",
  "/_next",
  "/_next/",
  "/_next/data/build/favicon.icox/providers.json",
  // Upload lookalikes: only one segment after /api/media/uploads/ is the upload body.
  "/api/media/uploads/",
  `/api/media/uploads/${ID}/extra`,
  "/api/media/uploads/x/../../../chronos/providers",
  "/api/media/uploadsx/abc",
] as const;

describe("BR-H-001: the matcher has no unanchored exclusion", () => {
  it("is what Next ships (one entry, compiled without error)", () => {
    expect(config.matcher).toHaveLength(1);
    expect(matchers).toHaveLength(1);
  });

  it.each(HOSTILE)("the middleware runs for %s", (path) => {
    expect(runs(path)).toBe(true);
  });

  it.each(HOSTILE)("signed out, %s is sent to /login or answered with the public 404", async (path) => {
    const res = await middleware(new NextRequest(`https://nightshift.test${path}`));
    // A path that cannot be a channel URL (a dot in its first segment, an
    // unknown root word) is answered with the public 404 instead of a sign-in
    // form: a rewrite to the root not-found page, which runs no app layout and
    // reads nothing. Either way the app is never rendered.
    if (res.status === 404) {
      expect(new URL(res.headers.get("x-middleware-rewrite") ?? "https://x/").pathname).toBe("/_not-found");
      return;
    }
    expect(res.status).toBe(307);
    // NextRequest keeps a trailing slash and a /_next/data/<build>/….json
    // wrapper on the redirect; either way the destination is the login page.
    expect(new URL(res.headers.get("location") ?? "https://x/").pathname).toMatch(
      /^(?:\/_next\/data\/[^/]+)?\/login(?:\/|\.json)?$/,
    );
  });

  it("the original report's paths, in the original's own words", () => {
    // On main 0163662 each of these skipped the middleware and returned 200
    // with the operator rail; /chronos/providers was redirected.
    for (const p of [
      "/favicon.icox/providers",
      "/favicon.ico/providers",
      "/favicon.icox/billing",
      "/favicon.icox/logs",
      "/favicon.ico2/margin",
      "/chronos/providers",
    ])
      expect(runs(p), p).toBe(true);
  });
});

describe("the sign-in page is public by its exact path only", () => {
  it("/login and /login/ pass signed out and send a signed-in user home", async () => {
    const { gateDecision } = await import("@/lib/public-paths");
    for (const p of ["/login", "/login/"]) {
      expect(gateDecision(p, false), p).toBe("pass");
      expect(gateDecision(p, true), p).toBe("to-home");
    }
  });

  it("a path that merely starts with /login is an app URL", async () => {
    const { gateDecision } = await import("@/lib/public-paths");
    for (const p of ["/loginx/providers", "/login/providers", "/login.x"]) {
      expect(gateDecision(p, false), p).toBe("to-login");
      expect(gateDecision(p, true), p).toBe("app");
    }
  });
});

describe("the real static files stay public", () => {
  const PUBLIC_STATIC = [
    "/_next/static/chunks/main-app.js",
    "/_next/static/chunks/app/(app)/%5Bchannel%5D/page-0123abcd.js",
    "/_next/static/css/app.css",
    "/_next/static/media/font.woff2",
    "/_next/static/abcdef/_buildManifest.js",
    "/_next/image",
    "/favicon.ico",
    "/icon.png",
    "/apple-icon.png",
    "/og.png",
    `/api/media/uploads/${ID}`,
  ];

  it.each(PUBLIC_STATIC)("%s skips the middleware", (path) => {
    expect(runs(path)).toBe(false);
  });

  it("every metadata image at the app root is excluded by its exact name", () => {
    const files = readdirSync(join(ROOT, "app")).filter(
      (f) => /\.(?:ico|png|jpe?g|gif|svg|webp)$/.test(f) && statSync(join(ROOT, "app", f)).isFile(),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(runs(`/${f}`), f).toBe(false);
    // og.png is a route handler directory, not a file; it is public too.
    expect(existsSync(join(ROOT, "app", "og.png", "route.tsx"))).toBe(true);
    expect(runs("/og.png")).toBe(false);
  });

  it("every file under public/ is named in the matcher (a new one fails here, not silently)", () => {
    const dir = join(ROOT, "public");
    if (!existsSync(dir)) return;
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    for (const f of walk(dir)) {
      const url = "/" + relative(dir, f).split("\\").join("/");
      expect(runs(url), `${url} would be sent to /login signed out: add it to the matcher, exactly`).toBe(false);
    }
  });

  it("an excluded name is excluded only as the whole path", () => {
    for (const name of ["favicon.ico", "icon.png", "apple-icon.png", "og.png"]) {
      expect(runs(`/${name}`), name).toBe(false);
      expect(runs(`/${name}x`), `${name}x`).toBe(true);
      expect(runs(`/${name}/x`), `${name}/x`).toBe(true);
      expect(runs(`/a/${name}`), `a/${name}`).toBe(true);
    }
  });
});
