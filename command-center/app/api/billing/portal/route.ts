import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { getOrgContext } from "@/lib/orgs-server";
import { logAudit } from "@/lib/server/audit";
import { createPortalSession, paddleServerKey } from "@/lib/server/paddle-api";
import { createDodoPortalLink, dodoServer } from "@/lib/server/dodo-api";
import { paymentsProvider } from "@/lib/server/payments";
import { publicOrigin } from "@/lib/server/public-origin";
import { requireSameOrigin } from "@/lib/server/same-origin";

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
 *
 * A subscription bought through Dodo Payments (0142, provider 'dodo') opens
 * Dodo's customer portal instead, with DODO_PAYMENTS_API_KEY — whatever
 * PAYMENTS_PROVIDER says today, because the portal belongs to the provider
 * that holds that subscription. With PAYMENTS_PROVIDER unset or `paddle` and
 * no Dodo subscription, every line below runs exactly as before.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dodoOn = paymentsProvider() === "dodo" || dodoServer() !== null;
  if (!paddleServerKey && !dodoOn) return NextResponse.json({ error: "portal_not_configured" }, { status: 503 });
  const org = await getOrgContext();
  const orgId = org.supported ? org.current?.id ?? null : null;
  if (!orgId) return NextResponse.json({ error: "no_organization" }, { status: 400 });
  const access = await requireOrgRole({ orgId }, "admin");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data, error } = await supabase
    .from("subscriptions")
    .select("provider,provider_subscription_id,provider_customer_id,status")
    .eq("org_id", orgId)
    .in("status", ["active", "trialing", "past_due", "paused"])
    .order("updated_at", { ascending: false })
    .limit(5);
  if (error) return NextResponse.json({ error: "subscription_unavailable" }, { status: 503 });
  const all = (data ?? []) as { provider?: string; provider_subscription_id: string; provider_customer_id: string | null }[];
  const newest = all.find((r) => r.provider_customer_id) ?? null;
  if (newest?.provider === "dodo") {
    const cfg = dodoServer();
    if (!cfg) return NextResponse.json({ error: "portal_not_configured" }, { status: 503 });
    const link = await createDodoPortalLink(cfg, newest.provider_customer_id ?? "", `${publicOrigin(request)}/all-channels/credits`);
    if (!link) return NextResponse.json({ error: "portal_failed" }, { status: 502 });
    await logAudit({ action: "billing.portal", target: orgId, detail: { provider: "dodo" } });
    return NextResponse.json({ url: link }, { headers: { "Cache-Control": "no-store" } });
  }
  if (!paddleServerKey) return NextResponse.json({ error: "portal_not_configured" }, { status: 503 });
  const rows = all.filter((r) => r.provider !== "dodo");
  const customer = rows.find((r) => r.provider_customer_id)?.provider_customer_id ?? null;
  if (!customer) return NextResponse.json({ error: "no_subscription" }, { status: 404 });
  const subs = rows.filter((r) => r.provider_customer_id === customer).map((r) => r.provider_subscription_id);

  const url = await createPortalSession(paddleServerKey, customer, subs);
  if (!url) return NextResponse.json({ error: "portal_failed" }, { status: 502 });
  await logAudit({ action: "billing.portal", target: orgId, detail: {} });
  return NextResponse.json({ url }, { headers: { "Cache-Control": "no-store" } });
});
