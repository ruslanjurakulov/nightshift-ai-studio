import type { NextConfig } from "next";

/**
 * Security headers for every response (BR-S-007), the same set the Caddy layer
 * adds on the self-hosted box. Frame protection is enforced twice: the legacy
 * X-Frame-Options and a CSP that holds only `frame-ancestors 'none'`, which
 * restricts who may frame the app and nothing about what it loads, so it
 * cannot break a page. A full content CSP is BR-S-008 and is not set here.
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
    ];
  },
};

export default nextConfig;
