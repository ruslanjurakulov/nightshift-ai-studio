import type { NextConfig } from "next";

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
