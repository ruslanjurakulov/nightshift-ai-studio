import { isSameOriginPost } from "@/lib/auth-confirm";
import { publicOrigin } from "@/lib/server/public-origin";
import { recordPageView } from "@/lib/server/page-views";
import { isBotUserAgent, optedOut, parseBeacon, takePageView } from "@/lib/page-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/pv  { path, ref, device, lang }  →  204, always.
 *
 * The public site's page count (lib/page-views.ts, migration 0101). The answer
 * never varies, so it says nothing about whether anything was counted. Counted
 * only when ALL hold: our own page asked (same origin); the browser did not send
 * Do-Not-Track or Global Privacy Control; the user agent is not on the closed
 * bot list; this process is under its ceiling; the body is exactly the four
 * expected strings; and, in the database, the path is one of the public
 * marketing pages. No cookie is read or set, no address is read, and neither
 * the user agent nor anything else about the request is stored or logged.
 */
const DONE = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
const done = () => DONE.clone();

export async function POST(request: Request) {
  const ours = [publicOrigin(request), new URL(request.url).origin];
  if (!isSameOriginPost(request.headers, ours)) return done();
  if (optedOut(request.headers)) return done();
  if (isBotUserAgent(request.headers.get("user-agent"))) return done();
  if (!takePageView()) return done();
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 1024) return done();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return done();
  }
  const beacon = parseBeacon(body);
  if (beacon) await recordPageView(beacon);
  return done();
}
