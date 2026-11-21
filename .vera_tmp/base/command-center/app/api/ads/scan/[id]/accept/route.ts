import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { NO_STORE, readAdsBody } from "@/lib/server/ads-factory";
import { adsScanGate, scanFail, scanRefusal } from "@/lib/server/ads-brand-scan";
import { parseAcceptInput, parseScanId } from "@/lib/adsFactory/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accept chosen fields of a ready scan into a brand kit: POST `{ kit_id: <id> | null, fields: [...] }` (NIGHTSHIFT_ADS_BRAND_SCAN and
 * NIGHTSHIFT_ADS_FACTORY, default off: 404).
 *
 * accept_brand_scan_fields() runs as the member: the editor role, a READY scan of their organization, only fields the scan proposed,
 * 0131's cleaning, lengths and caps again, and every picture a live image of the organization's library. `kit_id` null makes a new kit
 * (it needs `name`). Nothing else is written; nothing is fetched.
 */
export const POST = requireSameOrigin(async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await adsScanGate();
  if (!gate.ok) return gate.response;
  const scan = parseScanId((await ctx.params).id);
  if (!scan) return scanFail("not_found", 404);
  const input = parseAcceptInput(await readAdsBody(request));
  if (!input.ok) return scanFail(input.error, 400);
  const { data, error } = await gate.supabase.rpc("accept_brand_scan_fields", { p_scan: scan, p_kit: input.kitId, p_fields: input.fields });
  if (error) return scanRefusal(error);
  const kit = parseScanId(data);
  if (!kit) return scanFail("failed", 502);
  return NextResponse.json({ kit_id: kit }, { headers: NO_STORE });
});
