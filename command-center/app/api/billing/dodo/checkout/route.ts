import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { getOrgContext } from "@/lib/orgs-server";
import { isCreditExempt } from "@/lib/credits";
import { RETURN_PATH_RE, parseCheckoutItem } from "@/lib/dodo";
import { createDodoCheckout, dodoServer } from "@/lib/server/dodo-api";
import { paymentsProvider } from "@/lib/server/payments";
import { publicOrigin } from "@/lib/server/public-origin";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Buy a credit pack or subscribe to a plan through Dodo Payments. POST
 * `{ kind: "pack" | "plan", id, return_path }` — OUR id ("starter", "pro"),
 * never a product id or an amount.
 *
 * Dark unless PAYMENTS_PROVIDER is `dodo`: until then it answers 404 before it
 * reads the session, so nothing about the Paddle path changes. With it, the
 * server picks the Dodo product for that id, creates a checkout session with
 * { org_id, user_id } in its metadata (the webhook's only "who") and returns
 * Dodo's hosted checkout URL; the browser goes there, and card details go only
 * to Dodo. Nothing is credited here: the dodo-webhook Edge Function (service
 * role) credits what Dodo says was paid, checked against the catalog price.
 *
 * The same bar as the Paddle checkout: an owner/admin of an organization that
 * pays (never the exempt operator organization). A plan is refused while the
 * organization already has a live subscription, so a second click cannot
 * start a second one.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  if (paymentsProvider() !== "dodo") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = dodoServer();
  if (!cfg) return NextResponse.json({ error: "checkout_not_configured" }, { status: 503 });

  let body: { return_path?: unknown };
  try {
    body = await parseJsonCapped(request);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const item = parseCheckoutItem(body);
  const returnPath = typeof body?.return_path === "string" ? body.return_path : "";
  if (!item || !RETURN_PATH_RE.test(returnPath)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const org = await getOrgContext();
  const orgId = org.supported ? org.current?.id ?? null : null;
  if (!orgId) return NextResponse.json({ error: "no_organization" }, { status: 400 });
  const access = await requireOrgRole({ orgId }, "admin");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  if (isCreditExempt(orgId)) return NextResponse.json({ error: "exempt" }, { status: 409 });

  const productId = item.kind === "pack" ? cfg.packs[item.id] : cfg.plans[item.id];
  if (!productId) return NextResponse.json({ error: "not_on_sale" }, { status: 404 });

  if (item.kind === "plan") {
    const supabase = await createClient();
    if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
    const { data, error } = await supabase
      .from("subscriptions")
      .select("id")
      .eq("org_id", orgId)
      .in("status", ["active", "trialing", "past_due"])
      .limit(1);
    // Unknown is not "none": a second subscription could double-charge, so nothing is opened until it reads.
    if (error) return NextResponse.json({ error: "subscription_unavailable" }, { status: 503 });
    if ((data ?? []).length > 0) return NextResponse.json({ error: "already_subscribed" }, { status: 409 });
  }

  const origin = publicOrigin(request);
  const res = await createDodoCheckout(cfg, {
    productId,
    orgId,
    userId: user.id,
    email: user.email ?? null,
    item,
    // `item` tells the page which panel waits for the webhook (lib/dodo-client.ts takeDodoReturn); it decides no amount.
    returnUrl: `${origin}${returnPath}?dodo=return&item=${item.kind}`,
    cancelUrl: `${origin}${returnPath}?dodo=cancelled&item=${item.kind}`,
  });
  if (!res.ok) {
    console.error(`[dodo-checkout] Dodo refused the checkout session (HTTP ${res.status})`);
    return NextResponse.json({ error: "checkout_failed" }, { status: 502 });
  }
  // No audit row here: `billing.checkout` is not in audit_action_allowed (0087/0117), so the database would refuse it and
  // logAudit would drop it silently (tests/test_audit_actions.py). Paddle's checkout writes none either. Who paid is in the
  // payment's own record: the webhook stores the payment with the org and the user_id from this session's metadata.
  return NextResponse.json({ url: res.url }, { headers: { "Cache-Control": "no-store" } });
});
