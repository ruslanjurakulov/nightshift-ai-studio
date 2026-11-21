import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { NO_STORE, adsFail, adsGate, adsRefusal, readAdsBody } from "@/lib/server/ads-factory";
import { parseAdsId, parseCampaignInput } from "@/lib/adsFactory/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create a campaign for a brand kit: POST `{ kit_id, name, objective, language, formats, directions, product_ids }`. Every choice is
 * from a closed list and every product must be one of the kit's own; save_ad_campaign() checks all of it again, and the
 * organization's campaign cap. A campaign is a plan in words: creating one queues nothing and costs nothing.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const body = await readAdsBody(request);
  const input = parseCampaignInput(body);
  if (!input.ok) return adsFail(input.error, 400);
  const kit = parseAdsId((body as { kit_id?: unknown }).kit_id);
  if (!kit) return adsFail("bad_request", 400);

  const { data, error } = await gate.supabase.rpc("save_ad_campaign", {
    p_kit: kit,
    p_campaign: null,
    p_name: input.value.name,
    p_objective: input.value.objective,
    p_language: input.value.language,
    p_formats: input.value.formats,
    p_directions: input.value.directions,
    p_products: input.value.productIds,
  });
  if (error) return adsRefusal(error);
  const id = parseAdsId(data);
  if (!id) return adsFail("failed", 502);
  return NextResponse.json({ id }, { status: 201, headers: NO_STORE });
});
