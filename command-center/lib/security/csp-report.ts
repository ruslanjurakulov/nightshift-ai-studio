/**
 * Content-Security-Policy violation reports (BR-S-008): what the browser posts to /api/csp-report, reduced to a
 * log line that is safe to write and useful to read.
 *
 * The endpoint is public by nature: a browser sends reports with no session, and anyone can post one. So nothing
 * here is trusted:
 *   - the body is capped (CSP_REPORT_MAX_BYTES) while it is read, and at most CSP_REPORT_MAX_PER_BODY reports are
 *     taken from one body;
 *   - every field is reduced to a closed shape: a directive name, an origin, a path with token-like segments
 *     redacted, two integers. A signed URL's query string (Supabase Storage, our media links), a review link's token
 *     or a `script-sample` never reaches the log;
 *   - the line is JSON with printable ASCII only, so a field cannot start a new log line or forge another entry;
 *   - one process logs at most CSP_REPORT_LIMIT.max lines a minute, and says once per minute how many it dropped.
 */

export const CSP_REPORT_MAX_BYTES = 16_384;
export const CSP_REPORT_MAX_PER_BODY = 20;
export const CSP_REPORT_LIMIT = { max: 120, windowMs: 60_000 };

/** The content types browsers use: report-uri (CSP2/3) and the Reporting API (report-to). */
export const CSP_REPORT_TYPES = ["application/csp-report", "application/reports+json", "application/json"] as const;

export interface CspViolation {
  directive: string;
  disposition: "enforce" | "report" | "unknown";
  /** A keyword (`inline`, `eval`, …), a scheme (`data:`), or an origin. Never a path or query. */
  blocked: string;
  /** The page's path, token-like segments replaced by `:id`. Never a query. */
  page: string;
  /** The script file's origin and path (our static chunks, Paddle's CDN), or "" when the browser gave none. */
  source: string;
  line: number;
  column: number;
}

const PRINTABLE = /[^\x20-\x7e]/g;

function clip(v: string, max: number): string {
  return v.replace(PRINTABLE, "").slice(0, max);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function int(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 10_000_000 ? n : 0;
}

/** A path with anything that may be a credential replaced: long tokens, uuids, long digit runs. */
export function redactPath(pathname: string): string {
  const parts = pathname.split("/").map((seg) => {
    if (seg === "") return seg;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
    if (seg.length > 24 || /\d{6,}/.test(seg) || !/^[A-Za-z0-9._~-]+$/.test(seg)) return ":id";
    return seg;
  });
  return clip(parts.join("/") || "/", 200);
}

/** What was blocked, without anything that could carry a secret. */
export function reduceBlocked(raw: string): string {
  const v = raw.trim();
  if (v === "") return "unknown";
  // CSP3 keywords ("inline", "eval", "wasm-eval", "trusted-types-sink", …), with or without quotes.
  const kw = v.replace(/^'|'$/g, "");
  if (/^[a-z][a-z-]{0,39}$/.test(kw)) return kw;
  try {
    const u = new URL(v);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:") {
      return clip(u.origin, 120);
    }
    return clip(u.protocol, 20);
  } catch {
    return "unparsed";
  }
}

/** A script URL reduced to origin and path; empty when it is not an http(s) URL. */
function reduceSource(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return clip(u.origin + redactPath(u.pathname), 200);
  } catch {
    return "";
  }
}

/** The directive names a violation can name (CSP3 and Trusted Types). Anything else is logged as "unknown". */
const DIRECTIVES = new Set([
  "default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr",
  "img-src", "media-src", "font-src", "connect-src", "frame-src", "child-src", "worker-src", "manifest-src",
  "object-src", "base-uri", "form-action", "frame-ancestors", "fenced-frame-src", "prefetch-src",
  "require-trusted-types-for", "trusted-types",
]);

function directiveOf(raw: string): string {
  // CSP2's violated-directive is the whole directive ("connect-src 'self' …"): its name is the first word.
  const v = raw.trim().split(/\s+/)[0] ?? "";
  return DIRECTIVES.has(v) ? v : "unknown";
}

/**
 * One raw report body (either wire format), reduced. `ourOrigin` is the site's public origin: a report whose page
 * is on another origin is not ours to log and is dropped.
 */
export function parseCspReports(body: unknown, ourOrigin: string): CspViolation[] {
  const raw: Record<string, unknown>[] = [];
  if (Array.isArray(body)) {
    // Reporting API: [{ type: "csp-violation", url, body: { documentURL, blockedURL, effectiveDirective, ... } }]
    for (const r of body.slice(0, CSP_REPORT_MAX_PER_BODY)) {
      if (r && typeof r === "object" && (r as { type?: unknown }).type === "csp-violation") {
        const b = (r as { body?: unknown }).body;
        if (b && typeof b === "object") raw.push(b as Record<string, unknown>);
      }
    }
  } else if (body && typeof body === "object") {
    // report-uri: { "csp-report": { "document-uri", "blocked-uri", "effective-directive", ... } }
    const r = (body as Record<string, unknown>)["csp-report"];
    if (r && typeof r === "object" && !Array.isArray(r)) raw.push(r as Record<string, unknown>);
  }
  const out: CspViolation[] = [];
  for (const r of raw) {
    const doc = str(r.documentURL ?? r["document-uri"]);
    let page: string;
    try {
      const u = new URL(doc);
      if (u.origin !== ourOrigin) continue;
      page = redactPath(u.pathname);
    } catch {
      continue;
    }
    const disposition = str(r.disposition);
    out.push({
      directive: directiveOf(str(r.effectiveDirective ?? r["effective-directive"] ?? r["violated-directive"])),
      disposition: disposition === "enforce" || disposition === "report" ? disposition : "unknown",
      blocked: reduceBlocked(str(r.blockedURL ?? r["blocked-uri"])),
      page,
      source: reduceSource(str(r.sourceFile ?? r["source-file"])),
      line: int(r.lineNumber ?? r["line-number"]),
      column: int(r.columnNumber ?? r["column-number"]),
    });
  }
  return out;
}

/** The log line for one violation: JSON, printable ASCII, one line. */
export function cspLogLine(v: CspViolation): string {
  return JSON.stringify({ event: "csp_violation", ...v }).replace(PRINTABLE, "");
}

let windowStart = 0;
let windowCount = 0;
let dropped = 0;

/**
 * Whether one more line may be logged now. When a new minute starts after lines were dropped, `droppedBefore` says
 * how many, so the caller can log that once.
 */
export function takeCspReport(now = Date.now()): { ok: boolean; droppedBefore: number } {
  const start = Math.floor(now / CSP_REPORT_LIMIT.windowMs) * CSP_REPORT_LIMIT.windowMs;
  let droppedBefore = 0;
  if (start !== windowStart) {
    windowStart = start;
    windowCount = 0;
    droppedBefore = dropped;
    dropped = 0;
  }
  windowCount += 1;
  if (windowCount > CSP_REPORT_LIMIT.max) {
    dropped += 1;
    return { ok: false, droppedBefore };
  }
  return { ok: true, droppedBefore };
}

/** For tests. */
export function resetCspReportLimit() {
  windowStart = 0;
  windowCount = 0;
  dropped = 0;
}
