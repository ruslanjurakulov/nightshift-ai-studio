import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { logAudit } from "@/lib/server/audit";
import { paddleApi, createTopupTransaction } from "@/lib/server/paddle-api";
import { paddleClient } from "@/lib/paddle";
import { isCreditExempt } from "@/lib/credits";
import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS, topupTransactionBody } from "@/lib/api/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Developer console → Billing → Top up. POST `{ org_id, amount_cents }`.
 *
 * Creates a Paddle transaction for exactly that amount (one non-catalog line
 * under the "API balance top-up" product) and returns its id; the browser
 * opens Paddle's overlay checkout on it, so card details go only to Paddle.
 * Nothing is credited here: the Paddle webhook (Supabase Edge Function,
 * service role) credits what Paddle says was paid, once per transaction
 * (api_add_topup, migration 0031).
 *
 * An owner/admin of an organization that has activated the API. The operator's
 * own organization is never charged, so it is never offered a checkout.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!paddleApi || !paddleClient) return NextResponse.json({ error: "topup_not_configured" }, { status: 503 });

  let body: { org_id?: unknown; amount_cents?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const orgId = typeof body.org_id === "string" ? body.org_id : "";
  const cents = body.amount_cents;
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents < TOPUP_MIN_CENTS || cents > TOPUP_MAX_CENTS)
    return NextResponse.json({ error: "bad_amount" }, { status: 400 });

  const access = await requireOrgRole({ orgId }, "admin");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  if (isCreditExempt(orgId)) return NextResponse.json({ error: "exempt" }, { status: 409 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data: settings, error } = await supabase.from("api_settings").select("activated_at").eq("org_id", orgId).maybeSingle();
  if (error) return NextResponse.json({ error: "api_unavailable" }, { status: 503 });
  if (!(settings as { activated_at?: string | null } | null)?.activated_at)
    return NextResponse.json({ error: "api_not_activated" }, { status: 409 });

  const txn = await createTopupTransaction(paddleApi, topupTransactionBody({ orgId, userId: user.id, cents, productId: paddleApi.productId }));
  if (!txn.ok) {
    console.error(`[api-topup] Paddle refused the transaction (HTTP ${txn.status})`);
    return NextResponse.json({ error: "paddle_failed" }, { status: 502 });
  }
  await logAudit({ action: "api.topup_checkout", target: orgId, detail: { amount_cents: cents, transaction_id: txn.id } });
  return NextResponse.json({ transaction_id: txn.id });
}
