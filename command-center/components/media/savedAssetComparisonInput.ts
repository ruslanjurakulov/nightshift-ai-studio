import { parseMediaId, type LibraryAsset } from "@/lib/media";

/** Structurally matches NS-404 ComparisonAsset; no renderer or lineage discovery here. */
export type ComparisonInput = Readonly<Pick<LibraryAsset, "id" | "name" | "version"> & { previewUrl: string | null }>;
export type ComparisonInputResult =
  | { ok: true; left: ComparisonInput; right: ComparisonInput; lineage: "unknown" }
  | { ok: false; error: "invalid_pair" | "missing_asset" | "not_image" | "invalid_version" | "invalid_origin" };

function preview(raw: unknown, id: string, origin: string): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) return null;
    // Accept existing same-origin image routes, without checking signatures or reading bytes.
    if (!["original", "display", "thumb"].some((variant) => url.pathname === `/api/media/file/${id}/${variant}`)) return null;
    return value;
  } catch { return null; }
}

/** Explicit pair order is retained; caller supplies full rows, not picker projections. */
export function savedAssetComparisonInput(assets: readonly LibraryAsset[], ids: readonly string[], origin: string): ComparisonInputResult {
  if (ids.length !== 2 || ids[0] === ids[1] || !ids.every((id) => parseMediaId(id))) return { ok: false, error: "invalid_pair" };
  try {
    const base = new URL(origin);
    if (!["http:", "https:"].includes(base.protocol) || base.origin !== origin) return { ok: false, error: "invalid_origin" };
  } catch { return { ok: false, error: "invalid_origin" }; }
  const rows = ids.map((id) => assets.find((asset) => asset.id === id));
  const [left, right] = rows;
  if (!left || !right) return { ok: false, error: "missing_asset" };
  if (left.kind !== "image" || right.kind !== "image") return { ok: false, error: "not_image" };
  if ([left, right].some((asset) => !Number.isSafeInteger(asset.version) || asset.version < 1)) return { ok: false, error: "invalid_version" };
  const adapt = (asset: LibraryAsset): ComparisonInput => ({
    id: asset.id,
    name: typeof asset.name === "string" && asset.name.trim() ? asset.name : null,
    version: asset.version,
    previewUrl: preview(asset.viewUrl, asset.id, origin) ?? preview(asset.thumbUrl, asset.id, origin),
  });
  // A reported version1 may already be a coerceAssets fallback; never claim a root or relationship.
  return { ok: true, left: adapt(left), right: adapt(right), lineage: "unknown" };
}
