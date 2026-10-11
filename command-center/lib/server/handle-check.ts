import "server-only";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/config";
import { checkHandleFormat, isReservedHandle, normalizeHandleInput } from "@/lib/handles";

/**
 * The sign-up form's "is this @username free?" for a visitor with no account.
 *
 * Two limits, because the anon key is public and a route is only the page's
 * own path to the database:
 *   - here, per address: HANDLE_CHECK_LIMIT asks a minute from one address
 *     (one in-process window — a serverless instance forgets it, so this is
 *     fairness for the page's own traffic, not the defence);
 *   - in the database, platform-wide: handle_available_public() (migration 0096)
 *     counts every ask in one shared window and answers NULL past 300 a minute,
 *     whoever calls it and however. That one holds when this route is skipped.
 *
 * The answer is true, false or null and nothing else: not who holds a handle,
 * not whether a refusal is "taken" or "reserved". A handle says nothing about
 * an e-mail address, so this is not a way to find out who has an account.
 */

export const HANDLE_CHECK_LIMIT = { max: 30, windowMs: 60_000 };
/** The most addresses remembered at once; past it the oldest is forgotten (a Map keeps insertion order). */
export const HANDLE_CHECK_MAX_KEYS = 5000;

const hits = new Map<string, { start: number; count: number }>();

export function takeHandleCheck(key: string, now = Date.now()): boolean {
  const start = Math.floor(now / HANDLE_CHECK_LIMIT.windowMs) * HANDLE_CHECK_LIMIT.windowMs;
  const cur = hits.get(key);
  const next = cur && cur.start === start ? { start, count: cur.count + 1 } : { start, count: 1 };
  // delete + set moves the key to the end, so the first key is always the least recently seen
  hits.delete(key);
  hits.set(key, next);
  // A hard cap: many addresses inside one window must not grow this without bound.
  while (hits.size > HANDLE_CHECK_MAX_KEYS) {
    const oldest = hits.keys().next().value;
    if (oldest === undefined) break;
    hits.delete(oldest);
  }
  return next.count <= HANDLE_CHECK_LIMIT.max;
}

/** How many addresses are remembered (tests). */
export function handleCheckSize(): number {
  return hits.size;
}

/**
 * The address a request came from, for this limit only (never stored, never
 * logged): Vercel's own header first (set by the platform, not by the
 * visitor), then Cloudflare's, then the first forwarded address.
 */
export function handleCheckKey(headers: Headers): string {
  const pick = (name: string) => headers.get(name)?.split(",")[0]?.trim();
  return (pick("x-vercel-forwarded-for") || pick("cf-connecting-ip") || pick("x-forwarded-for") || "unknown").slice(0, 64);
}

/** For tests. */
export function resetHandleChecks() {
  hits.clear();
}

/**
 * true / false / null (cannot say now). A malformed or reserved handle is
 * answered false here, without a database round trip; anything that goes wrong
 * is null — "unknown", never "free" and never "taken".
 */
export async function isHandleAvailablePublic(raw: string): Promise<boolean | null> {
  const handle = normalizeHandleInput(raw);
  if (checkHandleFormat(handle) !== null || isReservedHandle(handle)) return false;
  if (!isSupabaseConfigured) return null;
  try {
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.rpc("handle_available_public", { p_handle: handle });
    if (error) return null;
    return typeof data === "boolean" ? data : null;
  } catch {
    return null;
  }
}
