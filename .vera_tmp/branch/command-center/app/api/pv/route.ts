import { isSameOriginPost } from "@/lib/auth-confirm";
import { publicOrigin } from "@/lib/server/public-origin";
import { recordPageView } from "@/lib/server/page-views";
import { isBotUserAgent, optedOut, parseBeacon, takePageView } from "@/lib/page-views";
import { SITEMAP_PATHS } from "@/lib/public-paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/pv  { path, ref, device, lang }  →  204, always.
 *
 * The public site's page count (lib/page-views.ts, migration 0104). The answer
 * never varies, so it says nothing about whether anything was counted. Counted
 * only when ALL hold: our own page asked (same origin); the browser did not send
 * Do-Not-Track or Global Privacy Control; the user agent is not on the closed
 * bot list; this process is under its ceiling; the body is small and exactly the four
 * expected strings; the path is one of the public marketing pages (nothing else is sent on to the database); and, in the database, the path is one of the public
 * marketing pages. No cookie is read or set, no address is read, and neither
 * the user agent nor anything else about the request is stored or logged.
 */
/** The most body the route will read: the four fields are well under 300 bytes. Enforced while reading, so a missing or false Content-Length buys nothing. */
const MAX_BODY_BYTES = 2048;

async function readSmallBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const DONE = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
const done = () => DONE.clone();

export async function POST(request: Request) {
  const ours = [publicOrigin(request), new URL(request.url).origin];
  if (!isSameOriginPost(request.headers, ours)) return done();
  if (optedOut(request.headers)) return done();
  if (isBotUserAgent(request.headers.get("user-agent"))) return done();
  if (!takePageView()) return done();
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return done();
  let body: unknown;
  try {
    const text = await readSmallBody(request);
    if (text === null) return done();
    body = JSON.parse(text);
  } catch {
    return done();
  }
  const beacon = parseBeacon(body);
  // Only the public marketing pages leave this process: the same closed list the database holds (tests/page-views.test.ts keeps
  // them equal). A 404 on any other URL (the public frame wraps the 404 page too) must not travel to Supabase as an RPC argument.
  if (beacon && (SITEMAP_PATHS as readonly string[]).includes(beacon.path)) await recordPageView(beacon);
  return done();
}
