import { NextResponse } from "next/server";
import { cancelJob, getJob } from "@/lib/creative/operations";
import { creativeSession } from "@/lib/server/creative";
import { logAudit } from "@/lib/server/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One generation (migration 0036). GET reads it through RLS — another
 * organization's job is a 404, not a 403. POST `{ "action": "cancel" }`
 * stops a job the provider has not started, and the database releases its
 * credit hold in the same transaction; once the provider has it, 409
 * `not_cancellable` (it is already being paid for).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await creativeSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const { id } = await params;
  const out = await getJob(session.db, id);
  return NextResponse.json(out.body, { status: out.status });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await creativeSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  let body: { action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (body?.action !== "cancel") return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { id } = await params;
  const out = await cancelJob(session.db, id);
  if (out.status === 200 && out.body.already !== true)
    await logAudit({ action: "creative.cancel", target: id, detail: {} });
  return NextResponse.json(out.body, { status: out.status });
}
