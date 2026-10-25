import {
  quote,
  type CreativeDb,
  type CreativeResult,
} from "@/lib/creative/operations";
import { buildParams, effectiveQuality, modelsFor, type StudioModel } from "@/lib/creative/studio";
import { insidePicture, regionsToRun, type RegionRequest } from "@/lib/regionEdit/request";
import type { Size } from "@/lib/regionEdit/geometry";

/**
 * The price of a region edit, BEFORE anything runs: one generation unit of the chosen model per region that has
 * words (an ordinary `edit` quote asked of the database, nothing held), summed. A region without words is skipped
 * and costs nothing. If any one price cannot be worked out the whole quote is refused with that region's reason —
 * never a total built from a guess (CLAUDE.md rule 5).
 */

export interface RegionQuoteLine {
  index: number;
  name: string;
  credits: number;
}

export interface RegionQuote {
  model: string;
  feather: number;
  total: number;
  lines: RegionQuoteLine[];
  /** Positions of regions with no words: not run, not priced, not charged. */
  skipped: number[];
}

/** Credits may be fractional; summing them must not show float dust (0.1 + 0.2). */
export function sumCredits(values: readonly number[]): number {
  return Math.round(values.reduce((a, b) => a + b, 0) * 1e6) / 1e6;
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

/** The params of one region's `edit` quote: the original picture, this region's words, the model's own tier. */
export function regionEditParams(model: StudioModel, sourceAssetId: string, prompt: string) {
  return buildParams({
    capability: "edit",
    prompt,
    aspect: "1:1",
    duration: 5,
    sourceId: sourceAssetId,
    quality: effectiveQuality(model, null),
  });
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
  const answers = await Promise.all(
    run.map(({ region }) =>
      quote(db, {
        orgId: req.orgId,
        capability: "edit",
        model: picked.model.id,
        params: regionEditParams(picked.model, req.sourceAssetId, region.prompt),
        mode: "exact",
        idempotencyKey: null,
        maxCredits: null,
      }),
    ),
  );
  const lines: RegionQuoteLine[] = [];
  for (let i = 0; i < answers.length; i += 1) {
    const a = answers[i];
    const q = a.body.quote as { credits?: unknown } | undefined;
    if (a.status !== 200 || !q || typeof q.credits !== "number" || !Number.isFinite(q.credits) || q.credits < 0) {
      return fail(a.status === 200 ? 502 : a.status, typeof a.body.error === "string" ? a.body.error : "failed", { region: run[i].index });
    }
    lines.push({ index: run[i].index, name: run[i].region.name, credits: q.credits });
  }
  const out: RegionQuote = {
    model: picked.model.id,
    feather: req.feather,
    total: sumCredits(lines.map((l) => l.credits)),
    lines,
    skipped: req.regions.flatMap((r, i) => (r.prompt === "" ? [i] : [])),
  };
  return { status: 200, body: { quote: out } };
}
