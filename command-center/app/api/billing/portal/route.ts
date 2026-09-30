import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { getOrgContext } from "@/lib/orgs-server";
import { logAudit } from "@/lib/server/audit";
import { createPortalSession, paddleServerKey } from "@/lib/server/paddle-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Manage subscription" (migration 0034): a fresh, signed-in link to Paddle's
 * customer portal for the current organization's subscription — update the
 * card, cancel, invoices. An owner/admin of the organization only (the same
 * bar as subscribing). The Paddle customer and subscription ids are read
 * through the user's own RLS; the API key stays on this server and only goes
 * to Paddle. Nothing is changed here: every change happens in Paddle's portal
 * and comes back through the webhook.
 */
export async function POST() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!paddleServerKey) return NextResponse.json({ error: "portal_not_configured" }, { status: 503 });
  const org = await getOrgContext();
  const orgId = org.supported ? org.current?.id ?? null : null;
  if (!orgId) return NextResponse.json({ error: "no_organization" }, { status: 400 });
  const access = await requireOrgRole({ orgId }, "admin");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase
    .from("subscriptions")
    .select("provider_subscription_id,provider_customer_id,status")
    .eq("org_id", orgId)
    .in("status", ["active", "trialing", "past_due", "paused"])
    .order("updated_at", { ascending: false })
    .limit(5);
  if (error) return NextResponse.json({ error: "subscription_unavailable" }, { status: 503 });
  const rows = (data ?? []) as { provider_subscription_id: string; provider_customer_id: string | null }[];
  const customer = rows.find((r) => r.provider_customer_id)?.provider_customer_id ?? null;
  if (!customer) return NextResponse.json({ error: "no_subscription" }, { status: 404 });
  const subs = rows.filter((r) => r.provider_customer_id === customer).map((r) => r.provider_subscription_id);

  const url = await createPortalSession(paddleServerKey, customer, subs);
  if (!url) return NextResponse.json({ error: "portal_failed" }, { status: 502 });
  await logAudit({ action: "billing.portal", target: orgId, detail: {} });
  return NextResponse.json({ url }, { headers: { "Cache-Control": "no-store" } });
}
