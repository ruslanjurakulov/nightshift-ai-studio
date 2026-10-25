import { NextResponse } from "next/server";
import { createGeneration } from "@/lib/creative/operations";
import { creativeSession, loadStudioModels } from "@/lib/server/creative";
import { readSourcePicture } from "@/lib/server/region-edit";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/server/audit";
import { regionEditorEnabled } from "@/lib/regionEdit/flag";
import { insidePicture, parseRunRequest, regionsToRun, type RegionError } from "@/lib/regionEdit/request";
import { pickEditModel } from "@/lib/regionEdit/quote";
import { buildRunParams, paramsFit } from "@/lib/regionEdit/run";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS: Record<RegionError | "confirm_price" | "invalid_idempotency_key", number> = {
  not_found: 404,
  invalid_body: 400,
  org_required: 400,
  source_unavailable: 422,
  no_regions: 422,
  too_many_regions: 422,
  region_invalid: 422,
  region_too_small: 422,
  region_out_of_bounds: 422,
  no_prompt: 422,
  model_required: 422,
  model_not_sellable: 422,
  feather_invalid: 422,
  source_too_large: 422,
  params_too_large: 422,
  confirm_price: 400,
  invalid_idempotency_key: 400,
};

/**
 * Run a region edit (NIGHTSHIFT_REGION_EDITOR, default off: 404 and nothing is asked of the database).
 *
 * POST `{ org_id?, source_asset_id, model, feather?, regions: [{ name, prompt, x, y, w, h }], max_credits, idempotency_key }`
 * — a quote body plus the price the person confirmed and one key per press. This route writes ONE row and stops (CLAUDE.md
 * rule 3): `create_creative_job` (migration 0036, with 0126's regions) checks membership, that the model is sellable, prices
 * n regions as n edits, refuses a price above `max_credits`, holds that price and queues the job. The worker runs it, one
 * call per region on the ONE model named, and the database charges only the regions that were applied. Nothing is called
 * from here and nothing is charged here; the credits are held, not spent.
 *
 * Checked here first, so a refusal costs nothing: the rectangles against the size the LIBRARY recorded for the picture (a
 * region outside it is refused, never clamped), the picture being a live image of THIS organization, the named model being one
 * this member can buy that edits pictures (there is no default and no second choice), and that at least one region has words.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  if (!regionEditorEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const session = await creativeSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  let body: unknown;
  try {
    body = await parseJsonCapped(request);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = parseRunRequest(body, session.defaultOrg);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, ...(parsed.detail ? { detail: parsed.detail } : {}) }, { status: STATUS[parsed.error] });
  }
  const { request: req, maxCredits, idempotencyKey } = parsed.run;
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const source = await readSourcePicture(supabase, req.orgId, req.sourceAssetId);
  if (!source.ok) return NextResponse.json({ error: source.error }, { status: source.error === "failed" ? 502 : 422 });
  if (!insidePicture(req.regions, source.size)) return NextResponse.json({ error: "region_out_of_bounds" }, { status: 422 });
  if (regionsToRun(req.regions).length === 0) return NextResponse.json({ error: "no_prompt" }, { status: 422 });
  const picked = pickEditModel(await loadStudioModels(), req.model);
  if (!picked.ok) return NextResponse.json({ error: picked.error }, { status: 422 });
  const params = buildRunParams(picked.model, req.sourceAssetId, req.regions, req.feather);
  if (!paramsFit(params)) return NextResponse.json({ error: "params_too_large" }, { status: 422 });
  const out = await createGeneration(session.db, {
    orgId: req.orgId,
    capability: "edit",
    model: picked.model.id,
    params: params as unknown as Record<string, unknown>,
    mode: "exact",
    idempotencyKey,
    maxCredits,
  });
  if (out.status === 201) {
    const job = out.body.job as { id?: string; quoted_credits?: number };
    await logAudit({
      // The audit trail's list of actions is closed (migration 0087): a region edit is a generation, named so, and marked in its detail.
      action: "creative.generate",
      target: job.id,
      detail: { org_id: req.orgId, capability: "edit", region_edit: true, model: picked.model.id, regions: regionsToRun(req.regions).length,
                quoted_credits: job.quoted_credits ?? null, source_asset_id: req.sourceAssetId },
    });
  }
  return NextResponse.json(out.body, { status: out.status });
});
