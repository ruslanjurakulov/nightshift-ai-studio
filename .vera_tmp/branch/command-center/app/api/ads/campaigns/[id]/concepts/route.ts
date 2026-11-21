import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { NO_STORE, adsFail, adsGate, adsRefusal, readAdsBody } from "@/lib/server/ads-factory";
import { buildConceptDrafts } from "@/lib/adsFactory/concepts";
import {
  AD_CAMPAIGN_COLUMNS,
  BRAND_PRODUCT_COLUMNS,
  coerceCampaigns,
  coerceOrderedRefs,
  coerceProducts,
  isMissingRelation,
  parseAdsId,
  parseGenerateInput,
} from "@/lib/adsFactory/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Add concept drafts to a campaign: POST `{ kind: "image" | "video", count: 1..12, batch }`.
 *
 * The drafts are filled in from FIXED TEMPLATES (lib/adsFactory/concepts.ts) with the words the member's own rows hold: NO model is
 * called, nothing is fetched and no credit is quoted, held or charged. The browser sends no text at all, only how many and of which
 * kind; the campaign, its kit and its products are read here under the member's session (RLS), so another organization's campaign is a
 * plain 404. add_ad_concepts() then checks every draft again (membership, the editor role, the campaign's formats and directions, its
 * products, every length) and the campaign's concept cap. `batch` is the id of this press: the same press again is answered with the
 * first one's concepts (`replayed: true`) and adds nothing.
 */
export const POST = requireSameOrigin(async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await adsGate();
  if (!gate.ok) return gate.response;
  const id = parseAdsId((await params).id);
  if (!id) return adsFail("bad_request", 400);
  const input = parseGenerateInput(await readAdsBody(request));
  if (!input.ok) return adsFail(input.error, 400);
  const { supabase } = gate;

  const campaignRead = await supabase.from("ad_campaigns").select(AD_CAMPAIGN_COLUMNS).eq("id", id).limit(1);
  if (campaignRead.error) return adsFail(isMissingRelation(campaignRead.error) ? "not_available" : "read_failed", isMissingRelation(campaignRead.error) ? 503 : 502);
  const linkRead = await supabase.from("ad_campaign_products").select("campaign_id, product_id, position").eq("campaign_id", id).limit(20);
  if (linkRead.error) return adsFail("read_failed", 502);
  const campaign = coerceCampaigns(campaignRead.data, coerceOrderedRefs(linkRead.data, "campaign_id", "product_id"), [])[0];
  // Not readable under this session: it does not exist, or it is another organization's. The same answer for both.
  if (!campaign) return adsFail("not_found", 404);
  if (campaign.productIds.length === 0) return adsFail("invalid_products", 400);

  const [kitRead, productRead] = await Promise.all([
    supabase.from("brand_kits").select("id, name, palette").eq("id", campaign.kitId).limit(1),
    supabase.from("brand_products").select(BRAND_PRODUCT_COLUMNS).in("id", campaign.productIds).limit(20),
  ]);
  if (kitRead.error || productRead.error) return adsFail("read_failed", 502);
  const kit = (Array.isArray(kitRead.data) ? kitRead.data[0] : null) as { name?: unknown; palette?: unknown } | null;
  if (!kit || typeof kit.name !== "string") return adsFail("not_found", 404);
  const byId = new Map(coerceProducts(productRead.data, [], new Map()).map((p) => [p.id, p]));
  // In the campaign's own order; a product deleted a moment ago is simply not planned for.
  const products = campaign.productIds.map((pid) => byId.get(pid)).filter((p): p is NonNullable<typeof p> => Boolean(p));

  const drafts = buildConceptDrafts({
    brand: { name: kit.name, palette: Array.isArray(kit.palette) ? kit.palette.filter((c): c is string => typeof c === "string") : [] },
    products: products.map((p) => ({ id: p.id, title: p.title, description: p.description, price: p.price })),
    campaign: { objective: campaign.objective, language: campaign.language, formats: campaign.formats, directions: campaign.directions },
    kind: input.value.kind,
    count: input.value.count,
  });
  if (drafts.length === 0) return adsFail("invalid_products", 400);

  const { data, error } = await supabase.rpc("add_ad_concepts", { p_campaign: id, p_batch: input.value.batch, p_concepts: drafts });
  if (error) return adsRefusal(error);
  const out = data as { ids?: unknown; replayed?: unknown } | null;
  const ids = Array.isArray(out?.ids) ? out.ids.map(parseAdsId).filter((x): x is string => Boolean(x)) : null;
  if (!ids) return adsFail("failed", 502);
  const replayed = out?.replayed === true;
  return NextResponse.json({ ids, replayed }, { status: replayed ? 200 : 201, headers: NO_STORE });
});
