import { NextResponse } from "next/server";
import { cancelRun } from "@/lib/workflows-operations";
import { workflowSession } from "@/lib/server/workflows";
import { requireSameOrigin } from "@/lib/server/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stop a run (migration 0073): steps not started are skipped (nothing was held
 * for them) and the step being made is cancelled if the provider has not
 * started on it — its hold is released in the same transaction — otherwise it
 * finishes and is charged like any generation.
 */
export const POST = requireSameOrigin(async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const { id } = await params;
  const out = await cancelRun(session.db, id);
  // The workflow.cancel audit row is written by cancel_workflow_run itself (migration 0226), for this route and every direct call
  // alike: one row per cancel, naming the person, never a second one from here.
  return NextResponse.json(out.body, { status: out.status });
});
