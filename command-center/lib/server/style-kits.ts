import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { MEDIA_ASSET_COLUMNS, coerceAssets } from "@/lib/media";
import { mediaDir, mediaUrlSecret, withUrls } from "@/lib/server/media";
import {
  CHARACTER_COLUMNS,
  CHARACTER_LIMITS,
  KIT_LIMITS,
  STYLE_KIT_COLUMNS,
  coerceCharacters,
  coerceKits,
  coerceReferenceRows,
  isMissingRelation,
  parseStyleId,
  type ReferenceAsset,
  type ReferenceRow,
  type StyleContext,
} from "@/lib/style-kits";

export type { StyleContext };

/**
 * Style kits and characters (migration 0047), read on the server.
 *
 * Everything is read with the signed-in user's own Supabase client (anon key
 * + session), so RLS returns the rows of organizations they belong to and
 * nothing else — never the service key. A reference whose image was deleted
 * from the library is still listed, marked not live: RLS hides deleted
 * assets, so "not readable" is exactly "not usable".
 */

/** `?org=` / `org_id` when given (must be a uuid), else the organization the app has open. */
export async function resolveStyleOrg(asked: unknown): Promise<{ org: string | null; bad: boolean }> {
  if (asked !== null && asked !== undefined && asked !== "") {
    const org = parseStyleId(asked);
    return { org, bad: !org };
  }
  const ctx = await getOrgContext();
  return { org: ctx.current?.id ?? null, bad: false };
}

/** The request's JSON body, or undefined when it is not JSON (a 400, not a 500). */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

const EMPTY: StyleContext = { available: false, kits: [], characters: [] };

/** An `in (...)` filter travels in the URL: keep each request well under any proxy's limit. */
const ID_CHUNK = 100;

export interface LoadOptions {
  /** Sign short-lived thumbnail links (the page wants them; a generation step does not). */
  urls?: boolean;
}

/**
 * Every style kit and character of `orgId`, with their references in order.
 * `available: false` when 0047 is not applied; `error: "read_failed"` when a
 * read failed — never an empty list that would read as "you have none".
 *
 * Studio generations do not read through here: the creative worker reads a
 * job's kit and @characters itself, in the job's organization (migration
 * 0048, creative_job_style). This is the page's read.
 */
export async function loadStyleContext(orgId: string, opts: LoadOptions = {}): Promise<StyleContext> {
  const supabase = await createClient();
  if (!supabase || !parseStyleId(orgId)) return EMPTY;
  try {
    const [kits, chars, kitRefs, charRefs] = await Promise.all([
      supabase
        .from("style_kits")
        .select(STYLE_KIT_COLUMNS)
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(KIT_LIMITS.perOrg),
      supabase
        .from("characters")
        .select(CHARACTER_COLUMNS)
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(CHARACTER_LIMITS.perOrg),
      supabase
        .from("style_kit_references")
        .select("kit_id, asset_id, position")
        .eq("org_id", orgId)
        .limit(KIT_LIMITS.perOrg * KIT_LIMITS.maxRefs),
      supabase
        .from("character_references")
        .select("character_id, asset_id, position")
        .eq("org_id", orgId)
        .limit(CHARACTER_LIMITS.perOrg * CHARACTER_LIMITS.maxRefs),
    ]);
    const errors = [kits.error, chars.error, kitRefs.error, charRefs.error].filter(Boolean);
    if (errors.length) {
      return errors.some((e) => isMissingRelation(e)) ? EMPTY : { ...EMPTY, available: true, error: "read_failed" };
    }

    const refs: ReferenceRow[] = [
      ...coerceReferenceRows(kitRefs.data, "kit_id"),
      ...coerceReferenceRows(charRefs.data, "character_id"),
    ];
    const assets = await loadReferenceAssets(supabase, orgId, [...new Set(refs.map((r) => r.assetId))], opts);
    if (assets === null) return { ...EMPTY, available: true, error: "read_failed" };

    return {
      available: true,
      kits: coerceKits(kits.data, refs, assets),
      characters: coerceCharacters(chars.data, refs, assets),
    };
  } catch {
    return { ...EMPTY, available: true, error: "read_failed" };
  }
}

type Client = NonNullable<Awaited<ReturnType<typeof createClient>>>;

/** The live assets among `ids` (RLS: same org, not deleted), or null when a read failed. */
async function loadReferenceAssets(
  supabase: Client,
  orgId: string,
  ids: string[],
  opts: LoadOptions,
): Promise<Map<string, ReferenceAsset> | null> {
  const out = new Map<string, ReferenceAsset>();
  if (!ids.length) return out;
  const secret = opts.urls ? mediaUrlSecret() : null;
  const served = Boolean(opts.urls && mediaDir());
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { data, error } = await supabase.from("media_assets").select(MEDIA_ASSET_COLUMNS).eq("org_id", orgId).in("id", chunk);
    if (error) return null;
    for (const a of coerceAssets(data)) {
      const signed = withUrls(a, secret, served);
      out.set(a.id, { mime: a.mime, width: a.width, height: a.height, thumbUrl: signed.thumbUrl ?? signed.viewUrl });
    }
  }
  return out;
}
