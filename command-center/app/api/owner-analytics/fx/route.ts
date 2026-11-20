import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { createClient, getUser } from "@/lib/supabase/server";
import { ownerAccess } from "@/lib/server/owner-analytics";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE });

/**
 * Freeze (or remove) one exchange rate for the income register (migration 0184). The owner types it from the source their
 * accountant uses; nothing here fetches a rate. The database checks the owner, the second factor and the rate limit again.
 */
function realDay(day: string): boolean {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

export const POST = requireSameOrigin(async (request: Request) => {
  if (!(await getUser())) return json({ error: "unauthorized" }, 401);
  if ((await ownerAccess()) !== "owner") return json({ error: "forbidden" }, 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const b = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  // A real calendar day: "2026-02-30" matches the pattern but is no date, and must be a 400 here, not a database error.
  const day =
    typeof b.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.day) && realDay(b.day)
      ? b.day
      : null;
  const currency = typeof b.currency === "string" && /^[A-Z]{3}$/.test(b.currency) && b.currency !== "UZS" ? b.currency : null;
  if (!day || !currency) return json({ error: "invalid_request" }, 400);
  const supabase = await createClient();
  if (!supabase) return json({ error: "unavailable" }, 503);
  let error;
  if (b.action === "delete") {
    ({ error } = await supabase.rpc("owner_analytics_fx_delete", { p_date: day, p_currency: currency }));
  } else {
    const uzs = typeof b.uzs === "number" && Number.isFinite(b.uzs) && b.uzs > 0 && b.uzs < 1e9 ? b.uzs : null;
    const source = typeof b.source === "string" ? b.source.trim().slice(0, 120) : "";
    if (uzs === null || !source) return json({ error: "invalid_request" }, 400);
    ({ error } = await supabase.rpc("owner_analytics_fx_set", { p_date: day, p_currency: currency, p_uzs: uzs, p_source: source }));
  }
  if (error) {
    if (error.code === "NS401") return json({ error: "mfa_required" }, 401);
    if (error.code === "54000") return json({ error: "rate_limited" }, 429);
    if (error.code === "42501") return json({ error: "forbidden" }, 403);
    if (error.code === "22023" || error.code === "22008" || error.code === "23514") return json({ error: "invalid_request" }, 400);
    return json({ error: "not_saved" }, 503);
  }
  return json({ ok: true }, 200);
});
