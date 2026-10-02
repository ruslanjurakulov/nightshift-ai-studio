import { NextResponse } from "next/server";
import { isUuid } from "@/lib/creative/operations";
import { parseSaveInput, saveWorkflow } from "@/lib/workflows-operations";
import { loadWorkflows, workflowSession } from "@/lib/server/workflows";
import { logAudit } from "@/lib/server/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Save a new workflow (migration 0073): POST `{ org_id?, name, inputs, steps }`.
 * Saving costs nothing and runs nothing — a workflow is a definition. The
 * database checks the member may edit, and checks every step the way the
 * Studio checks a generation; a definition that could not run is refused here
 * and now, not at "Run now".
 *
 * GET `?org_id=` lists the organization's workflows (RLS: its members).
 */
export async function POST(request: Request) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = parseSaveInput(body, session.defaultOrg);
  if (!parsed.ok) return NextResponse.json(parsed.result.body, { status: parsed.result.status });
  const out = await saveWorkflow(session.db, parsed.input, null);
  if (out.status === 201) {
    const wf = out.body.workflow as { id?: string };
    await logAudit({ action: "workflow.save", target: wf.id, detail: { org_id: parsed.input.orgId, steps: parsed.input.steps.length } });
  }
  return NextResponse.json(out.body, { status: out.status });
}

export async function GET(request: Request) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const q = new URL(request.url).searchParams.get("org_id");
  const orgId = isUuid(q) ? q : session.defaultOrg;
  if (!isUuid(orgId)) return NextResponse.json({ error: "org_required" }, { status: 400 });
  const read = await loadWorkflows(orgId);
  if (read.state === "not_available") return NextResponse.json({ error: "workflows_unavailable" }, { status: 503 });
  if (read.state !== "ok") return NextResponse.json({ error: "failed" }, { status: 502 });
  return NextResponse.json({ workflows: read.value });
}
