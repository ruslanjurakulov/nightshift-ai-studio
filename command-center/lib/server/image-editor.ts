import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_EDIT_PIXELS, isEditableMime } from "@/lib/imageEditor/state";

/**
 * The image editor's one server read, under the signed-in member's own client (RLS: their organizations' live library
 * rows and nothing else). No service key, nothing written, no provider.
 */
export interface EditableAsset {
  width: number;
  height: number;
  mime: string;
  name: string;
}

export type EditableRead =
  | { ok: true; asset: EditableAsset }
  | { ok: false; error: "not_found" | "unsupported_type" | "no_size" | "failed" }
  | { ok: false; error: "source_too_large"; megapixels: number };

/**
 * The picture an edit starts from: a live IMAGE of THIS organization, with the size the library recorded. Another
 * organization's picture, a deleted one and a made-up id all read exactly like a missing one ("not_found").
 */
export async function readEditableAsset(supabase: SupabaseClient, orgId: string, assetId: string): Promise<EditableRead> {
  const { data, error } = await supabase
    .from("media_assets")
    .select("org_id, kind, mime, width, height, original_name")
    .eq("id", assetId)
    // RLS already hides a deleted file; this keeps it hidden if that policy ever changes.
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { ok: false, error: "failed" };
  const row = data as { org_id?: unknown; kind?: unknown; mime?: unknown; width?: unknown; height?: unknown; original_name?: unknown } | null;
  if (!row || row.org_id !== orgId || row.kind !== "image") return { ok: false, error: "not_found" };
  if (!isEditableMime(row.mime)) return { ok: false, error: "unsupported_type" };
  const w = row.width;
  const h = row.height;
  if (typeof w !== "number" || typeof h !== "number" || !(w > 0) || !(h > 0)) return { ok: false, error: "no_size" };
  // Same idea as the region editor's ceiling: say so now, before a canvas of this size is even tried.
  if (w * h > MAX_EDIT_PIXELS) return { ok: false, error: "source_too_large", megapixels: Math.round((w * h) / 100_000) / 10 };
  return { ok: true, asset: { width: w, height: h, mime: String(row.mime).toLowerCase(), name: typeof row.original_name === "string" ? row.original_name : "" } };
}
