import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { getOrgContext } from "@/lib/orgs-server";
import { isCreditExempt } from "@/lib/credits";
import { RETURN_PATH_RE } from "@/lib/dodo";
import { PAYME_CATALOG_PACKS, PAYME_ORDER_ID_RE, paymeCheckoutUrl, paymeLang, paymePacksOnSale, paymeSellsTo } from "@/lib/payme";
import { paymeListed, paymeServer } from "@/lib/server/payments";
import { publicOrigin } from "@/lib/server/public-origin";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Buy a credit pack through Payme (Uzcard/Humo). POST `{ pack, return_path, lang? }` — OUR pack id, never an amount.
 *
 * Dark unless PAYMENTS_PROVIDER lists `payme`: until then it answers 404 before it reads the session. With it, an
 * owner/admin of a paying organization gets one ORDER for that pack (payme_open_order, in their own session, so the
 * database checks the role again) and the Payme checkout link for it at the catalog's UZS amount. Nothing is credited
 * here and nothing is spent: Payme asks the payme-merchant Edge Function whether the order and amount are payable, and
 * credits arrive only when Payme performs the transaction.
 *
 * The order function belongs to a migration that is not applied yet (its text is in the payme-adapter report): until it
 * is, the call fails and this answers 503 checkout_unavailable — honestly unavailable, never a link to an order that
 * does not exist.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  if (!paymeListed()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = paymeServer();
  if (!cfg) return NextResponse.json({ error: "checkout_not_configured" }, { status: 503 });

  let body: { pack?: unknown; return_path?: unknown; lang?: unknown };
  try {
    body = await parseJsonCapped(request);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const returnPath = typeof body?.return_path === "string" ? body.return_path : "";
  if (typeof body?.pack !== "string" || !RETURN_PATH_RE.test(returnPath)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const pack = paymePacksOnSale(PAYME_CATALOG_PACKS).find((p) => p.id === body.pack);
  if (!pack) return NextResponse.json({ error: "not_on_sale" }, { status: 404 });

  const org = await getOrgContext();
  const orgId = org.supported ? org.current?.id ?? null : null;
  if (!orgId) return NextResponse.json({ error: "no_organization" }, { status: 400 });
  const access = await requireOrgRole({ orgId }, "admin");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  if (isCreditExempt(orgId)) return NextResponse.json({ error: "exempt" }, { status: 409 });
  // Test mode on a production database sells only to the allow-listed test workspaces (PAYME_TEST_ORG_IDS).
  if (!paymeSellsTo(cfg, orgId)) return NextResponse.json({ error: "test_mode_only" }, { status: 403 });

  const db = await createClient();
  if (!db) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const opened = await db.rpc("payme_open_order", { p_org: orgId, p_pack: pack.id });
  const orderId = typeof opened.data === "string" && PAYME_ORDER_ID_RE.test(opened.data) ? opened.data : null;
  if (opened.error || !orderId) {
    const tooMany = (opened.error as { code?: string } | null)?.code === "54000";
    return NextResponse.json({ error: tooMany ? "too_many_checkouts" : "checkout_unavailable" }, { status: tooMany ? 429 : 503 });
  }

  const url = paymeCheckoutUrl(cfg, {
    orderId,
    tiyin: pack.uzs * 100,
    lang: paymeLang(body.lang),
    returnUrl: `${publicOrigin(request)}${returnPath}?payme=return`,
  });
  if (!url) return NextResponse.json({ error: "checkout_unavailable" }, { status: 503 });
  return NextResponse.json({ url }, { headers: { "Cache-Control": "no-store" } });
});
