import { effectiveQuality, type StudioModel } from "@/lib/creative/studio";
import { regionsToRun } from "@/lib/regionEdit/request";
import { DEFAULT_FEATHER, MAX_PARAMS_BYTES, type WireRegion } from "@/lib/regionEdit/geometry";

/**
 * The run step of the region editor (migration 0126, docs/REGION_EDITOR.md): what a region edit asks of the database, and how a
 * finished job is read back. Pure, so it is tested without a database.
 *
 * A region edit is an ordinary `edit` creative job whose params carry the regions. The database prices it (n regions = n edits by
 * the chosen model), holds that price, and — when the worker has run every region — charges ONLY the regions that were applied and
 * releases the rest. Nothing here computes a price or a charge: it only shows what the database recorded.
 */

/** Why a region was not applied: the closed list the worker reports and the database accepts (creative_region_outcomes). */
export const REGION_REASONS = [
  "not_configured",
  "auth",
  "quota",
  "rate_limited",
  "bad_request",
  "policy",
  "not_found",
  "unavailable",
  "bad_response",
  "provider_error",
  "region_invalid",
  "region_too_small",
  "region_out_of_bounds",
  "crop_unavailable",
  "pixel_lock_failed",
] as const;
export type RegionReason = (typeof REGION_REASONS)[number];

export const REGION_STATUSES = ["applied", "failed", "refused"] as const;
export type RegionStatus = (typeof REGION_STATUSES)[number];

/** Why a job ended without a picture, beyond the per-region reasons: the worker's job-level codes that this screen words. */
export const RUN_FAILURES = [
  "no_region_applied",
  "region_editor_off",
  "mode_not_supported",
  "model_not_available",
  "model_cannot_edit",
  "model_gated",
  "model_unknown",
  "adapter_missing",
  "capability_not_supported",
  "library_unavailable",
  "source_unavailable",
  "source_too_large",
  "result_not_stored",
  "output_lost",
  "region_quote_mismatch",
  "not_picked_up",
  "submit_interrupted",
  "worker_lost",
  "cancelled",
] as const;
export type RunFailure = (typeof RUN_FAILURES)[number];

const isReason = (v: unknown): v is RegionReason => typeof v === "string" && (REGION_REASONS as readonly string[]).includes(v);
const isStatus = (v: unknown): v is RegionStatus => typeof v === "string" && (REGION_STATUSES as readonly string[]).includes(v);
const isFailure = (v: unknown): v is RunFailure => typeof v === "string" && (RUN_FAILURES as readonly string[]).includes(v);

export interface RunRegionParam {
  id: string;
  name: string;
  prompt: string;
  rect: { x: number; y: number; w: number; h: number };
}

export interface RunParams {
  source_asset_id: string;
  quality?: string;
  regions: RunRegionParam[];
  region_feather: number;
}

/**
 * The params of the creative job for these regions: the picture, the model's own tier (the one its price is by, or none),
 * the regions that have words — each with an id r1, r2, ... in order — and the edge blend. Nothing else is sent (the database
 * refuses any other key next to `regions`), and no prompt of its own: each region carries its words.
 */
export function buildRunParams(model: StudioModel, sourceAssetId: string, regions: readonly WireRegion[], feather: number = DEFAULT_FEATHER): RunParams {
  const quality = effectiveQuality(model, null);
  return {
    source_asset_id: sourceAssetId,
    ...(quality ? { quality } : {}),
    regions: regionsToRun(regions).map(({ region }, i) => ({
      id: `r${i + 1}`,
      name: region.name,
      prompt: region.prompt,
      rect: { x: region.x, y: region.y, w: region.w, h: region.h },
    })),
    region_feather: feather,
  };
}

// ── reading a job back ───────────────────────────────────────────────────────

export type RunPhase = "queued" | "running" | "completed" | "failed" | "cancelled" | "expired";

export interface RegionResult {
  id: string;
  name: string;
  /** null while the worker has not reported (the job is still running, or ended before any region was tried). */
  status: RegionStatus | null;
  reason: RegionReason | null;
}

export interface RunView {
  id: string;
  phase: RunPhase;
  /** The credits held for the whole job (the quote) and what was charged; null charged = not settled yet. */
  held: number;
  charged: number | null;
  /** What was given back: held - charged, only once the job is settled. */
  released: number | null;
  regions: RegionResult[];
  appliedCount: number;
  resultAssetId: string | null;
  sourceAssetId: string | null;
  /** A job-level failure the screen has a sentence for, or the raw code when it has none (shown generically). */
  failure: RunFailure | "other" | null;
  errorCode: string | null;
}

const FINAL: readonly RunPhase[] = ["completed", "failed", "cancelled", "expired"];
export const isFinalPhase = (p: RunPhase): boolean => FINAL.includes(p);

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

function phaseOf(status: unknown): RunPhase | null {
  switch (status) {
    case "queued":
      return "queued";
    case "planning":
    case "running":
    case "provider_pending":
    case "processing":
    case "rendering":
      return "running";
    case "completed":
    case "failed":
    case "cancelled":
    case "expired":
      return status;
  }
  return null;
}

/**
 * A creative_jobs row (as /api/creative/jobs/[id] returns it) read as a region edit, or null when it is not one. Unknown is never
 * made up: a status the worker did not report stays `null`, a reason outside the closed list reads as `provider_error`.
 */
export function toRunView(job: unknown): RunView | null {
  const j = obj(job);
  if (!j || typeof j.id !== "string" || j.capability !== "edit") return null;
  const params = obj(j.params);
  const asked = Array.isArray(params?.regions) ? (params!.regions as unknown[]) : null;
  const phase = phaseOf(j.status);
  if (!params || !asked || !phase) return null;
  const result = obj(j.result);
  const reported = new Map<string, { status: RegionStatus | null; reason: RegionReason | null }>();
  for (const raw of Array.isArray(result?.regions) ? (result!.regions as unknown[]) : []) {
    const r = obj(raw);
    if (!r || typeof r.id !== "string") continue;
    reported.set(r.id, { status: isStatus(r.status) ? r.status : null, reason: r.status === "applied" ? null : isReason(r.code) ? r.code : "provider_error" });
  }
  const regions: RegionResult[] = asked.flatMap((raw, i) => {
    const r = obj(raw);
    if (!r || typeof r.id !== "string") return [];
    const got = reported.get(r.id);
    return [{ id: r.id, name: typeof r.name === "string" && r.name ? r.name : `#${i + 1}`, status: got?.status ?? null, reason: got?.reason ?? null }];
  });
  const held = num(j.quoted_credits) ?? 0;
  const final = isFinalPhase(phase);
  const charged = final ? (num(j.charged_credits) ?? 0) : null;
  const ids = Array.isArray(j.result_asset_ids) ? (j.result_asset_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const code = typeof j.error_code === "string" && j.error_code ? j.error_code : null;
  return {
    id: j.id,
    phase,
    held,
    charged,
    released: charged === null ? null : Math.max(0, Math.round((held - charged) * 100) / 100),
    regions,
    appliedCount: regions.filter((r) => r.status === "applied").length,
    resultAssetId: phase === "completed" ? (ids[0] ?? null) : null,
    sourceAssetId: typeof params.source_asset_id === "string" ? params.source_asset_id : null,
    failure: phase === "completed" ? null : phase === "cancelled" ? "cancelled" : code === null ? null : isFailure(code) ? code : "other",
    errorCode: code,
  };
}

/**
 * The size of `params` as the database stores it: jsonb text, which is JSON with a space after every `:` and `,` outside a string,
 * counted in bytes (UTF-8). The database refuses a job whose params are over 16 KB ("params are too large"); words in a script that
 * takes 3 bytes a letter (Chinese, Japanese, Korean) reach that long within five regions of 1000 characters, so the page says so first and clearly.
 */
export function jsonbTextBytes(value: unknown): number {
  const json = JSON.stringify(value);
  let extra = 0;
  let inString = false;
  for (let i = 0; i < json.length; i += 1) {
    const c = json[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === ":" || c === ",") extra += 1;
  }
  return new TextEncoder().encode(json).length + extra;
}

/** Do these params fit in what the database stores? */
export function paramsFit(params: unknown): boolean {
  return jsonbTextBytes(params) <= MAX_PARAMS_BYTES;
}
