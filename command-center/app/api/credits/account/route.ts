import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { isUuid } from "@/lib/creative/operations";
import { readCreditAccount } from "@/lib/server/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The open organization's credit account as it is NOW: what the header's credit pill and the Studio's price key read after a
 * generation was started, cancelled or finished (lib/credits-live.ts). The layout reads the same row once per page; without this
 * the pill showed 400 while 25 of them were held for a job (Pixel audit, 2026-11-13).
 *
 * GET ?org_id=<uuid>. Read-only, as the signed-in member (RLS on credit_accounts, 0020), and only for the organization being
 * viewed (requireOrgRole: another organization's id is "not found", the rule every org route keeps). The operator's own
 * (default, exempt) organization has no pill, and its read is never asked for: the store refreshes only what the layout seeded.
 * A failed read is 503 `credits_read_failed` (unknown), never a zero; no account row is a real 0 available.
 */
export async function GET(request: Request) {
  if (!(await getUser())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = new URL(request.url).searchParams.get("org_id") ?? "";
  if (!isUuid(orgId)) return NextResponse.json({ error: "org_required" }, { status: 400 });
  const access = await requireOrgRole({ orgId }, "viewer");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const read = await readCreditAccount(supabase, orgId).catch(() => null);
  if (!read || read.failed) return NextResponse.json({ error: "credits_read_failed" }, { status: 503 });
  if (!read.supported) return NextResponse.json({ supported: false, account: null }, { headers: { "cache-control": "no-store" } });
  return NextResponse.json({ supported: true, account: read.account }, { headers: { "cache-control": "no-store" } });
}
