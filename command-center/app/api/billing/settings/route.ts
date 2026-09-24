import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { logAudit } from "@/lib/server/audit";
import { BILLED_PROVIDER_IDS } from "@/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Save one provider's billing settings: its price per unit (so spend can be
 * shown in USD), whether it joins the bulk top-up, and the operator's two flags
 * about the provider's own account (card saved there / auto-recharge on there).
 * Admin only; RLS enforces the same (migration 0012). No card data is accepted.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireRole("admin"))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  if (!BILLED_PROVIDER_IDS.includes(provider)) {
    return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
  }

  const row: Record<string, unknown> = { provider, updated_at: new Date().toISOString(), updated_by: user.id };
  if ("usd_per_unit" in body) {
    const raw = body.usd_per_unit;
    if (raw === null || raw === "") row.usd_per_unit = null;
    else {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100000) {
        return NextResponse.json({ error: "bad_price" }, { status: 400 });
      }
      row.usd_per_unit = n;
    }
  }
  for (const flag of ["include_in_bulk", "card_saved_on_provider", "auto_recharge_on_provider"] as const) {
    if (flag in body) {
      if (typeof body[flag] !== "boolean") return NextResponse.json({ error: "bad_flag" }, { status: 400 });
      row[flag] = body[flag];
    }
  }
  if ("low_balance_days" in body) {
    const d = Number(body.low_balance_days);
    if (!Number.isInteger(d) || d < 0 || d > 365) return NextResponse.json({ error: "bad_days" }, { status: 400 });
    row.low_balance_days = d;
  }

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { error } = await supabase.from("provider_billing_settings").upsert(row, { onConflict: "provider" });
  if (error) {
    const missing = error.code === "42P01";
    return NextResponse.json({ error: missing ? "migration_missing" : "save_failed" }, { status: missing ? 503 : 500 });
  }
  const detail = Object.fromEntries(
    Object.entries(row).filter(([k]) => !["provider", "updated_at", "updated_by"].includes(k)),
  );
  await logAudit({ action: "billing.settings", target: provider, detail });
  return NextResponse.json({ ok: true });
}
