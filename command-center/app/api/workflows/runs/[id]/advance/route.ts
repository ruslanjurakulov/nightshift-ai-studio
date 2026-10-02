import { NextResponse } from "next/server";
import { advanceRun } from "@/lib/workflows-operations";
import { workflowSession } from "@/lib/server/workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Carry a run on (migration 0073): settle the step that finished and, if it
 * completed, create and hold the next one — as an ordinary creative job capped
 * at that step's confirmed price, under the member's own session. A step that
 * failed fails the run: later steps are skipped and were never held. Safe to
 * call as often as the run page likes (each step's job has the idempotency key
 * `wf:<run id>:<step>`). While nobody has the run open nothing starts and
 * nothing is held.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const { id } = await params;
  const out = await advanceRun(session.db, id);
  return NextResponse.json(out.body, { status: out.status });
}
