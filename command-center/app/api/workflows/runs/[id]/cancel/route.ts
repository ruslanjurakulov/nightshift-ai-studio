import { NextResponse } from "next/server";
import { cancelRun } from "@/lib/workflows-operations";
import { workflowSession } from "@/lib/server/workflows";
import { logAudit } from "@/lib/server/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stop a run (migration 0073): steps not started are skipped (nothing was held
 * for them) and the step being made is cancelled if the provider has not
 * started on it — its hold is released in the same transaction — otherwise it
 * finishes and is charged like any generation.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const { id } = await params;
  const out = await cancelRun(session.db, id);
  if (out.status === 200) await logAudit({ action: "workflow.cancel", target: id, detail: {} });
  return NextResponse.json(out.body, { status: out.status });
}
