import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import {
  BACKDROP_IMG_ORIGIN,
  BACKDROP_MEDIA_ORIGIN,
  CSP_REPORT_PATH,
  NO_FLASH_SCRIPT_HASH,
  buildCsp,
  cspEnforces,
  cspHeaderName,
  cspHeaders,
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

/**
 * The header the site sent before the CSP_MODE switch had more than report-only/enforce/off, frozen as a literal
 * (live on https://nightshift-ai.studio on 2026-11-12, with the project's Supabase host): the default mode must keep
 * sending exactly this, so merging the switch changes nothing until the owner sets the variable.
 */
const TODAY_REPORT_ONLY =
  "default-src 'self'; script-src 'self' 'nonce-AAAAAAAAAAAAAAAAAAAAAA==' 'strict-dynamic' 'sha256-0sat8E4VTcOjmj9b0kR7WSmpelpaTP7qCVYbsdetoNY=' " +
  "https://cdn.paddle.com https://public.profitwell.com; style-src 'self' 'unsafe-inline' https://cdn.paddle.com https://sandbox-cdn.paddle.com; " +
  "img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' " +
  "https://project.supabase.test wss://project.supabase.test https://api.paddle.com https://sandbox-api.paddle.com " +
  "https://www2.profitwell.com https://retain-api.profitwell.com https://api.profitwell-events.com https://retain-widgets-api.paddle.com " +
  "https://sandbox-retain-widgets-api.paddle.com; frame-src https://buy.paddle.com https://sandbox-buy.paddle.com " +
  "https://retain-widgets.paddle.com https://sandbox-retain-widgets.paddle.com; worker-src 'self' blob:; manifest-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/** enforce (and the enforcing half of both), served over https, no outside collector configured. */
const EXPECTED_ENFORCE = `${EXPECTED}; upgrade-insecure-requests; report-uri /api/csp-report`;

/** The stricter report-only policy `both` adds: img-src and media-src narrowed, everything else identical. */
const EXPECTED_STRICT = EXPECTED.replace(
  "img-src 'self' data: blob: https:; media-src 'self' data: blob: https:",
  "img-src 'self' data: blob: https://project.supabase.test https://cdn.paddle.com https://sandbox-cdn.paddle.com " +
    "https://d2ol7oe51mr4n9.cloudfront.net; " +
    "media-src 'self' data: blob: https://project.supabase.test https://cdn.paddle.com https://sandbox-cdn.paddle.com " +
    "https://d8j0ntlcm91z4.cloudfront.net",
) + "; report-uri /api/csp-report";

const OPTS = { nonce: NONCE, supabaseUrl: "https://project.supabase.test" };

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
    expect(cspMode("report")).toBe("report-only");
    expect(cspMode("report-only")).toBe("report-only");
    expect(cspMode("enforced")).toBe("report-only");
    expect(cspMode("bothh")).toBe("report-only");
    expect(cspMode("0")).toBe("report-only");
    expect(cspMode(" Enforce ")).toBe("enforce");
    expect(cspMode("BOTH")).toBe("both");
    expect(cspMode("off")).toBe("off");
  });

  it("maps each mode to its header", () => {
    expect(cspHeaderName("report-only")).toBe("Content-Security-Policy-Report-Only");
    expect(cspHeaderName("enforce")).toBe("Content-Security-Policy");
    expect(cspHeaderName("both")).toBe("Content-Security-Policy");
    expect(cspHeaderName("off")).toBeNull();
    expect([cspEnforces("report-only"), cspEnforces("enforce"), cspEnforces("both"), cspEnforces("off")]).toEqual([
      false,
      true,
      true,
      false,
    ]);
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

describe("the header set for each mode (cspHeaders)", () => {
  it("default mode: byte-identical to the header sent before the switch", () => {
    expect(EXPECTED).toBe(TODAY_REPORT_ONLY);
    const set = cspHeaders(cspMode(undefined), { ...OPTS, https: true });
    expect(set).toEqual({
      response: [{ name: "Content-Security-Policy-Report-Only", value: TODAY_REPORT_ONLY }],
      reportingEndpoints: null,
    });
    // `report` is the same mode, and https changes nothing in it (no upgrade-insecure-requests, no own report-uri).
    expect(cspHeaders(cspMode("report"), { ...OPTS, https: false })).toEqual(set);
  });

  it("enforce: one enforcing header, upgrade-insecure-requests on https, reports to our own endpoint", () => {
    const set = cspHeaders("enforce", { ...OPTS, https: true });
    expect(set).toEqual({ response: [{ name: "Content-Security-Policy", value: EXPECTED_ENFORCE }], reportingEndpoints: null });
    expect(CSP_REPORT_PATH).toBe("/api/csp-report");
  });

  it("enforce over plain http (a local next start) leaves upgrade-insecure-requests out", () => {
    const set = cspHeaders("enforce", { ...OPTS, https: false });
    expect(set.response).toEqual([{ name: "Content-Security-Policy", value: `${EXPECTED}; report-uri /api/csp-report` }]);
  });

  it("enforce with an outside collector: report-uri and report-to name it, Reporting-Endpoints too, no own path", () => {
    const set = cspHeaders("enforce", { ...OPTS, https: true, reportUri: "https://csp.example.com/r" });
    expect(set.response).toEqual([
      {
        name: "Content-Security-Policy",
        value: `${EXPECTED}; upgrade-insecure-requests; report-uri https://csp.example.com/r; report-to csp`,
      },
    ]);
    expect(set.reportingEndpoints).toBe('csp="https://csp.example.com/r"');
  });

  it("both: the enforcing policy, plus the stricter one as report-only, with one nonce", () => {
    const set = cspHeaders("both", { ...OPTS, https: true });
    expect(set.response).toEqual([
      { name: "Content-Security-Policy", value: EXPECTED_ENFORCE },
      { name: "Content-Security-Policy-Report-Only", value: EXPECTED_STRICT },
    ]);
    expect(set.reportingEndpoints).toBeNull();
    // Strict narrows only img-src and media-src; it never names any-https, and adds no upgrade (ignored in report-only).
    expect(directive(EXPECTED_STRICT, "img-src")).not.toContain("https:");
    expect(directive(EXPECTED_STRICT, "media-src")).not.toContain("https:");
    expect(EXPECTED_STRICT).not.toContain("upgrade-insecure-requests");
  });

  it("the strict policy names the backdrop's hosts exactly as components/NeuralBackdrop.tsx loads them", () => {
    const src = readFileSync(join(__dirname, "..", "components", "NeuralBackdrop.tsx"), "utf8");
    const poster = src.match(/const POSTER =\s*"([^"]+)"/)?.[1];
    const video = src.match(/const SRC =\s*"([^"]+)"/)?.[1];
    expect(poster && new URL(poster).origin).toBe(BACKDROP_IMG_ORIGIN);
    expect(video && new URL(video).origin).toBe(BACKDROP_MEDIA_ORIGIN);
  });

  it("off: no policy header at all", () => {
    expect(cspHeaders("off", { ...OPTS, https: true })).toEqual({ response: [], reportingEndpoints: null });
  });

  it.each(["report-only", "enforce", "both"] as const)("every policy %s sends keeps the script and plugin rules", (mode) => {
    for (const { value } of cspHeaders(mode, { ...OPTS, https: true }).response) {
      const script = directive(value, "script-src");
      expect(script).toContain(`'nonce-${NONCE}'`);
      expect(script).toContain("'strict-dynamic'");
      expect(script).not.toContain("'unsafe-inline'");
      expect(value).not.toContain("'unsafe-eval'");
      expect(script.some((s) => s === "https:" || s.includes("*"))).toBe(false);
      expect(directive(value, "object-src")).toEqual(["'none'"]);
      expect(directive(value, "base-uri")).toEqual(["'self'"]);
      expect(directive(value, "form-action")).toEqual(["'self'"]);
      expect(directive(value, "frame-ancestors")).toEqual(["'none'"]);
      expect(directive(value, "connect-src")).not.toContain("https:");
    }
  });

  it("a self-framed response keeps frame-ancestors 'self' in both policies of `both`", () => {
    for (const { value } of cspHeaders("both", { ...OPTS, https: true, framedBySelf: true }).response) {
      expect(directive(value, "frame-ancestors")).toEqual(["'self'"]);
    }
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

  it("default (CSP_MODE unset): exactly one policy header, report-only, equal to today's with this response's nonce", async () => {
    const res = await run("/pricing");
    const sent = res.headers.get("content-security-policy-report-only");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("reporting-endpoints")).toBeNull();
    expect(sent?.replace(/'nonce-[^']+'/, `'nonce-${NONCE}'`)).toBe(TODAY_REPORT_ONLY);
  });

  it("enforce over https (Caddy's X-Forwarded-Proto) adds upgrade-insecure-requests and the own report-uri", async () => {
    process.env.CSP_MODE = "enforce";
    const res = await middleware(
      new NextRequest(new URL("/pricing", "http://0.0.0.0:3000"), { headers: { "x-forwarded-proto": "https" } }),
    );
    const sent = res.headers.get("content-security-policy");
    expect(sent?.replace(/'nonce-[^']+'/, `'nonce-${NONCE}'`)).toBe(EXPECTED_ENFORCE);
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(sent);
  });

  it("enforce over plain http leaves upgrade-insecure-requests out", async () => {
    process.env.CSP_MODE = "enforce";
    const res = await middleware(new NextRequest(new URL("/pricing", "http://127.0.0.1:3000")));
    expect(res.headers.get("content-security-policy")).not.toContain("upgrade-insecure-requests");
  });

  it("both: an enforcing and a stricter report-only header with the same nonce; the render gets the enforcing one", async () => {
    process.env.CSP_MODE = "both";
    const res = await run("/pricing");
    const enforced = res.headers.get("content-security-policy");
    const reported = res.headers.get("content-security-policy-report-only");
    expect(enforced?.replace(/'nonce-[^']+'/, `'nonce-${NONCE}'`)).toBe(EXPECTED_ENFORCE);
    expect(reported?.replace(/'nonce-[^']+'/, `'nonce-${NONCE}'`)).toBe(EXPECTED_STRICT);
    expect(nonceOf(enforced)).toBe(nonceOf(reported));
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(enforced);
  });

  it("lets a CSP report through the cookie gate: no redirect to /login", async () => {
    process.env.CSP_MODE = "enforce";
    const res = await run("/api/csp-report", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
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
