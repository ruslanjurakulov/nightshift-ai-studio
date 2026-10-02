import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import {
  NO_FLASH_SCRIPT_HASH,
  buildCsp,
  cspHeaderName,
  cspMode,
  makeNonce,
  reportUri,
  supabaseOrigins,
} from "@/lib/security/csp";
import { NO_FLASH_SCRIPT } from "@/lib/theme";

// BR-S-008: a real content policy on every page, report-only until the owner
// switches it to enforce. These pin the policy string, the mode switch, and
// what the middleware does with it (header on the response, nonce on the
// request where Next reads it, nothing on the signed media route).

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

const NONCE = "AAAAAAAAAAAAAAAAAAAAAA==";
const EXPECTED =
  "default-src 'self'; " +
  `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic' ${NO_FLASH_SCRIPT_HASH} https://cdn.paddle.com https://public.profitwell.com; ` +
  "style-src 'self' 'unsafe-inline' https://cdn.paddle.com https://sandbox-cdn.paddle.com; " +
  "img-src 'self' data: blob: https:; " +
  "media-src 'self' data: blob: https:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' https://project.supabase.test wss://project.supabase.test https://api.paddle.com https://sandbox-api.paddle.com " +
  "https://www2.profitwell.com https://retain-api.profitwell.com https://api.profitwell-events.com " +
  "https://retain-widgets-api.paddle.com https://sandbox-retain-widgets-api.paddle.com; " +
  "frame-src https://buy.paddle.com https://sandbox-buy.paddle.com https://retain-widgets.paddle.com https://sandbox-retain-widgets.paddle.com; " +
  "worker-src 'self' blob:; " +
  "manifest-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "frame-ancestors 'none'";

function directive(policy: string, name: string): string[] {
  const d = policy.split("; ").find((p) => p.startsWith(name + " "));
  return d ? d.split(" ").slice(1) : [];
}

describe("the policy string (BR-S-008)", () => {
  const policy = buildCsp({ nonce: NONCE, supabaseUrl: "https://project.supabase.test" });

  it("is exactly this; a change here is a security review", () => {
    expect(policy).toBe(EXPECTED);
  });

  it("allows no inline script, eval or plugin in production", () => {
    expect(directive(policy, "script-src")).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(directive(policy, "object-src")).toEqual(["'none'"]);
    expect(directive(policy, "script-src")).not.toContain("https:");
    expect(directive(policy, "script-src")).not.toContain("*");
  });

  it("lets data leave only for our API, Supabase and Paddle", () => {
    const connect = directive(policy, "connect-src");
    expect(connect).not.toContain("https:");
    expect(connect.some((s) => s.includes("*"))).toBe(false);
    expect(connect).toContain("wss://project.supabase.test");
  });

  it("frames only Paddle, and is framed by nobody", () => {
    expect(directive(policy, "frame-src").every((h) => /^https:\/\/[a-z-]+\.paddle\.com$/.test(h))).toBe(true);
    expect(directive(policy, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(policy, "form-action")).toEqual(["'self'"]);
    expect(directive(policy, "base-uri")).toEqual(["'self'"]);
  });

  it("hashes the theme script exactly as lib/theme.ts writes it", () => {
    const h = createHash("sha256").update(NO_FLASH_SCRIPT, "utf8").digest("base64");
    expect(NO_FLASH_SCRIPT_HASH).toBe(`'sha256-${h}'`);
  });

  it("adds eval only for next dev", () => {
    const dev = buildCsp({ nonce: NONCE, supabaseUrl: "https://project.supabase.test", dev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
  });

  it("names a report collector only when one is configured", () => {
    expect(policy).not.toContain("report-uri");
    const r = buildCsp({ nonce: NONCE, supabaseUrl: "", reportUri: "https://csp.example.com/r" });
    expect(r).toContain("; report-uri https://csp.example.com/r; report-to csp");
  });

  it("drops a missing or odd Supabase URL instead of writing it into the header", () => {
    expect(supabaseOrigins("")).toEqual([]);
    expect(supabaseOrigins("javascript:alert(1)")).toEqual([]);
    expect(supabaseOrigins("http://127.0.0.1:54321/")).toEqual(["http://127.0.0.1:54321", "ws://127.0.0.1:54321"]);
    expect(directive(buildCsp({ nonce: NONCE, supabaseUrl: "" }), "connect-src")[0]).toBe("'self'");
  });
});

describe("the switches", () => {
  it("defaults to report-only, and a typo never turns the policy off", () => {
    expect(cspMode(undefined)).toBe("report-only");
    expect(cspMode("")).toBe("report-only");
    expect(cspMode("enforced")).toBe("report-only");
    expect(cspMode("0")).toBe("report-only");
    expect(cspMode(" Enforce ")).toBe("enforce");
    expect(cspMode("off")).toBe("off");
  });

  it("maps each mode to its header", () => {
    expect(cspHeaderName("report-only")).toBe("Content-Security-Policy-Report-Only");
    expect(cspHeaderName("enforce")).toBe("Content-Security-Policy");
    expect(cspHeaderName("off")).toBeNull();
  });

  it("accepts only an absolute https collector with nothing that could split the policy", () => {
    expect(reportUri(undefined)).toBeNull();
    expect(reportUri("http://csp.example.com/r")).toBeNull();
    expect(reportUri("/api/csp")).toBeNull();
    expect(reportUri("https://csp.example.com/r; script-src *")).toBeNull();
    expect(reportUri("https://csp.example.com/r,x")).toBeNull();
    expect(reportUri("https://csp.example.com/r")).toBe("https://csp.example.com/r");
  });

  it("mints a fresh 128-bit nonce every time", () => {
    const a = makeNonce();
    const b = makeNonce();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, "base64")).toHaveLength(16);
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe("the middleware", () => {
  const env = { ...process.env };
  beforeEach(() => {
    auth.user = null;
    delete process.env.CSP_MODE;
    delete process.env.CSP_REPORT_URI;
  });
  afterEach(() => {
    process.env = { ...env };
  });

  const run = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
    middleware(new NextRequest(new URL(path, "https://app.test"), init));

  function nonceOf(policy: string | null): string | null {
    return policy?.match(/'nonce-([^']+)'/)?.[1] ?? null;
  }

  it.each(["/", "/login", "/pricing", "/signup"])("reports (does not enforce) on the public page %s", async (path) => {
    const res = await run(path);
    const policy = res.headers.get("content-security-policy-report-only");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(nonceOf(policy)).toBeTruthy();
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("hands the same nonce to the page render, where Next reads it", async () => {
    const res = await run("/pricing");
    const sent = res.headers.get("content-security-policy-report-only");
    // NextResponse.next({ request }) forwards request headers this way.
    const forwarded = res.headers.get("x-middleware-request-content-security-policy-report-only");
    expect(forwarded).toBe(sent);
    expect(res.headers.get("x-middleware-override-headers")).toContain("content-security-policy-report-only");
  });

  it("forwards the nonce on a signed-in channel page too", async () => {
    auth.user = { id: "u1" };
    const res = await run("/chronos/videos");
    const sent = res.headers.get("content-security-policy-report-only");
    expect(nonceOf(sent)).toBeTruthy();
    expect(res.headers.get("x-middleware-request-content-security-policy-report-only")).toBe(sent);
    // The channel header the layout needs is still forwarded alongside it.
    expect(res.headers.get("x-middleware-override-headers")).toContain("content-security-policy-report-only");
  });

  it("uses a different nonce for every response", async () => {
    const a = nonceOf((await run("/")).headers.get("content-security-policy-report-only"));
    const b = nonceOf((await run("/")).headers.get("content-security-policy-report-only"));
    expect(a).not.toBe(b);
  });

  it("still sends the policy on the redirect to /login", async () => {
    const res = await run("/chronos/videos");
    expect(res.status).toBe(307);
    expect(res.headers.get("content-security-policy-report-only")).toContain("default-src 'self'");
  });

  it("enforces when CSP_MODE=enforce", async () => {
    process.env.CSP_MODE = "enforce";
    const res = await run("/");
    expect(res.headers.get("content-security-policy")).toContain("'strict-dynamic'");
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(res.headers.get("content-security-policy"));
  });

  it("sends nothing when CSP_MODE=off", async () => {
    process.env.CSP_MODE = "off";
    const res = await run("/");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
  });

  it("names the collector in Reporting-Endpoints when CSP_REPORT_URI is set", async () => {
    process.env.CSP_REPORT_URI = "https://csp.example.com/r";
    const res = await run("/");
    expect(res.headers.get("reporting-endpoints")).toBe('csp="https://csp.example.com/r"');
    expect(res.headers.get("content-security-policy-report-only")).toContain("report-uri https://csp.example.com/r");
  });

  it("leaves the signed media route's own stricter policy alone", async () => {
    for (const mode of ["report-only", "enforce"]) {
      process.env.CSP_MODE = mode;
      const res = await run("/api/media/file/3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e/thumb?exp=1&sig=x");
      expect(res.headers.get("content-security-policy")).toBeNull();
      expect(res.headers.get("content-security-policy-report-only")).toBeNull();
    }
  });
});
