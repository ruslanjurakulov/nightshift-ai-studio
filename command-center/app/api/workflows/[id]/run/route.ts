import { NextResponse } from "next/server";
import { parseRunInput, startRun } from "@/lib/workflows-operations";
import { workflowSession } from "@/lib/server/workflows";
import { logAudit } from "@/lib/server/audit";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";
import { geoRefusalAny } from "@/lib/server/geo";
import { coerceWorkflow } from "@/lib/workflows";
import { isUuid } from "@/lib/creative/operations";
import { BLOCKED_COUNTRIES } from "@/lib/geo/blocked";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Run now (migration 0073): POST `{ run_id, version, inputs, max_credits }`.
 *
 * `max_credits` is the ONE total the member confirmed and is required; the
 * database prices every step again and refuses (409 `price_changed`) unless
 * the confirmed total is the total now, and refuses (422 `unpriced`) when any
 * step has no price. Only the first step is created and held here, as an
 * ordinary creative job capped at its own confirmed price; each later step is
 * created and held when the one before it has completed (see
 * /api/workflows/runs/[id]/advance). `run_id` is this press's replay token: a
 * second press answers the first run (200) instead of holding anything twice.
 * Nothing in a workflow publishes.
 */
export const POST = requireSameOrigin(async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  let body: unknown;
  try {
    body = await parseJsonCapped(request);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = parseRunInput(body);
  if (!parsed.ok) return NextResponse.json(parsed.result.body, { status: parsed.result.status });
  const { id } = await params;
  // A step whose model this request's country forbids (docs/GEO_BLOCK.md): refused before the database prices or holds anything.
  // The workflow is read only once a model has a country list. The steps checked must be the ones that will run: the database
  // starts only the version the body names (0073: `workflow_changed` otherwise), so the version read here must be that one. An edit
  // after this read raises the version and the database refuses the run; one before it is what is checked. A workflow that cannot
  // be read is refused here, never passed on unchecked.
  if (Object.keys(BLOCKED_COUNTRIES).length > 0 && isUuid(id)) {
    const read = await session.db.readWorkflow(id);
    if (read.error) return NextResponse.json({ error: "failed" }, { status: 502 });
    const wf = coerceWorkflow(read.data);
    if (!wf) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (wf.version !== parsed.input.version) return NextResponse.json({ error: "workflow_changed" }, { status: 409 });
    const blocked = geoRefusalAny(wf.steps.map((s) => s.model), request.headers);
    if (blocked) return NextResponse.json(blocked.body, { status: blocked.status });
  }
  const out = await startRun(session.db, id, parsed.input);
  if (out.status === 201)
    await logAudit({ action: "workflow.run", target: parsed.input.runId, detail: { workflow_id: id, max_credits: parsed.input.maxCredits } });
  return NextResponse.json(out.body, { status: out.status });
});
