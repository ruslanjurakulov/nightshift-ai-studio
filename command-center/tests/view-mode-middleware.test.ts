import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import nextConfig from "../next.config";
import { buildCsp } from "@/lib/security/csp";

// The Mobile / Desktop view's two header decisions (middleware.ts, lib/view-mode.ts):
// the site is framable by its own page and by nobody else, and the phone frame is drawn
// only for a top-level visit by someone who chose Mobile.

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

const FRAME_HEADER = "x-middleware-request-x-ns-frame-src";

describe("the buildCsp switches", () => {
  const nonce = "AAAAAAAAAAAAAAAAAAAAAA==";
  const dir = (p: string, name: string) => p.split("; ").find((d) => d.startsWith(name + " "));
  it("is unchanged by default: Paddle frames only, framed by nobody", () => {
    const p = buildCsp({ nonce, supabaseUrl: "" });
    expect(dir(p, "frame-src")).not.toContain("'self'");
    expect(dir(p, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });
  it("lists 'self' in frame-src for the shell only", () => {
    expect(dir(buildCsp({ nonce, supabaseUrl: "", frameSelf: true }), "frame-src")).toMatch(/^frame-src 'self' https:\/\/buy\.paddle\.com/);
  });
  it("allows 'self' as the ancestor for a frame our own page opened, and nothing wider", () => {
    const p = buildCsp({ nonce, supabaseUrl: "", framedBySelf: true });
    expect(dir(p, "frame-ancestors")).toBe("frame-ancestors 'self'");
    expect(p).not.toContain("frame-ancestors *");
  });
});

describe("the middleware", () => {
  const env = { ...process.env };
  beforeEach(() => {
    auth.user = null;
    delete process.env.CSP_MODE;
  });
  afterEach(() => {
    process.env = { ...env };
  });
  const run = (path: string, headers: Record<string, string> = {}) =>
    middleware(new NextRequest(new URL(path, "https://app.test"), { headers }));
  const IFRAME = { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" };

  it("keeps DENY for an ordinary visit (next.config.ts's headers are untouched)", async () => {
    const res = await run("/pricing", { "sec-fetch-dest": "document", "sec-fetch-site": "none" });
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((r) => r.source === "/((?!api/media/file/).*)")!;
    expect(all.headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    expect(all.headers).toContainEqual({ key: "Content-Security-Policy", value: "frame-ancestors 'none'" });
  });

  it("lets the site's own page frame it: SAMEORIGIN and frame-ancestors 'self'", async () => {
    const res = await run("/pricing", IFRAME);
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    // The default mode is report-only, whose policy cannot carry frame-ancestors: the enforced one is set beside it.
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(res.headers.get("content-security-policy-report-only")).toContain("frame-ancestors 'self'");
  });

  it("in enforce mode the full policy carries 'self' and there is no second one", async () => {
    process.env.CSP_MODE = "enforce";
    const res = await run("/pricing", IFRAME);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("with the policy off it still states frame-ancestors, so the config's 'none' does not win", async () => {
    process.env.CSP_MODE = "off";
    const res = await run("/pricing", IFRAME);
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it.each([
    ["another site", { "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" }],
    ["a sibling subdomain", { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-site" }],
    ["an <embed>", { "sec-fetch-dest": "embed", "sec-fetch-site": "same-origin" }],
    ["a client that sends no fetch metadata", {}],
  ])("keeps DENY for %s", async (_name, headers) => {
    process.env.CSP_MODE = "enforce";
    const res = await run("/pricing", headers);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it.each(["/auth/confirm", "/oauth/authorize"])("never lifts DENY on %s, even for our own frame", async (path) => {
    process.env.CSP_MODE = "enforce";
    const res = await run(path, IFRAME);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("draws the phone frame for a top-level visit by someone who chose Mobile", async () => {
    const res = await run("/pricing?x=1", { cookie: "ns_view=mobile", "sec-fetch-dest": "document" });
    expect(res.headers.get(FRAME_HEADER)).toBe("/pricing?x=1");
    // The shell itself is not framed, and it may frame the site.
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy-report-only")).toMatch(/frame-src 'self' https:\/\/buy\.paddle\.com/);
  });

  it("does not wrap the frame's own page, a Desktop visitor, or an ordinary one", async () => {
    expect((await run("/pricing", { cookie: "ns_view=mobile", ...IFRAME })).headers.get(FRAME_HEADER)).toBeNull();
    expect((await run("/pricing", { cookie: "ns_view=desktop", "sec-fetch-dest": "document" })).headers.get(FRAME_HEADER)).toBeNull();
    expect((await run("/pricing", { "sec-fetch-dest": "document" })).headers.get(FRAME_HEADER)).toBeNull();
    expect((await run("/pricing", { cookie: "ns_view=mobile" })).headers.get(FRAME_HEADER)).toBeNull();
    expect((await run("/pricing", { cookie: "ns_view=bogus", "sec-fetch-dest": "document" })).headers.get(FRAME_HEADER)).toBeNull();
  });

  it("does not frame the sign-in steps or the connection screen for a Mobile visitor", async () => {
    for (const path of ["/auth/callback", "/oauth/authorize"]) {
      const res = await run(path, { cookie: "ns_view=mobile", "sec-fetch-dest": "document" });
      expect(res.headers.get(FRAME_HEADER)).toBeNull();
    }
  });

  it("throws away a frame header the client sent itself", async () => {
    const res = await run("/pricing", { "x-ns-frame-src": "/evil", "sec-fetch-dest": "document" });
    expect(res.headers.get(FRAME_HEADER)).toBeNull();
    const forwarded = res.headers.get("x-middleware-override-headers") ?? "";
    expect(forwarded.split(",")).not.toContain("x-ns-frame-src");
  });

  it("keeps the channel on a signed-in page inside the frame request", async () => {
    auth.user = { id: "u1" };
    const res = await run("/chronos/videos", { cookie: "ns_view=mobile", "sec-fetch-dest": "document" });
    expect(res.headers.get(FRAME_HEADER)).toBe("/chronos/videos");
  });
});
