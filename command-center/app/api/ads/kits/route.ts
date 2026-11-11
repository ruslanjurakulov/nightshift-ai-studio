import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { NO_STORE, adsFail, adsGate, adsRefusal, readAdsBody, resolveAdsOrg } from "@/lib/server/ads-factory";
import { parseAdsId, parseKitInput } from "@/lib/adsFactory/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a brand kit: POST `{ org_id?, name, site_url?, logo_asset_id?, palette?, fonts?, voice? }`
 * (NIGHTSHIFT_ADS_FACTORY, default off: 404).
 *
 * save_brand_kit() runs as the signed-in member and checks that they edit this organization, that the logo is a live image of ITS
 * library, every length and shape again, and the organization's kit cap. The site address is stored as text: this route does not
 * open it, resolve it or pass it to anything that would.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const body = await readAdsBody(request);
  const input = parseKitInput(body);
  if (!input.ok) return adsFail(input.error, 400);
  const { org, bad } = await resolveAdsOrg((body as { org_id?: unknown }).org_id);
  if (bad) return adsFail("bad_request", 400);
  if (!org) return adsFail("org_required", 400);

  const { data, error } = await gate.supabase.rpc("save_brand_kit", {
    p_org: org,
    p_kit: null,
    p_name: input.value.name,
    p_site_url: input.value.siteUrl,
    p_logo: input.value.logoAssetId,
    p_palette: input.value.palette,
    p_fonts: input.value.fonts,
    p_voice: input.value.voice,
  });
  if (error) return adsRefusal(error);
  const id = parseAdsId(data);
  if (!id) return adsFail("failed", 502);
  return NextResponse.json({ id }, { status: 201, headers: NO_STORE });
});
