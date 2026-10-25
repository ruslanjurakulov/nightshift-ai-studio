import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { guardAdminPost } from "@/lib/server/admin-post-guard";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped, SMALL_BODY_BYTES } from "@/lib/server/json-body";
import { rateLimitRefusal } from "@/lib/server/secret-write";
import { requireRecentMfa } from "@/lib/security/admin-mfa-server";
import { parseModelKeyRequest } from "@/lib/model-keys";
import { MODEL_KEY_RATE, logModelKey, modelKeysOn, safeErrorText, verifyKeyWithVendor } from "@/lib/server/model-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The owner pastes a vendor API key; the server checks it with the vendor and FORGETS it (docs/MODEL_API_KEYS.md).
 *
 *   POST { action: "verify", provider, key }  ->  { ok: true, state: "verified" | "rejected" | "could_not_reach" | "format_only", at, reason? }
 *
 * NOTHING IS STORED. This route writes no database, no Vault, no audit row, no cookie and no file, and reads no data about any key: the only
 * request it makes is the vendor's own free GET (the sign-in and owner-role checks are the existing ones). The key lives in this function's memory for the length of the call. It is never returned (the answer
 * is a state word and a time), never logged (one line: who, which vendor, the verdict), never in a URL, a header of the answer or an error.
 *
 * Behind NIGHTSHIFT_MODEL_KEYS (a same-origin POST gets 404 while it is not exactly `on`). The checks, in order, as the other operator POSTs:
 * our own page sent it (403, the requireSameOrigin wrapper below) -> the switch (404) -> signed in (401) -> the platform OWNER, not merely an
 * admin (403) -> the second factor (401/403) and its recent-code rule -> a per-person rate limit (429) -> Content-Type application/json (415) -> a small JSON body -> the vendor must
 * be in the closed list (400) and the key one printable token (400) -> ONE free GET to the vendor's fixed host with a short timeout (a vendor
 * with no free check is not called at all: only the key's shape was checked, and the answer says `format_only`).
 */
const NO_STORE = { "cache-control": "no-store" };
const reply = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });

async function handle(request: Request): Promise<Response> {
  if (!modelKeysOn()) return reply(404, { error: "not_found" });

  const user = await getUser();
  if (!user) return reply(401, { error: "unauthorized" });
  if (!(await requireRole("owner"))) return reply(403, { error: "forbidden" });
  const refused = await guardAdminPost(request, user);
  if (refused) return refused;
  const stale = await requireRecentMfa(user);
  if (stale) return stale;
  const limited = rateLimitRefusal(user.id, MODEL_KEY_RATE);
  if (limited) return limited;

  // Only a JSON body is read (a form post or text/plain is never parsed as one).
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) return reply(415, { ok: false, error: "unsupported_media_type" });

  let body: unknown;
  try {
    body = await parseJsonCapped(request, SMALL_BODY_BYTES);
  } catch {
    return reply(400, { ok: false, error: "bad_request" });
  }
  const parsed = parseModelKeyRequest(body);
  if (!parsed.ok) {
    // The reason is one of our words (too_short, bad_shape, ...), never the value.
    return reply(400, { ok: false, error: parsed.error, ...(parsed.reason ? { reason: parsed.reason } : {}) });
  }
  const { provider, key } = parsed.request;

  let verdict: Awaited<ReturnType<typeof verifyKeyWithVendor>>;
  try {
    verdict = await verifyKeyWithVendor(provider, key);
  } catch (err) {
    // verifyKeyWithVendor answers instead of throwing; this is the guard for a bug in it. Our words, the key taken out of any quote.
    console.error(`[model-key] provider=${provider.id} verify crashed: ${safeErrorText(err, key)}`);
    return reply(502, { ok: false, error: "verify_failed" });
  }

  const at = new Date().toISOString();
  if (verdict.outcome === "could_not_reach") {
    logModelKey(user.id, provider.id, `could_not_reach:${verdict.reason}`);
    return reply(200, { ok: true, state: "could_not_reach", reason: verdict.reason, at });
  }
  logModelKey(user.id, provider.id, verdict.outcome);
  return reply(200, { ok: true, state: verdict.outcome, at });
}

export const POST = requireSameOrigin(handle);
