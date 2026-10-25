import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { guardAdminPost } from "@/lib/server/admin-post-guard";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped, SMALL_BODY_BYTES } from "@/lib/server/json-body";
import { rateLimitRefusal } from "@/lib/server/secret-write";
import { requireRecentMfa } from "@/lib/security/admin-mfa-server";
import { parseModelKeyRequest } from "@/lib/model-keys";
import {
  MODEL_KEY_RATE,
  logModelKey,
  modelKeysOn,
  removeModelKey,
  safeErrorText,
  storeModelKey,
  verifyKeyWithVendor,
} from "@/lib/server/model-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The owner pastes a vendor API key; it is checked with the vendor and, only if the check passed, kept in Supabase Vault
 * (docs/MODEL_API_KEYS.md, migration 0123).
 *
 *   POST { action: "save", provider, key, confirm_format_only? }
 *   POST { action: "remove", provider }
 *
 * Behind NIGHTSHIFT_MODEL_KEYS (a same-origin POST gets 404 while it is not exactly `on`). The checks, in order, as the other operator POSTs:
 * our own page sent it (403, the requireSameOrigin wrapper below) -> the switch (404) -> signed in (401) -> the platform OWNER, not merely an admin (403) -> the second factor
 * (401/403) and its recent-code rule -> a per-person rate limit (429) -> a small JSON body -> the vendor must be in the closed list (400)
 * and the key one printable token (400) -> for a vendor with no free check, the owner's explicit confirmation (400) -> ONE free GET to the
 * vendor's fixed host with a short timeout -> ONLY a vendor that accepted the key is stored (the database function checks the owner again).
 *
 * The key travels once, in this body. It is never in a URL, never returned (the answer is a state word), never logged, and an error from
 * anywhere is replaced by a code before it leaves. A rejected or unreachable check stores nothing and leaves the stored key as it was.
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
  const req = parsed.request;

  const db = await createClient();
  if (!db) return reply(503, { ok: false, error: "not_configured" });

  if (req.action === "remove") {
    const out = await removeModelKey(db, req.provider);
    logModelKey(user.id, req.provider.id, out.body.ok ? "removed" : `remove_refused:${String(out.body.error)}`);
    return reply(out.status, out.body.ok ? { ok: true, state: "not_set" } : out.body);
  }

  const { provider, key } = req;
  let verdict: Awaited<ReturnType<typeof verifyKeyWithVendor>>;
  try {
    verdict = await verifyKeyWithVendor(provider, key);
  } catch (err) {
    // verifyKeyWithVendor answers instead of throwing; this is the guard for a bug in it. Our words, the key taken out of any quote.
    console.error(`[model-key] provider=${provider.id} verify crashed: ${safeErrorText(err, key)}`);
    return reply(502, { ok: false, error: "verify_failed" });
  }

  if (verdict.outcome === "rejected") {
    logModelKey(user.id, provider.id, "rejected");
    return reply(200, { ok: true, state: "rejected", stored: false });
  }
  if (verdict.outcome === "unreachable") {
    logModelKey(user.id, provider.id, `unreachable:${verdict.reason}`);
    return reply(200, { ok: true, state: "unreachable", reason: verdict.reason, stored: false });
  }

  const status = verdict.outcome === "verified" ? "verified" : "format_only";
  let stored: Awaited<ReturnType<typeof storeModelKey>>;
  try {
    stored = await storeModelKey(db, provider, key, status);
  } catch (err) {
    console.error(`[model-key] provider=${provider.id} store crashed: ${safeErrorText(err, key)}`);
    return reply(502, { ok: false, error: "store_failed" });
  }
  if (!stored.body.ok) {
    logModelKey(user.id, provider.id, `store_refused:${String(stored.body.error)}`);
    return reply(stored.status, stored.body);
  }
  logModelKey(user.id, provider.id, status);
  return reply(200, { ok: true, state: status, stored: true });
}

export const POST = requireSameOrigin(handle);
