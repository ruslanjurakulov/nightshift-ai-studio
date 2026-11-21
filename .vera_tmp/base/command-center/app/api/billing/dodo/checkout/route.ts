import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { getOrgContext } from "@/lib/orgs-server";
import { isCreditExempt } from "@/lib/credits";
import { RETURN_PATH_RE, dodoItemKey, dodoReturnItem, dodoSellsTo, parseCheckoutItem } from "@/lib/dodo";
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
 * never a product id — or `{ kind: "amount", usd_cents, return_path }` for the
 * "Add credits" sheet's typed amount: a JSON integer of US cents inside
 * DODO_AMOUNT's bounds ($5 to $300), refused otherwise. The cents are signed
 * into the metadata (`pack:amount_<cents>`) and set as the Pay What You Want
 * line's price; the webhook credits the signed cents at its own rate, and only
 * when Dodo reports exactly that amount paid. The browser never names credits.
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
  // Test mode on a production database sells only to the allow-listed test workspaces (DODO_TEST_ORG_IDS).
  if (!dodoSellsTo(cfg, orgId)) return NextResponse.json({ error: "test_mode_only" }, { status: 403 });
  // The checkout's e-mail is the account's own and is not editable there (lib/server/dodo-api.ts).
  if (!user.email) return NextResponse.json({ error: "email_required" }, { status: 409 });

  const productId = item.kind === "pack" ? cfg.packs[item.id] : item.kind === "plan" ? cfg.plans[item.id] : cfg.amountProduct;
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

  // A fresh nonce for this one checkout (dodo_issue_checkout_nonce, 0146: owner/admin of the organization, in the user's
  // own session): the webhook spends it once, so the signed metadata cannot be replayed on a static Dodo link.
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  // The nonce row stores the same item the metadata signs, so a typed amount is bound in the database too.
  const issued = await db.rpc("dodo_issue_checkout_nonce", { p_org: orgId, p_item: dodoItemKey(item) });
  const nonce = typeof issued.data === "string" && /^[0-9a-f]{32}$/.test(issued.data) ? issued.data : null;
  if (issued.error || !nonce) {
    const tooMany = (issued.error as { code?: string } | null)?.code === "54000";
    return NextResponse.json({ error: tooMany ? "too_many_checkouts" : "checkout_unavailable" }, { status: tooMany ? 429 : 503 });
  }

  const origin = publicOrigin(request);
  const res = await createDodoCheckout(cfg, {
    productId,
    orgId,
    nonce,
    userId: user.id,
    email: user.email,
    item,
    // Back through our own route (../return), which drops what Dodo appends (the customer's e-mail among it) and sends the
    // browser on to the Credits page. `item` tells the page which panel waits for the webhook; it decides no amount.
    returnUrl: `${origin}/api/billing/dodo/return?to=${encodeURIComponent(returnPath)}&dodo=return&item=${dodoReturnItem(item)}`,
    cancelUrl: `${origin}/api/billing/dodo/return?to=${encodeURIComponent(returnPath)}&dodo=cancelled&item=${dodoReturnItem(item)}`,
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
