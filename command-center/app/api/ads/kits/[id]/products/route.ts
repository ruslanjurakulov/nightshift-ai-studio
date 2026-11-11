import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { NO_STORE, adsFail, adsGate, adsRefusal, readAdsBody } from "@/lib/server/ads-factory";
import { parseAdsId, parseProductInput } from "@/lib/adsFactory/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Add a product to a brand kit: POST `{ title, description?, price?, image_ids? }`. save_brand_product() checks that the member edits
 * the kit's organization, that every picture is a live image of ITS library, and the kit's product cap. The price is text a person
 * typed: it is stored as text and never parsed.
 */
export const POST = requireSameOrigin(async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const kit = parseAdsId((await params).id);
  if (!kit) return adsFail("bad_request", 400);
  const input = parseProductInput(await readAdsBody(request));
  if (!input.ok) return adsFail(input.error, 400);

  const { data, error } = await gate.supabase.rpc("save_brand_product", {
    p_kit: kit,
    p_product: null,
    p_title: input.value.title,
    p_description: input.value.description,
    p_price: input.value.price,
    p_images: input.value.imageIds,
  });
  if (error) return adsRefusal(error);
  const id = parseAdsId(data);
  if (!id) return adsFail("failed", 502);
  return NextResponse.json({ id }, { status: 201, headers: NO_STORE });
});
