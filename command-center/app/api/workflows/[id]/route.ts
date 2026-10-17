import { NextResponse } from "next/server";
import { deleteWorkflow, parseSaveInput, saveWorkflow } from "@/lib/workflows-operations";
import { workflowSession } from "@/lib/server/workflows";
import { logAudit } from "@/lib/server/audit";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped, LARGE_JSON_BODY_BYTES } from "@/lib/server/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Change a saved workflow (migration 0073): PATCH `{ name, inputs, steps }`
 * replaces the definition and raises its version. A price quoted for the old
 * version cannot be run: "Run now" carries the version it was quoted for.
 * Another organization's workflow reads as missing (404).
 */
export const PATCH = requireSameOrigin(async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  let body: unknown;
  try {
    body = await parseJsonCapped(request, LARGE_JSON_BODY_BYTES);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = parseSaveInput(body, session.defaultOrg);
  if (!parsed.ok) return NextResponse.json(parsed.result.body, { status: parsed.result.status });
  const { id } = await params;
  const out = await saveWorkflow(session.db, parsed.input, id);
  if (out.status === 200) await logAudit({ action: "workflow.save", target: id, detail: { steps: parsed.input.steps.length } });
  return NextResponse.json(out.body, { status: out.status });
});

/** Remove a workflow from the list. Its runs keep the definition they were started with. */
export const DELETE = requireSameOrigin(async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const { id } = await params;
  const out = await deleteWorkflow(session.db, id);
  if (out.status === 200) await logAudit({ action: "workflow.delete", target: id, detail: {} });
  return NextResponse.json(out.body, { status: out.status });
});
