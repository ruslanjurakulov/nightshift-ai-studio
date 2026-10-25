import { quote, type CreativeDb, type CreativeResult } from "@/lib/creative/operations";
import { modelsFor, type StudioModel } from "@/lib/creative/studio";
import { insidePicture, regionsToRun, type RegionRequest } from "@/lib/regionEdit/request";
import { buildRunParams, regionShare } from "@/lib/regionEdit/run";
import type { Size } from "@/lib/regionEdit/geometry";

/**
 * The price of a region edit, BEFORE anything runs (migration 0126): ONE ordinary `edit` quote asked of the database for the
 * very params the run will send — the picture, the model's tier and every region that has words — so the number shown is the
 * number that will be held, by construction (the database prices n regions as n edits by the model). A region without words is
 * skipped and costs nothing. If the price cannot be worked out the whole quote is refused with the database's reason, never a
 * total built from a guess (CLAUDE.md rule 5). Nothing is held, charged or run.
 */

export interface RegionQuote {
  model: string;
  feather: number;
  /** The most this edit can cost: every region applied. The database holds exactly this. */
  total: number;
  /** How many regions will run (those with words). */
  count: number;
  /** The share of the price one region carries: only a region that is applied is charged its share. */
  perRegion: number;
  /** Positions of regions with no words: not run, not priced, not charged. */
  skipped: number[];
}

/** The models a region edit may use: those the database lets this member buy that can edit pictures. */
export function editModels(models: readonly StudioModel[]): StudioModel[] {
  return modelsFor([...models], "edit");
}

/** The named model, or why not. There is no default and no second choice (rule 4). */
export function pickEditModel(models: readonly StudioModel[], id: string): { ok: true; model: StudioModel } | { ok: false; error: "model_required" | "model_not_sellable" } {
  if (!id) return { ok: false, error: "model_required" };
  const hit = editModels(models).find((m) => m.id === id);
  return hit ? { ok: true, model: hit } : { ok: false, error: "model_not_sellable" };
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): CreativeResult => ({ status, body: { error, ...extra } });

export async function quoteRegions(
  db: CreativeDb,
  req: RegionRequest,
  models: readonly StudioModel[],
  size: Size,
): Promise<CreativeResult> {
  if (!insidePicture(req.regions, size)) return fail(422, "region_out_of_bounds");
  const run = regionsToRun(req.regions);
  if (run.length === 0) return fail(422, "no_prompt");
  const picked = pickEditModel(models, req.model);
  if (!picked.ok) return fail(422, picked.error);
  const answer = await quote(db, {
    orgId: req.orgId,
    capability: "edit",
    model: picked.model.id,
    params: buildRunParams(picked.model, req.sourceAssetId, req.regions, req.feather) as unknown as Record<string, unknown>,
    mode: "exact",
    idempotencyKey: null,
    maxCredits: null,
  });
  const q = answer.body.quote as { credits?: unknown } | undefined;
  if (answer.status !== 200 || !q || typeof q.credits !== "number" || !Number.isFinite(q.credits) || q.credits < 0) {
    return fail(answer.status === 200 ? 502 : answer.status, typeof answer.body.error === "string" ? answer.body.error : "failed");
  }
  const out: RegionQuote = {
    model: picked.model.id,
    feather: req.feather,
    total: q.credits,
    count: run.length,
    perRegion: regionShare(q.credits, run.length),
    skipped: req.regions.flatMap((r, i) => (r.prompt === "" ? [i] : [])),
  };
  return { status: 200, body: { quote: out } };
}
