import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { createClient, getUser } from "@/lib/supabase/server";
import { ownerAccess } from "@/lib/server/owner-analytics";
import { COST_CATEGORIES } from "@/lib/owner-analytics/costs";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE });
const MONTH = /^\d{4}-\d{2}-01$/;

/**
 * Add or delete one of the owner's monthly cost entries (migration 0184). The amount is stored in the database only, read back
 * at runtime by the owner; nothing here logs it. The database checks the owner and the second factor again.
 */
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
  const supabase = await createClient();
  if (!supabase) return json({ error: "unavailable" }, 503);
  let res;
  if (b.action === "delete") {
    if (typeof b.id !== "number" || !Number.isSafeInteger(b.id) || b.id <= 0) return json({ error: "invalid_request" }, 400);
    res = await supabase.rpc("owner_analytics_cost_delete", { p_id: b.id });
  } else if (b.action === "add") {
    const amount = typeof b.amount === "number" ? b.amount : NaN;
    const note = typeof b.note === "string" ? b.note.trim().slice(0, 300) : "";
    if (typeof b.month !== "string" || !MONTH.test(b.month) || !(COST_CATEGORIES as readonly unknown[]).includes(b.category)
        || !Number.isFinite(amount) || amount < 0 || amount >= 1e10) {
      return json({ error: "invalid_request" }, 400);
    }
    res = await supabase.rpc("owner_analytics_cost_add", { p_month: b.month, p_category: b.category, p_amount: amount, p_note: note || null });
  } else {
    return json({ error: "invalid_request" }, 400);
  }
  if (res.error) {
    if (res.error.code === "NS401") return json({ error: "mfa_required" }, 401);
    if (res.error.code === "54000") return json({ error: "rate_limited" }, 429);
    if (res.error.code === "42501") return json({ error: "forbidden" }, 403);
    if (res.error.code === "22023") return json({ error: "invalid_request" }, 400);
    return json({ error: "not_saved" }, 503);
  }
  return json({ ok: true }, 200);
});
