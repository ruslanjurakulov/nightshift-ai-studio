import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCreativeMissing } from "@/lib/creative/operations";
import { MAX_CHAIN, coerceVersionRows, type VersionRow } from "@/lib/regionEdit/versions";
import { MAX_SOURCE_PIXELS, type Size } from "@/lib/regionEdit/geometry";

/**
 * The region editor's two reads, both under the signed-in member's own client (RLS: their organizations' live
 * library rows and nothing else). No service key, no provider, nothing written.
 */

export type SourceRead = { ok: true; size: Size } | { ok: false; error: "source_unavailable" | "source_too_large" | "failed" };

/**
 * The picture a region edit starts from: a live IMAGE of THIS organization, with the size the library recorded for it.
 * The size is the library's, never the browser's claim, so a rectangle is checked against the real picture.
 */
export async function readSourcePicture(supabase: SupabaseClient, orgId: string, assetId: string): Promise<SourceRead> {
  const { data, error } = await supabase.from("media_assets").select("org_id, kind, width, height").eq("id", assetId).maybeSingle();
  if (error) return { ok: false, error: "failed" };
  const row = data as { org_id?: unknown; kind?: unknown; width?: unknown; height?: unknown } | null;
  // Another organization's picture reads exactly like a missing one.
  if (!row || row.org_id !== orgId || row.kind !== "image") return { ok: false, error: "source_unavailable" };
  const w = row.width;
  const h = row.height;
  if (typeof w !== "number" || typeof h !== "number" || w <= 0 || h <= 0) return { ok: false, error: "source_unavailable" };
  // The worker refuses more pixels than this (memory); say so now, before anything is held.
  if (w * h > MAX_SOURCE_PIXELS) return { ok: false, error: "source_too_large" };
  return { ok: true, size: { width: w, height: h } };
}

const COLUMNS = "id, parent_asset_id, version, created_at, width, height";

export type VersionsRead = { ok: true; rows: VersionRow[] } | { ok: false; error: "unavailable" | "failed" };

/**
 * The rows around one picture: its ancestors up to the original and the newest child at each step downward (at most
 * MAX_CHAIN each way). A read that fails says so; an empty answer is never presented as "no versions".
 */
export async function readVersionRows(supabase: SupabaseClient, assetId: string): Promise<VersionsRead> {
  const byId = async (id: string): Promise<VersionRow | undefined> => {
    const { data, error } = await supabase.from("media_assets").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) throw error;
    return coerceVersionRows(data ? [data] : [])[0];
  };
  const newestChild = async (id: string): Promise<VersionRow | undefined> => {
    const { data, error } = await supabase
      .from("media_assets")
      .select(COLUMNS)
      .eq("parent_asset_id", id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    return coerceVersionRows(data)[0];
  };
  try {
    const start = await byId(assetId);
    if (!start) return { ok: true, rows: [] };
    const rows: VersionRow[] = [start];
    const seen = new Set<string>([start.id]);
    for (let at = start, n = 0; at.parentId && n < MAX_CHAIN; n += 1) {
      const parent = await byId(at.parentId);
      if (!parent || seen.has(parent.id)) break;
      rows.push(parent);
      seen.add(parent.id);
      at = parent;
    }
    for (let at = start, n = 0; n < MAX_CHAIN; n += 1) {
      const kid = await newestChild(at.id);
      if (!kid || seen.has(kid.id)) break;
      rows.push(kid);
      seen.add(kid.id);
      at = kid;
    }
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: isCreativeMissing(e as { code?: string; message?: string }) ? "unavailable" : "failed" };
  }
}
