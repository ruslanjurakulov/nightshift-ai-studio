import { NextResponse } from "next/server";
import { advanceRun } from "@/lib/workflows-operations";
import { workflowSession } from "@/lib/server/workflows";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { geoClaimHeaders } from "@/lib/server/geo-claim";
import { blockedCountriesOf } from "@/lib/geo/blocked";
import { isUuid } from "@/lib/creative/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Carry a run on (migration 0073): settle the step that finished and, if it
 * completed, create and hold the next one — as an ordinary creative job capped
 * at that step's confirmed price, under the member's own session. A step that
 * failed fails the run: later steps are skipped and were never held. A step
 * that cannot start yet because everything the plan may run at once is busy,
 * or credits are short, waits (0083): it holds nothing and the next call tries
 * again, until a day after the price was confirmed. Safe to
 * call as often as the run page likes (each step's job has the idempotency key
 * `wf:<run id>:<step>`). While nobody has the run open nothing starts and
 * nothing is held.
 */
export const POST = requireSameOrigin(async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const { id } = await params;
  // 0208: a later step's job is created here, and the database refuses one on a model with a country list unless this server
  // vouches for the country. Only a run with such a step is read for it, and only then is the country sent. A run that cannot be
  // read gets no claim: the database then refuses such a step, never runs it unchecked.
  let claim: Record<string, string> | undefined;
  if (isUuid(id)) {
    const read = await session.db.readRun(id);
    const steps = (read.data as { steps?: Array<{ model?: unknown }> } | null)?.steps ?? [];
    const models = steps.map((s) => (typeof s.model === "string" ? s.model : null)).filter((m): m is string => m !== null);
    // Not refused here: an advance also settles the step that finished, which must not wait for a page in an allowed country. The
    // database refuses only the gated step's new job (no claim, or a country on its list), and that step fails as any refused step.
    if (models.some((m) => blockedCountriesOf(m).length > 0)) claim = geoClaimHeaders(models, request.headers, session.userId);
  }
  const out = await advanceRun(session.db, id, claim);
  return NextResponse.json(out.body, { status: out.status });
});
