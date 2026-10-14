import { fetchReviewPreview, safeRange, takeAnonRate, callerKey } from "@/lib/server/review-link";
import { isReviewToken } from "@/lib/review-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The review copy for a private review link (migration 0101), streamed from
 * the private previews bucket.
 *
 * The link's token is the whole authorization and it is checked by the
 * database, twice: review_link_object() names the file only for a live link,
 * and Storage serves it to the anon role only when the request carries that
 * token and the file is the one the link names (policy previews_review_link_read).
 * This route holds no key that could read anything else. It passes the Range
 * header through (a phone seeks with it) and sends the bytes on without storing
 * them. Every kind of "no" is the same 404; the file is never offered as a
 * download and never cached by a shared cache.
 */
const HEADERS = {
  "Content-Type": "video/mp4",
  "Accept-Ranges": "bytes",
  "Cache-Control": "private, no-store",
  "Content-Disposition": "inline",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; sandbox",
} as const;

const NO = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

async function serve(request: Request, params: Promise<{ token: string }>, head: boolean) {
  const { token } = await params;
  if (!isReviewToken(token)) return new Response("Not found", { status: 404, headers: NO });
  // A video player asks for many ranges: generous, but a loop is stopped.
  if (!takeAnonRate(`stream:${callerKey(request.headers)}`, 240)) {
    return new Response("Too many requests", { status: 429, headers: { ...NO, "Retry-After": "60" } });
  }
  const got = await fetchReviewPreview(token, safeRange(request.headers.get("range")), request.signal, head);
  if (got.kind === "gone") return new Response("Not found", { status: 404, headers: NO });
  if (got.kind === "unavailable") return new Response("Unavailable", { status: 503, headers: { ...NO, "Retry-After": "10" } });

  const up = got.response;
  const headers = new Headers(HEADERS);
  for (const name of ["content-length", "content-range"]) {
    const v = up.headers.get(name);
    if (v) headers.set(name, v);
  }
  return new Response(head || up.status === 416 ? null : up.body, { status: up.status, headers });
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return serve(request, params, false);
}

export async function HEAD(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return serve(request, params, true);
}
