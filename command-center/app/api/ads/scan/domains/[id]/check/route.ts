import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { NO_STORE } from "@/lib/server/ads-factory";
import { adsScanGate, scanFail, scanRefusal } from "@/lib/server/ads-brand-scan";
import { parseScanId } from "@/lib/adsFactory/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Check now": POST, no body (NIGHTSHIFT_ADS_BRAND_SCAN and NIGHTSHIFT_ADS_FACTORY, default off: 404).
 *
 * check_domain_verification() runs as the member: the editor role, one check waiting at a time (a double click is the same check), a
 * new one 15 s after the last (`too_soon`, with the seconds), and the platform's daily number (`platform_busy`, no number). It only
 * queues the check: the worker reads the DNS record, never this server.
 */
export const POST = requireSameOrigin(async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await adsScanGate();
  if (!gate.ok) return gate.response;
  const id = parseScanId((await ctx.params).id);
  if (!id) return scanFail("not_found", 404);
  const { data, error } = await gate.supabase.rpc("check_domain_verification", { p_domain: id });
  if (error) return scanRefusal(error);
  const out = data as { check_id?: unknown; replayed?: unknown } | null;
  if (!parseScanId(out?.check_id)) return scanFail("failed", 502);
  return NextResponse.json({ pending: true, replayed: out?.replayed === true }, { status: 202, headers: NO_STORE });
});
