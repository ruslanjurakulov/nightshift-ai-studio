import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { getOrgContext } from "@/lib/orgs-server";
import { isCreditExempt } from "@/lib/credits";
import { DODO_PAYMENT_ID_RE, dodoServer, fetchDodoInvoicePdf } from "@/lib/server/dodo-api";
import { dodoPaymentIsOrgs } from "@/lib/server/dodo-history";
import { paymentsProvider } from "@/lib/server/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, private" };

/**
 * The invoice PDF of one Dodo payment, for the Credits page's purchase history: GET `?payment=pay_…`. Read-only: it changes,
 * credits and spends nothing.
 *
 * The same bar as buying: signed in, an owner/admin of the current organization, never the exempt operator organization. The
 * payment must be one that credited THIS organization, which the database answers (dodo_purchase_history, migration 0154, in the
 * user's own session) before Dodo is asked; another organization's payment id is a 404 here whatever Dodo would say. The PDF is
 * fetched from Dodo with the API key, which never leaves this server (lib/server/dodo-api.ts fetchDodoInvoicePdf).
 *
 * The page fetches it from its own script (so a refusal can be said in words), never as a cross-site link: a request the
 * browser marks `Sec-Fetch-Site: cross-site` or `same-site` is refused, so another site cannot spend the invoice endpoint's own
 * limit (5 a minute per payment, Dodo's api-reference/introduction) on someone's session. Dark (404) unless PAYMENTS_PROVIDER
 * is `dodo`, before the session is read.
 */
export async function GET(request: Request) {
  if (paymentsProvider() !== "dodo") return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const cfg = dodoServer();
  if (!cfg) return NextResponse.json({ error: "not_configured" }, { status: 503, headers: NO_STORE });

  const payment = new URL(request.url).searchParams.get("payment") ?? "";
  if (!DODO_PAYMENT_ID_RE.test(payment)) return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });

  const org = await getOrgContext();
  const orgId = org.supported ? org.current?.id ?? null : null;
  if (!orgId) return NextResponse.json({ error: "no_organization" }, { status: 400, headers: NO_STORE });
  const access = await requireOrgRole({ orgId }, "admin");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status, headers: NO_STORE });
  if (isCreditExempt(orgId)) return NextResponse.json({ error: "exempt" }, { status: 409, headers: NO_STORE });

  const db = await createClient();
  if (!db) return NextResponse.json({ error: "not_configured" }, { status: 503, headers: NO_STORE });
  const owned = await dodoPaymentIsOrgs(db, orgId, payment);
  // Unknown is not "yours": nothing is fetched until the database says so.
  if (owned === "missing") return NextResponse.json({ error: "history_not_migrated" }, { status: 503, headers: NO_STORE });
  if (owned === "unknown") return NextResponse.json({ error: "history_unavailable" }, { status: 503, headers: NO_STORE });
  if (owned === "no") return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const answer = await fetchDodoInvoicePdf(cfg, payment);
  if (!answer.ok) {
    if (answer.reason === "rate_limited")
      return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { ...NO_STORE, "Retry-After": "60" } });
    if (answer.reason === "not_found") return NextResponse.json({ error: "invoice_not_found" }, { status: 404, headers: NO_STORE });
    console.error("[dodo-invoice] Dodo did not return an invoice PDF");
    return NextResponse.json({ error: "invoice_failed" }, { status: 502, headers: NO_STORE });
  }
  return new Response(answer.pdf, {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="invoice-${payment}.pdf"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
