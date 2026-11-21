import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { NO_STORE, adsFail, adsGate, adsRefusal, readAdsBody } from "@/lib/server/ads-factory";
import { parseAdsId, parseKitInput } from "@/lib/adsFactory/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Replace a brand kit's fields: PATCH `{ name, site_url?, logo_asset_id?, palette?, fonts?, voice? }`. The kit's organization is its
 * own: save_brand_kit() takes it from the row, so another organization's kit (or a made-up id) is a plain 404.
 */
export const PATCH = requireSameOrigin(async function PATCH(request: Request, { params }: Ctx) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const id = parseAdsId((await params).id);
  if (!id) return adsFail("bad_request", 400);
  const input = parseKitInput(await readAdsBody(request));
  if (!input.ok) return adsFail(input.error, 400);

  const { data, error } = await gate.supabase.rpc("save_brand_kit", {
    p_org: null,
    p_kit: id,
    p_name: input.value.name,
    p_site_url: input.value.siteUrl,
    p_logo: input.value.logoAssetId,
    p_palette: input.value.palette,
    p_fonts: input.value.fonts,
    p_voice: input.value.voice,
  });
  if (error) return adsRefusal(error);
  if (parseAdsId(data) !== id) return adsFail("failed", 502);
  return NextResponse.json({ id }, { headers: NO_STORE });
});

/**
 * Delete a brand kit with its products. delete_brand_kit() refuses while a campaign still uses the kit (`kit_in_use`): a campaign's
 * concepts are deleted by deleting the campaign, on purpose, never as a side effect.
 */
export const DELETE = requireSameOrigin(async function DELETE(_request: Request, { params }: Ctx) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const id = parseAdsId((await params).id);
  if (!id) return adsFail("bad_request", 400);
  const { data, error } = await gate.supabase.rpc("delete_brand_kit", { p_kit: id });
  if (error) return adsRefusal(error);
  if (data !== true) return adsFail("failed", 502);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
});
