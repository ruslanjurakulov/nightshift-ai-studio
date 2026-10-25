import { isUuid } from "@/lib/creative/operations";
import {
  DEFAULT_FEATHER,
  MAX_REGIONS,
  MIN_REGION_PX,
  NAME_MAX,
  PROMPT_MAX,
  cleanLine,
  isFeather,
  type Size,
  type WireRegion,
} from "@/lib/regionEdit/geometry";

/**
 * The region-edit request, checked before anything is priced or held. Strict like modules/region_edit.parse_regions:
 * a rectangle outside the picture is REFUSED, never clamped (the browser clamps what the person draws; the server does
 * not guess what they meant), and an unknown field is refused rather than dropped.
 */
export const REGION_ERRORS = [
  "not_found",
  "invalid_body",
  "org_required",
  "source_unavailable",
  "no_regions",
  "too_many_regions",
  "region_invalid",
  "region_too_small",
  "region_out_of_bounds",
  "no_prompt",
  "model_required",
  "model_not_sellable",
  "feather_invalid",
] as const;
export type RegionError = (typeof REGION_ERRORS)[number];

export interface RegionRequest {
  orgId: string;
  sourceAssetId: string;
  model: string;
  feather: number;
  regions: WireRegion[];
}

export type Parsed = { ok: true; request: RegionRequest } | { ok: false; error: RegionError; detail?: string };

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);

export function parseRegionRequest(body: unknown, defaultOrg: string | null): Parsed {
  const b = obj(body);
  if (!b) return { ok: false, error: "invalid_body" };
  const allowed = ["org_id", "source_asset_id", "model", "feather", "regions"];
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) return { ok: false, error: "invalid_body", detail: `unknown field(s): ${extra.join(", ")}` };
  const orgId = b.org_id == null ? defaultOrg : b.org_id;
  if (!isUuid(orgId)) return { ok: false, error: "org_required" };
  if (!isUuid(b.source_asset_id)) return { ok: false, error: "source_unavailable" };
  const model = typeof b.model === "string" ? b.model.trim().toLowerCase() : "";
  // There is no default model (CLAUDE.md rule 4): none named is a refusal, not a pick.
  if (!model) return { ok: false, error: "model_required" };
  if (!MODEL_RE.test(model)) return { ok: false, error: "model_not_sellable" };
  const feather = b.feather === undefined ? DEFAULT_FEATHER : b.feather;
  if (!isFeather(feather)) return { ok: false, error: "feather_invalid" };
  if (!Array.isArray(b.regions) || b.regions.length === 0) return { ok: false, error: "no_regions" };
  if (b.regions.length > MAX_REGIONS) return { ok: false, error: "too_many_regions" };
  const regions: WireRegion[] = [];
  for (const raw of b.regions) {
    const r = obj(raw);
    if (!r || !isInt(r.x) || !isInt(r.y) || !isInt(r.w) || !isInt(r.h)) return { ok: false, error: "region_invalid" };
    if (r.w < MIN_REGION_PX || r.h < MIN_REGION_PX) return { ok: false, error: "region_too_small" };
    regions.push({
      name: cleanLine(r.name, NAME_MAX) || `Region ${regions.length + 1}`,
      prompt: cleanLine(r.prompt, PROMPT_MAX),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
    });
  }
  return { ok: true, request: { orgId, sourceAssetId: b.source_asset_id, model, feather, regions } };
}

/** Every rectangle fully inside the picture (`size` is what the library recorded for it, never the browser's claim). */
export function insidePicture(regions: readonly WireRegion[], size: Size): boolean {
  return regions.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= size.width && r.y + r.h <= size.height);
}

/** The regions that will run: the ones with words. None is a refusal (nothing to price, nothing to charge). */
export function regionsToRun(regions: readonly WireRegion[]): { index: number; region: WireRegion }[] {
  return regions.flatMap((region, index) => (region.prompt !== "" ? [{ index, region }] : []));
}
