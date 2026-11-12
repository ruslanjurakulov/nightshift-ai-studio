import { publicOrigin } from "@/lib/server/public-origin";
import { readBytesCapped } from "@/lib/server/json-body";
import {
  CSP_REPORT_MAX_BYTES,
  CSP_REPORT_TYPES,
  cspLogLine,
  parseCspReports,
  takeCspReport,
} from "@/lib/security/csp-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/csp-report  →  204, always.
 *
 * Where an enforcing Content-Security-Policy reports a violation (lib/security/csp.ts, CSP_MODE=enforce or both,
 * when CSP_REPORT_URI names no outside collector). Each violation becomes one line in the web container's log,
 * `{"event":"csp_violation",...}`, reduced and capped by lib/security/csp-report.ts. Nothing is stored, no cookie or
 * session is read, and the answer never varies, so it tells a caller nothing.
 */
const DONE = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
const done = () => DONE.clone();

export async function POST(request: Request) {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!(CSP_REPORT_TYPES as readonly string[]).includes(type)) return done();
  const bytes = await readBytesCapped(request, CSP_REPORT_MAX_BYTES);
  if (!bytes) return done();
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return done();
  }
  for (const v of parseCspReports(body, publicOrigin(request))) {
    const take = takeCspReport();
    if (take.droppedBefore > 0) console.warn(JSON.stringify({ event: "csp_violation_dropped", count: take.droppedBefore }));
    if (!take.ok) break;
    console.warn(cspLogLine(v));
  }
  return done();
}
