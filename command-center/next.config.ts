import type { NextConfig } from "next";

/**
 * Security headers for every response (BR-S-007), the same set the Caddy layer
 * adds on the self-hosted box. Frame protection is enforced twice: the legacy
 * X-Frame-Options and a CSP that holds only `frame-ancestors 'none'`, which
 * restricts who may frame the app and nothing about what it loads, so it
 * cannot break a page. The full content policy (BR-S-008) carries a nonce per
 * response, so it is set in middleware.ts (lib/security/csp.ts), not here.
 */
const PERMISSIONS_POLICY =
  // payment= is opened to Paddle's checkout frame only (the Buy credits
  // overlay): with payment=() the browser hides Apple Pay / Google Pay inside
  // it. Our own page still gets nothing.
  'camera=(), microphone=(), geolocation=(), payment=("https://buy.paddle.com" "https://sandbox-buy.paddle.com"), usb=()';

export const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
];

/** The public paths that are route handlers (files), not pages. */
export const ROUTE_HANDLER_FILES = ["/robots.txt", "/sitemap.xml", "/docs/api/openapi.json"] as const;

/** The public PAGES (lib/public-paths.ts SITEMAP_PATHS, the two flag-gated
 *  developer pages of lib/dev-pages.ts, sign-in and sign-up;
 *  tests/middleware-matcher.test.ts keeps the lists equal). Literal here:
 *  the config is compiled before the app's modules. The flag-gated pages are
 *  listed even while their flag is off: their `.rsc` form then redirects to a
 *  path that answers the public 404 itself. */
export const PUBLIC_PAGE_PATHS = [
  "/",
  "/pricing",
  "/solutions",
  "/solutions/youtube-channels",
  "/solutions/creative-studio",
  "/solutions/developers",
  "/docs/api",
  "/mcp",
  "/docs/cli",
  "/docs/skills",
  "/privacy",
  "/terms",
  "/login",
  "/signup",
  // Where an invite link lands when it cannot be used (lib/public-paths.ts).
  "/invite",
] as const;

/** Must equal PUBLIC_FONT_PATHS in lib/public-paths.ts (tests/security-headers.test.ts). */
export const FONT_FILES = [
  "/fonts/onest-latin-v1.woff2",
  "/fonts/onest-latin-ext-v1.woff2",
  "/fonts/onest-cyrillic-v1.woff2",
  "/fonts/onest-cyrillic-ext-v1.woff2",
] as const;

/** The subset that cannot collide with the media file route's own headers. */
export const MEDIA_FILE_HEADERS = SECURITY_HEADERS.filter(
  (h) => h.key !== "Content-Security-Policy" && h.key !== "Referrer-Policy",
);

const nextConfig: NextConfig = {
  // The Command Center reads Supabase over the network and renders live data;
  // nothing is statically exported.
  reactStrictMode: true,
  // The self-hosted image (command-center/Dockerfile, deploy/) runs the
  // standalone server: a traced, minimal node_modules and a plain `node
  // server.js`, no `next start`. It is switched on only where the Dockerfile
  // asks for it, so the Vercel build and `npm run build` stay byte-for-byte
  // what they were — Vercel packages the app its own way and must not be
  // handed a different output mode as a side effect of self-hosting.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // Type checking stays ON (a type error fails the build — the real safety
  // net). Lint is run via `npm run lint` in CI rather than gating the Vercel
  // production build, so a style nit never blocks a deploy.
  eslint: { ignoreDuringBuilds: true },
  /**
   * Every section lives at a path that says its name, so a URL alone tells you
   * — and tells me, when you paste one — which screen you were on. These are
   * the paths those screens used to have; they are kept permanently so an old
   * bookmark, or a link in an earlier conversation, still lands correctly.
   */
  /**
   * The emailed sign-in steps (/auth/callback, /auth/confirm) are never framed
   * — a framed "Continue as …" button could be clicked for someone who never
   * saw it — never cached, and never leak their URL (a link token) by Referer.
   */
  // Caddy strips this on the self-hosted box; Vercel would send it.
  poweredByHeader: false,
  // The public pages' clips (components/site/clips/*.mp4 and *.webm) are imported like the stills: a hashed file under
  // /_next/static/media/, which the middleware never gates and the CSP's media-src 'self' allows. No loader, no new package.
  webpack(config) {
    config.module.rules.push({ test: /\.(mp4|webm)$/i, type: "asset/resource", generator: { filename: "static/media/[name].[hash][ext]" } });
    return config;
  },
  async headers() {
    return [
      // Every page and route gets the header set deploy/Caddyfile adds on the
      // self-hosted box (minus HSTS, which Vercel adds itself), so the Vercel
      // deployment is not frameable either (BR-S-007). The signed media file
      // route is left out of this rule: it sets its own, stricter
      // Content-Security-Policy (`default-src 'none'; sandbox`) and
      // Referrer-Policy, and a config header must never be able to replace
      // them. It gets the non-overlapping headers from the next rule.
      { source: "/((?!api/media/file/).*)", headers: SECURITY_HEADERS },
      { source: "/api/media/file/:path*", headers: MEDIA_FILE_HEADERS },
      // The self-hosted font files carry their version in their name, so
      // they — and only they, by exact name — are cached as immutable. Any
      // other /fonts/... path (a redirect to /login, a 404, an app screen)
      // keeps Next's own caching (lib/public-paths.ts PUBLIC_FONT_PATHS).
      ...FONT_FILES.map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      })),
      // The connection screen (MCP over OAuth, migration 0093): never framed
      // (a framed Allow button is clickjacking), never cached, and its URL
      // carries a PKCE challenge and a state, so it leaks nothing by Referer.
      {
        source: "/oauth/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      // Last, so its stricter Referrer-Policy wins over the rule above.
      {
        source: "/auth/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/timemachine", destination: "/time-machine", permanent: true },
      { source: "/measure", destination: "/measurement", permanent: true },
      { source: "/intelligence", destination: "/intelligence-map", permanent: true },
      { source: "/feedback", destination: "/feedback-loop", permanent: true },
      // BR-L-102: the router read `/robots.txt.rsc` as a channel page and
      // answered an RSC request with the app layout's skeleton, and the
      // middleware cannot tell (Next hands it the path without `.rsc` and
      // without the RSC header). A route handler has no RSC form: send it to
      // the file itself, before routing.
      ...ROUTE_HANDLER_FILES.map((path) => ({ source: `${path}.rsc`, destination: path, permanent: false })),
      // BR-L-132: the same mismatch on the public PAGES — `/pricing.rsc` with
      // an RSC header got the app layout's skeleton. A client navigation never
      // asks for the `.rsc` suffix (it sends the RSC header to the page's own
      // path), so the suffixed form goes to the page. The gate and the matcher
      // are untouched (BR-H-001).
      ...PUBLIC_PAGE_PATHS.map((path) => ({
        source: path === "/" ? "/index.rsc" : `${path}.rsc`,
        destination: path,
        permanent: false,
      })),
      { source: "/.rsc", destination: "/", permanent: false },
    ];
  },
};

export default nextConfig;
