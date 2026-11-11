import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { NO_STORE, adsFail, adsGate, adsRefusal, readAdsBody } from "@/lib/server/ads-factory";
import { parseAdsId, parseCampaignInput } from "@/lib/adsFactory/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Replace a campaign's fields and product list: PATCH `{ name, objective, language, formats, directions, product_ids }`. Its kit cannot change. */
export const PATCH = requireSameOrigin(async function PATCH(request: Request, { params }: Ctx) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const id = parseAdsId((await params).id);
  if (!id) return adsFail("bad_request", 400);
  const input = parseCampaignInput(await readAdsBody(request));
  if (!input.ok) return adsFail(input.error, 400);

  const { data, error } = await gate.supabase.rpc("save_ad_campaign", {
    p_kit: null,
    p_campaign: id,
    p_name: input.value.name,
    p_objective: input.value.objective,
    p_language: input.value.language,
    p_formats: input.value.formats,
    p_directions: input.value.directions,
    p_products: input.value.productIds,
  });
  if (error) return adsRefusal(error);
  if (parseAdsId(data) !== id) return adsFail("failed", 502);
  return NextResponse.json({ id }, { headers: NO_STORE });
});

/** Delete a campaign with its concepts (approved ones included: in Phase 1 an approved concept is words, nothing was made from it). */
export const DELETE = requireSameOrigin(async function DELETE(_request: Request, { params }: Ctx) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const id = parseAdsId((await params).id);
  if (!id) return adsFail("bad_request", 400);
  const { data, error } = await gate.supabase.rpc("delete_ad_campaign", { p_campaign: id });
  if (error) return adsRefusal(error);
  if (data !== true) return adsFail("failed", 502);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
});
