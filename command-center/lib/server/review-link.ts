import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { isReviewToken } from "@/lib/review-link";

/**
 * The server half of the private review link (migration 0101).
 *
 * A visitor holds only the token. Everything here runs with the ANON key and no
 * session; the service key is never used (CLAUDE.md #3). The database decides:
 *   - review_link_view / review_link_object answer for a live token only,
 *   - and the previews bucket answers an anon read only for the one object a
 *     live link names, when the request carries the token in x-review-token
 *     (storage policy previews_review_link_read).
 * So this module cannot reach any file the token does not name, even by a bug.
 */

let anon: SupabaseClient | null = null;
function anonClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  anon ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return anon;
}

export type ReviewView =
  | { status: "ok"; title: string | null; expiresAt: string; locale: string | null }
  | { status: "gone" }
  | { status: "limited" }
  | { status: "unavailable" };

/**
 * The page's question. A malformed token never reaches the database. A backend
 * that did not answer is "unavailable", never "gone": a visitor with a good link
 * is told to retry, not that the link is dead.
 */
export async function viewReviewLink(token: string): Promise<ReviewView> {
  if (!isReviewToken(token)) return { status: "gone" };
  const client = anonClient();
  if (!client) return { status: "unavailable" };
  try {
    const { data, error } = await client.rpc("review_link_view", { p_token: token });
    if (error || !data || typeof data !== "object") return { status: "unavailable" };
    const d = data as { status?: unknown; title?: unknown; expires_at?: unknown; locale?: unknown };
    if (d.status === "gone") return { status: "gone" };
    if (d.status === "limited") return { status: "limited" };
    if (d.status === "ok" && typeof d.expires_at === "string") {
      return {
        status: "ok",
        title: typeof d.title === "string" && d.title ? d.title : null,
        expiresAt: d.expires_at,
        locale: typeof d.locale === "string" ? d.locale : null,
      };
    }
    return { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/** The object path of this link's review copy, null for every kind of "no". Never sent to a browser. */
async function reviewObjectPath(token: string): Promise<{ path: string | null; failed: boolean }> {
  const client = anonClient();
  if (!client) return { path: null, failed: true };
  try {
    const { data, error } = await client.rpc("review_link_object", { p_token: token });
    if (error) return { path: null, failed: true };
    return { path: typeof data === "string" && data ? data : null, failed: false };
  } catch {
    return { path: null, failed: true };
  }
}

/** A Range header we pass on: one `bytes=a-b` range, nothing else (no multi-range). */
export function safeRange(raw: string | null): string | null {
  if (!raw) return null;
  return /^bytes=\d{0,12}-\d{0,12}$/.test(raw) && raw !== "bytes=-" ? raw : null;
}

/**
 * Fetch the review copy for a token from Storage, as anon, with the token in
 * the header the storage policy reads. Streams the body; never buffers a file.
 * `gone` and `unavailable` are the only two failures a caller can tell apart.
 */
export async function fetchReviewPreview(
  token: string,
  range: string | null,
  signal: AbortSignal,
  head: boolean,
): Promise<{ kind: "ok"; response: Response } | { kind: "gone" } | { kind: "unavailable" }> {
  if (!isReviewToken(token)) return { kind: "gone" };
  const { path, failed } = await reviewObjectPath(token);
  if (failed) return { kind: "unavailable" };
  if (!path) return { kind: "gone" };
  // The path comes from the database, but a dot segment or an empty one would let a URL climb or double a slash: refuse it.
  const segments = path.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) return { kind: "gone" };
  const url = `${SUPABASE_URL}/storage/v1/object/authenticated/previews/${segments.map(encodeURIComponent).join("/")}`;
  try {
    const res = await fetch(url, {
      // Always GET: the storage policy serves only the authenticated read (not a HEAD's "info" operation). A HEAD is
      // answered by dropping the body below.
      method: "GET",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "x-review-token": token,
        ...(range ? { range } : {}),
      },
      signal,
      cache: "no-store",
    });
    // A storage refusal (the policy said no, the file was pruned) is the same "gone" as a dead link.
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) return { kind: "gone" };
    if (head) void res.body?.cancel().catch(() => undefined);
    if (res.status === 416) return { kind: "ok", response: res };
    if (res.status !== 200 && res.status !== 206) return { kind: "unavailable" };
    return { kind: "ok", response: res };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * A per-instance limiter for the anonymous routes, keyed by caller address (best effort: behind a proxy the first
 * X-Forwarded-For hop). The database counts page views per link (30 views a minute); this is the cheap guard in
 * front of it and the only one for the stream, which a video player calls many times (every seek is a range request).
 */
const hits = new Map<string, { start: number; count: number }>();
export function takeAnonRate(key: string, max: number, windowMs = 60_000, now = Date.now()): boolean {
  const start = Math.floor(now / windowMs) * windowMs;
  const cur = hits.get(key);
  const next = cur && cur.start === start ? { start, count: cur.count + 1 } : { start, count: 1 };
  hits.set(key, next);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.start < start) hits.delete(k);
  }
  return next.count <= max;
}

export function callerKey(headers: Headers): string {
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = (xff || headers.get("x-real-ip") || "unknown").slice(0, 64);
  return ip;
}

/** Tests only. */
export function resetAnonRate(): void {
  hits.clear();
}
