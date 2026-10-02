import { NextResponse } from "next/server";
import { quoteWorkflow } from "@/lib/workflows-operations";
import { workflowSession } from "@/lib/server/workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What Run now would cost (migration 0073), before anything is held: POST
 * `{ inputs }`. Every step is priced by the database the way the Studio prices
 * it (the function behind /api/creative/quote) and the answer is each step's
 * price and ONE total — or `total: null` when any step cannot be priced, which
 * is never 0 and never runnable. Nothing is held or created.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  let body: { inputs?: unknown } | null;
  try {
    body = (await request.json()) as { inputs?: unknown } | null;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { id } = await params;
  const out = await quoteWorkflow(session.db, id, body?.inputs);
  return NextResponse.json(out.body, { status: out.status });
}
