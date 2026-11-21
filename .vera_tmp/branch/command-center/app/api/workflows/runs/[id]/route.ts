import { NextResponse } from "next/server";
import { getRun } from "@/lib/workflows-operations";
import { workflowSession } from "@/lib/server/workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One run and its steps, read through RLS and moved by nothing: another organization's run is a 404. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const { id } = await params;
  const out = await getRun(session.db, id);
  return NextResponse.json(out.body, { status: out.status });
}
