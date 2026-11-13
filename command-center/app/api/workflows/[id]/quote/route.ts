import { NextResponse } from "next/server";
import { quoteWorkflow } from "@/lib/workflows-operations";
import { workflowSession } from "@/lib/server/workflows";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";
import { geoRefusalAny } from "@/lib/server/geo";
import { coerceWorkflow } from "@/lib/workflows";
import { isUuid } from "@/lib/creative/operations";
import { BLOCKED_COUNTRIES } from "@/lib/geo/blocked";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What Run now would cost (migration 0073), before anything is held: POST
 * `{ inputs }`. Every step is priced by the database the way the Studio prices
 * it (the function behind /api/creative/quote) and the answer is each step's
 * price and ONE total — or `total: null` when any step cannot be priced, which
 * is never 0 and never runnable. Nothing is held or created.
 */
export const POST = requireSameOrigin(async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  let body: { inputs?: unknown } | null;
  try {
    body = (await parseJsonCapped(request)) as { inputs?: unknown } | null;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { id } = await params;
  // A step whose model this request's country forbids (docs/GEO_BLOCK.md): refused before the database prices or holds anything.
  // The workflow is read only once a model has a country list; one that cannot be read is the database's to refuse below.
  if (Object.keys(BLOCKED_COUNTRIES).length > 0 && isUuid(id)) {
    const wf = coerceWorkflow((await session.db.readWorkflow(id)).data);
    const blocked = wf ? geoRefusalAny(wf.steps.map((s) => s.model), request.headers) : null;
    if (blocked) return NextResponse.json(blocked.body, { status: blocked.status });
  }
  const out = await quoteWorkflow(session.db, id, body?.inputs);
  return NextResponse.json(out.body, { status: out.status });
});
