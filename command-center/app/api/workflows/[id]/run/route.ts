import { NextResponse } from "next/server";
import { parseRunInput, startRun } from "@/lib/workflows-operations";
import { workflowSession } from "@/lib/server/workflows";
import { logAudit } from "@/lib/server/audit";

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
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = parseRunInput(body);
  if (!parsed.ok) return NextResponse.json(parsed.result.body, { status: parsed.result.status });
  const { id } = await params;
  const out = await startRun(session.db, id, parsed.input);
  if (out.status === 201)
    await logAudit({ action: "workflow.run", target: parsed.input.runId, detail: { workflow_id: id, max_credits: parsed.input.maxCredits } });
  return NextResponse.json(out.body, { status: out.status });
}
