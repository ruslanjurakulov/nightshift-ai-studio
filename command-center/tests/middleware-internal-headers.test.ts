import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";
import { CHANNEL_HEADER, PATH_HEADER, SEARCH_HEADER } from "@/lib/channels";
import { FRAME_SRC_HEADER } from "@/lib/view-mode";
import { CLIENT_IP_HEADER } from "@/lib/geo/client-ip";
import { MIDDLEWARE_OWNED_REQUEST_HEADERS } from "@/lib/security/internal-headers";
import { CSP_HEADER, CSP_REPORT_ONLY_HEADER } from "@/lib/security/csp";

// The channel, path, search, phone-frame and CSP request headers are written by the middleware for the server
// helpers behind it (lib/channels-server.ts, app/(app)/layout.tsx, app/owner/layout.tsx, app/layout.tsx, Next's
// nonce). Several early returns forward the request without setting them, and a client could once send
// `x-nightshift-channel: anything` to /pricing and have it read as if the middleware had set it. Every path class
// below must reach its handler WITHOUT the client's values, or with the middleware's own.

const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: auth.user } }) } }),
}));
vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon",
  isSupabaseConfigured: true,
}));
const { middleware } = await import("@/middleware");

const SPOOF = "spoofed-by-client";
const SPOOFED: Record<string, string> = {
  [CHANNEL_HEADER]: SPOOF,
  [PATH_HEADER]: `/${SPOOF}`,
  [SEARCH_HEADER]: `?${SPOOF}`,
  [FRAME_SRC_HEADER]: `/${SPOOF}`,
  [CSP_HEADER]: `script-src 'nonce-${SPOOF}'`,
  [CSP_REPORT_ONLY_HEADER]: `script-src 'nonce-${SPOOF}'`,
};

/**
 * The headers the route or page behind the middleware actually receives, by Next's own rule
 * (next/dist/server/lib/router-utils/resolve-routes.js): with `x-middleware-override-headers` the request carries
 * exactly the listed names, valued from `x-middleware-request-*`; without it (a bare NextResponse.next()) the
 * client's ORIGINAL headers go through unchanged. Reading only `x-middleware-request-*` would miss that second case,
 * which is the one that leaked.
 */
function seenByHandler(res: NextResponse, sent: Record<string, string>): Map<string, string> {
  const override = res.headers.get("x-middleware-override-headers");
  if (override === null) return new Map(Object.entries(sent).map(([k, v]) => [k.toLowerCase(), v]));
  const seen = new Map<string, string>();
  for (const key of override.split(",").map((k) => k.trim()).filter(Boolean)) {
    const value = res.headers.get(`x-middleware-request-${key}`);
    if (value !== null) seen.set(key, value);
  }
  return seen;
}

function reachesHandler(res: NextResponse): boolean {
  return res.headers.get("x-middleware-next") === "1" || res.headers.get("x-middleware-rewrite") !== null;
}

async function send(path: string, extra: Record<string, string> = {}, signedIn = false) {
  auth.user = signedIn ? { id: "u1" } : null;
  const sent = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", ...SPOOFED, ...extra };
  const res = await middleware(new NextRequest(new URL(path, "https://nightshift.test"), { headers: sent }));
  expect(reachesHandler(res), `${path} reaches its handler`).toBe(true);
  return seenByHandler(res, sent);
}

function expectNoSpoofedValue(seen: Map<string, string>) {
  for (const name of MIDDLEWARE_OWNED_REQUEST_HEADERS) {
    expect(seen.get(name.toLowerCase()) ?? "", name).not.toContain(SPOOF);
  }
}

const env = { ...process.env };
beforeEach(() => {
  auth.user = null;
  delete process.env.CSP_MODE;
});
afterEach(() => {
  process.env = { ...env };
});

describe("a client cannot choose a header the middleware owns", () => {
  it("a public page (/pricing) does not read a client-sent channel, path or search as the middleware's", async () => {
    const seen = await send("/pricing");
    expectNoSpoofedValue(seen);
    expect(seen.has(CHANNEL_HEADER)).toBe(false);
    expect(seen.has(PATH_HEADER)).toBe(false);
    expect(seen.has(SEARCH_HEADER)).toBe(false);
  });

  it("the public API (/api/v1) gets no client-sent internal header, though its bare next() used to forward them all", async () => {
    const seen = await send("/api/v1/videos", { authorization: "Bearer test-key" });
    expectNoSpoofedValue(seen);
    expect(seen.has(CHANNEL_HEADER)).toBe(false);
    // The route still authenticates its own bearer key: the strip must not take the request's real headers with it.
    expect(seen.get("authorization")).toBe("Bearer test-key");
  });

  it("the MCP endpoint and the page-view beacon (public API paths too) get no client-sent internal header", async () => {
    expectNoSpoofedValue(await send("/api/mcp"));
    expectNoSpoofedValue(await send("/api/pv"));
  });

  it("a signed media link gets no client-sent internal header, though its bare next() used to forward them all", async () => {
    const seen = await send("/api/media/file/3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e/thumb");
    expectNoSpoofedValue(seen);
    expect(seen.has(CHANNEL_HEADER)).toBe(false);
    // Signed media answers with its own stricter policy, so no CSP is handed in at all, the client's included.
    expect(seen.has(CSP_HEADER.toLowerCase())).toBe(false);
    expect(seen.has(CSP_REPORT_ONLY_HEADER.toLowerCase())).toBe(false);
  });

  it("a review link gets no client-sent internal header", async () => {
    const seen = await send("/r/abcdefghijklmnop1234");
    expectNoSpoofedValue(seen);
    expect(seen.has(CHANNEL_HEADER)).toBe(false);
  });

  it("a public font file gets no client-sent internal header", async () => {
    expectNoSpoofedValue(await send("/fonts/onest-latin-v1.woff2"));
  });

  it("a dev page served under DEV_CLI_PAGE=1 gets no client-sent internal header", async () => {
    process.env.DEV_CLI_PAGE = "1";
    expectNoSpoofedValue(await send("/docs/cli"));
  });

  it("signed in, /welcome (served as it is) gets no client-sent channel", async () => {
    const seen = await send("/welcome", {}, true);
    expectNoSpoofedValue(seen);
    expect(seen.has(CHANNEL_HEADER)).toBe(false);
  });

  it("an app page gets the middleware's own channel, path and search, never the client's", async () => {
    const seen = await send("/chronos/library?yt=connected", {}, true);
    expect(seen.get(CHANNEL_HEADER)).toBe("chronos");
    expect(seen.get(PATH_HEADER)).toBe("/chronos/library");
    expect(seen.get(SEARCH_HEADER)).toBe("?yt=connected");
    expectNoSpoofedValue(seen);
  });

  it("the CSP nonce Next stamps on scripts is the middleware's, not one the client named", async () => {
    for (const mode of ["enforce", "report-only", "off"]) {
      process.env.CSP_MODE = mode;
      const seen = await send("/pricing");
      expectNoSpoofedValue(seen);
      // report-only: Next reads `content-security-policy` FIRST, so a client-sent one would have chosen the nonce.
      if (mode === "report-only") expect(seen.has(CSP_HEADER.toLowerCase())).toBe(false);
      if (mode === "off") {
        expect(seen.has(CSP_HEADER.toLowerCase())).toBe(false);
        expect(seen.has(CSP_REPORT_ONLY_HEADER.toLowerCase())).toBe(false);
      }
    }
  });

  it("the phone frame is drawn only from the middleware's own decision", async () => {
    const seen = await send("/pricing");
    expect(seen.has(FRAME_SRC_HEADER)).toBe(false);
  });

  it("keeps Caddy's client-ip header: stripping it would put the geo block and rate limits on 'unknown'", async () => {
    expect(MIDDLEWARE_OWNED_REQUEST_HEADERS).not.toContain(CLIENT_IP_HEADER);
    for (const path of ["/pricing", "/api/v1/videos", "/r/abcdefghijklmnop1234", "/api/media/file/3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e/thumb"]) {
      expect((await send(path, { [CLIENT_IP_HEADER]: "203.0.113.7" })).get(CLIENT_IP_HEADER), path).toBe("203.0.113.7");
    }
  });
});
