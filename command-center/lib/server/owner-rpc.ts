import "server-only";
import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { guardAdminPost } from "@/lib/server/admin-post-guard";
import { rejectCrossOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";
import { ownerReplyToHttp, ownerRpcErrorToHttp, parseOwnerRpcFlag, type OwnerCall, type OwnerHttp } from "@/lib/owner-rpc";

/**
 * NIGHTSHIFT_OWNER_RPC — a server env var, `on` or `off` (default off).
 *
 * `off` (also empty or anything unrecognised) is today's behaviour, unchanged: the Credits, Prices, Team and
 * Billing pages talk to the tables and to grant_credits() as they always did, and a same-origin POST to the routes
 * below answers 404 (a cross-origin POST is refused 403 first, a GET is 405, and a signed-out caller is stopped by
 * the middleware's 401 before reaching them).
 * `on` moves the owner's money and roster changes behind the audited, capped, idempotent functions of migration
 * 0107, and shows the Security page's read-only self-check. It does NOT switch the database's second-factor gate
 * (enable_admin_mfa): that stays a deliberate step of its own (docs/security/ADMIN_MFA.md).
 *
 * Read on every call, never at import: a restart is enough to change it. The read below names the variable literally
 * because tests/test_deploy_self_host.py scans for exactly that, so the name is also in deploy/.env.web.example and
 * .github/workflows/deploy_web.yml.
 */
export function ownerRpcOn(): boolean {
  return parseOwnerRpcFlag(process.env.NIGHTSHIFT_OWNER_RPC);
}

const NO_STORE = { "cache-control": "no-store" };
const reply = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * The one handler behind every owner route (/api/owner/*): it makes the same checks, in the same order, as the
 * other operator POSTs (app/api/billing/settings), then makes exactly ONE call to a database function as the
 * SIGNED-IN USER (the cookie session and the anon key; never a service key), so auth.uid() in the function is the
 * owner and the function's own platform-admin check, caps, second-factor test and audit trail all apply.
 *
 *   1. our own page sent it (403 before anything else is read),
 *   2. the flag is on (404 otherwise, for a same-origin POST),
 *   3. signed in (401), owner/admin (403), the application-layer second factor (guardAdminPost),
 *   4. a small JSON body that passes `parse` (400 with a code the screen words),
 *   5. for Restore only, that the history row is still the newest change of its service (409 `price_changed`:
 *      restoring an older row would silently undo the changes after it),
 *   6. the rpc, and its answer mapped by lib/owner-rpc.ts. The database's own error text is never forwarded.
 *
 * Nothing here spends, publishes or renders: it changes credits, prices and the roster, which the database audits.
 */
export async function handleOwnerPost(
  request: Request,
  parse: (body: unknown) => { ok: true; call: OwnerCall } | { ok: false; error: string },
  /**
   * Which switch gates the route. The owner routes use NIGHTSHIFT_OWNER_RPC; the marketing route passes its own
   * (NIGHTSHIFT_MARKETING_POSTS) and gets the identical stack of checks in the identical order.
   */
  flagOn: () => boolean = ownerRpcOn,
): Promise<Response> {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  if (!flagOn()) return reply(404, { error: "not_found" });

  const user = await getUser();
  if (!user) return reply(401, { error: "unauthorized" });
  if (!(await requireRole("admin"))) return reply(403, { error: "forbidden" });
  const refused = await guardAdminPost(request, user);
  if (refused) return refused;

  let body: unknown;
  try {
    body = await parseJsonCapped(request);
  } catch {
    return reply(400, { ok: false, error: "bad_request" });
  }
  const parsed = parse(body);
  if (!parsed.ok) return reply(400, { ok: false, error: parsed.error });

  const supabase = await createClient();
  if (!supabase) return reply(503, { ok: false, error: "not_configured" });
  if (parsed.call.fn === "owner_restore_credit_price") {
    const stale = await restoreIsStale(supabase, Number(parsed.call.args.p_history_id));
    if (stale) return reply(stale.status, stale.body);
  }
  let result: { data: unknown; error: { code?: string | null; message?: string | null } | null };
  try {
    result = await supabase.rpc(parsed.call.fn, parsed.call.args);
  } catch {
    return reply(502, { ok: false, error: "rpc_failed" });
  }
  if (result.error) {
    const out = ownerRpcErrorToHttp(result.error);
    return reply(out.status, out.body);
  }
  const out = ownerReplyToHttp(result.data);
  return reply(out.status, out.body);
}

type Db = NonNullable<Awaited<ReturnType<typeof createClient>>>;

/**
 * Restore puts a service back to what it was BEFORE a history row. The screen only offers the newest change of each
 * service; if another change was made after the page was loaded, that row is no longer the newest and restoring it
 * would silently undo the newer change. Read as the signed-in user (a platform admin reads credit_price_history).
 * The read-then-call is not one transaction: two owners acting in the same instant could still cross, which the audit
 * trail records; what this closes is the ordinary case of a page left open.
 * Returns the refusal to send, or null to go on. A read that fails refuses: no guess.
 */
async function restoreIsStale(supabase: Db, historyId: number): Promise<OwnerHttp | null> {
  try {
    const row = await supabase.from("credit_price_history").select("id,unit").eq("id", historyId).maybeSingle();
    if (row.error) return ownerRpcErrorToHttp(row.error);
    // Not found: let the function say no_such_history in its own words.
    if (!row.data) return null;
    const newest = await supabase.from("credit_price_history").select("id").eq("unit", row.data.unit).order("id", { ascending: false }).limit(1);
    if (newest.error) return ownerRpcErrorToHttp(newest.error);
    const top = newest.data?.[0]?.id;
    if (typeof top !== "number") return { status: 502, body: { ok: false, error: "rpc_failed" } };
    return top === historyId ? null : { status: 409, body: { ok: false, error: "price_changed" } };
  } catch {
    return { status: 502, body: { ok: false, error: "rpc_failed" } };
  }
}
