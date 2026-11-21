import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { NO_STORE, adsFail, adsGate, adsRefusal, readAdsBody } from "@/lib/server/ads-factory";
import { parseAdsId, parseProductInput } from "@/lib/adsFactory/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Replace a product and its pictures: PATCH `{ title, description?, price?, image_ids? }`. Its kit is the product's own. */
export const PATCH = requireSameOrigin(async function PATCH(request: Request, { params }: Ctx) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const id = parseAdsId((await params).id);
  if (!id) return adsFail("bad_request", 400);
  const input = parseProductInput(await readAdsBody(request));
  if (!input.ok) return adsFail(input.error, 400);

  const { data, error } = await gate.supabase.rpc("save_brand_product", {
    p_kit: null,
    p_product: id,
    p_title: input.value.title,
    p_description: input.value.description,
    p_price: input.value.price,
    p_images: input.value.imageIds,
  });
  if (error) return adsRefusal(error);
  if (parseAdsId(data) !== id) return adsFail("failed", 502);
  return NextResponse.json({ id }, { headers: NO_STORE });
});

/** Delete a product. Campaigns that advertised it lose it from their list; concepts written for it stay and name no product. */
export const DELETE = requireSameOrigin(async function DELETE(_request: Request, { params }: Ctx) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const id = parseAdsId((await params).id);
  if (!id) return adsFail("bad_request", 400);
  const { data, error } = await gate.supabase.rpc("delete_brand_product", { p_product: id });
  if (error) return adsRefusal(error);
  if (data !== true) return adsFail("failed", 502);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
});
