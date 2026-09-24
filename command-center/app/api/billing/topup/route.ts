import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { logAudit } from "@/lib/server/audit";
import { BILLED_PROVIDER_IDS } from "@/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record a top-up the operator just paid on a provider's own checkout.
 *
 * The payment itself happens on the provider's site (Visa / Mastercard, entered
 * and kept there) — providers expose no API to fund an account from outside.
 * This only logs the amount so the Billing page can track the balance of
 * providers that have no balance API. It accepts an amount and a provider id;
 * it never accepts card details. Admin only; RLS enforces the same (0012).
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireRole("admin"))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { provider?: unknown; amount_usd?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  if (!BILLED_PROVIDER_IDS.includes(provider)) {
    return NextResponse.json({ error: "unknown_provider" }, { status: 400 });
  }
  const amount = typeof body.amount_usd === "number" ? body.amount_usd : Number(body.amount_usd);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) {
    return NextResponse.json({ error: "bad_amount" }, { status: 400 });
  }
  const rounded = Math.round(amount * 100) / 100;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : null;

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { error } = await supabase
    .from("provider_topups")
    .insert({ provider, amount_usd: rounded, created_by: user.id, note: note || null });
  if (error) {
    const missing = error.code === "42P01";
    return NextResponse.json({ error: missing ? "migration_missing" : "save_failed" }, { status: missing ? 503 : 500 });
  }
  await logAudit({ action: "billing.topup", target: provider, detail: { amount_usd: rounded } });
  return NextResponse.json({ ok: true });
}
