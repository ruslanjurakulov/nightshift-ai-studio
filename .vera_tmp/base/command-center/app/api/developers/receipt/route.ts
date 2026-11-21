import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { paddleApi, transactionInvoiceUrl } from "@/lib/server/paddle-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET ?org=<id>&txn=<Paddle transaction id> — the Paddle invoice of one API
 * top-up. Only for a top-up that is in the organization's own API ledger,
 * read with the caller's session (RLS: owners/admins), so nobody can fetch
 * another organization's invoice by guessing an id. Redirects to Paddle's
 * short-lived PDF link.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(request.url).searchParams;
  const orgId = q.get("org") ?? "";
  const txn = q.get("txn") ?? "";
  if (!/^txn_[a-z0-9]{10,40}$/.test(txn)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const access = await requireOrgRole({ orgId }, "admin");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  if (!paddleApi) return NextResponse.json({ error: "receipts_not_configured" }, { status: 503 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const { data } = await supabase
    .from("api_ledger")
    .select("id")
    .eq("org_id", orgId)
    .eq("kind", "topup")
    .eq("external_id", txn)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const url = await transactionInvoiceUrl(paddleApi, txn);
  if (!url) return NextResponse.json({ error: "receipt_unavailable" }, { status: 502 });
  return NextResponse.redirect(url, 303);
}
