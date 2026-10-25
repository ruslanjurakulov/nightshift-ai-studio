import { NextResponse } from "next/server";
import { creativeSession, loadStudioModels } from "@/lib/server/creative";
import { readSourcePicture } from "@/lib/server/region-edit";
import { createClient } from "@/lib/supabase/server";
import { quoteRegions } from "@/lib/regionEdit/quote";
import { regionEditorEnabled } from "@/lib/regionEdit/flag";
import { parseRegionRequest, type RegionError } from "@/lib/regionEdit/request";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS: Record<RegionError, number> = {
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
};

/**
 * The price of a region edit, before anything is held (NIGHTSHIFT_REGION_EDITOR, default off: 404).
 *
 * POST `{ org_id?, source_asset_id, model, feather?, regions: [{ name, prompt, x, y, w, h }] }`. One ordinary `edit`
 * quote per region that has words, asked of the database (this route never computes a number), summed. A region
 * without words costs nothing and is reported as skipped. There is no default model: the one named must be a model
 * this member can buy that edits pictures, or the answer is `model_not_sellable`. Rectangles are checked against the
 * size the library recorded for the picture, and refused (not clamped) when outside it. Nothing is held, charged or run.
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
  const parsed = parseRegionRequest(body, session.defaultOrg);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, ...(parsed.detail ? { detail: parsed.detail } : {}) }, { status: STATUS[parsed.error] });
  }
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const source = await readSourcePicture(supabase, parsed.request.orgId, parsed.request.sourceAssetId);
  if (!source.ok) return NextResponse.json({ error: source.error }, { status: source.error === "failed" ? 502 : 422 });
  const models = await loadStudioModels();
  const out = await quoteRegions(session.db, parsed.request, models, source.size);
  return NextResponse.json(out.body, { status: out.status });
});
