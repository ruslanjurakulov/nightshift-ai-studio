import { NextResponse } from "next/server";
import { quoteWorkflow } from "@/lib/workflows-operations";
import { workflowSession } from "@/lib/server/workflows";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What Run now would cost (migration 0073), before anything is held: POST
 * `{ inputs }`. Every step is priced by the database the way the Studio prices
 * it (the function behind /api/creative/quote) and the answer is each step's
 * price and ONE total — or `total: null` when any step cannot be priced, which
 * is never 0 and never runnable. Nothing is held or created.
 */
export const POST = requireSameOrigin(async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await workflowSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  let body: { inputs?: unknown } | null;
  try {
    body = (await parseJsonCapped(request)) as { inputs?: unknown } | null;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { id } = await params;
  const out = await quoteWorkflow(session.db, id, body?.inputs);
  return NextResponse.json(out.body, { status: out.status });
});
