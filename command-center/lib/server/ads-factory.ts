import "server-only";
import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { MEDIA_ASSET_COLUMNS, coerceAssets } from "@/lib/media";
import { mediaDir, mediaUrlSecret, withUrls } from "@/lib/server/media";
import { parseJsonCapped } from "@/lib/server/json-body";
import { adsFactoryEnabled } from "@/lib/adsFactory/flag";
import {
  AD_CAMPAIGN_COLUMNS,
  AD_CONCEPT_COLUMNS,
  BRAND_KIT_COLUMNS,
  BRAND_PRODUCT_COLUMNS,
  coerceCampaigns,
  coerceConcepts,
  coerceKits,
  coerceOrderedRefs,
  coerceProducts,
  isMissingRelation,
  mapAdsError,
  parseAdsId,
  type AdsError,
  type AdsWorkspaceData,
} from "@/lib/adsFactory/model";

export type { AdsWorkspaceData };

/**
 * Ads Factory, Phase 1 (migration 0131), read and written on the server.
 *
 * Everything goes through the signed-in member's own Supabase client (anon key + session): RLS returns the rows of organizations
 * they belong to and nothing else, and every write is one of 0131's functions, which checks membership, the editor role, the caps
 * and every field again. Never the service key. Nothing here fetches a web site, calls a model or touches credits: Phase 1 has no
 * such step (docs/ADS_FACTORY.md).
 */

export const NO_STORE = { "cache-control": "no-store" };

export function adsFail(error: AdsError, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

type Client = NonNullable<Awaited<ReturnType<typeof createClient>>>;
export type AdsGate = { ok: true; supabase: Client; userId: string } | { ok: false; response: NextResponse };

/**
 * The first lines of every /api/ads route, in this order: the switch (off = 404 before anything is read), the session, the client.
 * A route that is switched off must not tell a visitor whether they are signed in, so the flag is checked first.
 */
export async function adsGate(): Promise<AdsGate> {
  if (!adsFactoryEnabled()) return { ok: false, response: adsFail("not_found", 404) };
  const user = await getUser();
  if (!user) return { ok: false, response: adsFail("unauthorized", 401) };
  const supabase = await createClient();
  if (!supabase) return { ok: false, response: adsFail("not_configured", 503) };
  return { ok: true, supabase, userId: user.id };
}

/** The request's JSON body, or undefined when it is not JSON or is too large (a 400, not a 500). */
export async function readAdsBody(request: Request): Promise<unknown> {
  try {
    return await parseJsonCapped(request);
  } catch {
    return undefined;
  }
}

/** `org_id` when given (must be a uuid), else the organization the app has open. */
export async function resolveAdsOrg(asked: unknown): Promise<{ org: string | null; bad: boolean }> {
  if (asked !== null && asked !== undefined && asked !== "") {
    const org = parseAdsId(asked);
    return { org, bad: !org };
  }
  const ctx = await getOrgContext();
  return { org: ctx.current?.id ?? null, bad: false };
}

/** A database refusal as the route's answer: a closed word, a status, and the cap the database named, if it named one. */
export function adsRefusal(error: { code?: string; message?: string; details?: string }) {
  const mapped = mapAdsError(error);
  return adsFail(mapped.error, mapped.status, mapped.max === undefined ? {} : { max: mapped.max });
}

const EMPTY: AdsWorkspaceData = { available: false, kits: [], campaigns: [] };
const FAILED: AdsWorkspaceData = { available: true, kits: [], campaigns: [], error: "read_failed" };
/** An `in (...)` filter travels in the URL: keep each request well under any proxy's limit. */
const ID_CHUNK = 100;
/** Ceilings of one read, far above what the caps of 0131 allow (100 kits, 200 products each is the owner's maximum, not a default). */
const READ = { kits: 100, products: 2000, images: 8000, campaigns: 1000, campaignProducts: 20000, concepts: 5000 };

/**
 * Every brand kit (with its products and their pictures) and every campaign (with its products and concepts) of `orgId`.
 * `available: false` when 0131 is not applied; `error: "read_failed"` when a read failed, never an empty list that would read as
 * "you have none".
 */
export async function loadAdsWorkspace(supabase: Client, orgId: string, opts: { urls?: boolean } = {}): Promise<AdsWorkspaceData> {
  if (!parseAdsId(orgId)) return EMPTY;
  try {
    const [kits, products, images, campaigns, campaignProducts, concepts] = await Promise.all([
      supabase.from("brand_kits").select(BRAND_KIT_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: true }).limit(READ.kits),
      supabase.from("brand_products").select(BRAND_PRODUCT_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: true }).limit(READ.products),
      supabase.from("brand_product_images").select("product_id, asset_id, position").eq("org_id", orgId).limit(READ.images),
      supabase.from("ad_campaigns").select(AD_CAMPAIGN_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: false }).limit(READ.campaigns),
      supabase.from("ad_campaign_products").select("campaign_id, product_id, position").eq("org_id", orgId).limit(READ.campaignProducts),
      supabase
        .from("ad_concepts")
        .select(AD_CONCEPT_COLUMNS)
        .eq("org_id", orgId)
        .order("created_at", { ascending: true })
        .order("batch_n", { ascending: true })
        .limit(READ.concepts),
    ]);
    const errors = [kits.error, products.error, images.error, campaigns.error, campaignProducts.error, concepts.error].filter(Boolean);
    if (errors.length) return errors.some((e) => isMissingRelation(e)) ? EMPTY : FAILED;

    const imageRefs = coerceOrderedRefs(images.data, "product_id", "asset_id");
    const logoIds = (Array.isArray(kits.data) ? kits.data : [])
      .map((k) => parseAdsId((k as { logo_asset_id?: unknown }).logo_asset_id))
      .filter((id): id is string => Boolean(id));
    const live = await loadPictures(supabase, orgId, [...new Set([...imageRefs.map((i) => i.target), ...logoIds])], opts);
    if (live === null) return FAILED;

    const productRows = coerceProducts(products.data, imageRefs, live);
    return {
      available: true,
      kits: coerceKits(kits.data, productRows, live),
      campaigns: coerceCampaigns(campaigns.data, coerceOrderedRefs(campaignProducts.data, "campaign_id", "product_id"), coerceConcepts(concepts.data)),
    };
  } catch {
    return FAILED;
  }
}

/** The live pictures among `ids` (RLS: same organization, not deleted), or null when a read failed. */
async function loadPictures(
  supabase: Client,
  orgId: string,
  ids: string[],
  opts: { urls?: boolean },
): Promise<Map<string, { thumbUrl: string | null; name: string | null }> | null> {
  const out = new Map<string, { thumbUrl: string | null; name: string | null }>();
  if (!ids.length) return out;
  const secret = opts.urls ? mediaUrlSecret() : null;
  const served = Boolean(opts.urls && mediaDir());
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await supabase.from("media_assets").select(MEDIA_ASSET_COLUMNS).eq("org_id", orgId).in("id", ids.slice(i, i + ID_CHUNK));
    if (error) return null;
    for (const a of coerceAssets(data)) {
      if (a.kind !== "image") continue;
      const signed = withUrls(a, secret, served);
      out.set(a.id, { thumbUrl: signed.thumbUrl ?? signed.viewUrl, name: a.name ?? null });
    }
  }
  return out;
}
