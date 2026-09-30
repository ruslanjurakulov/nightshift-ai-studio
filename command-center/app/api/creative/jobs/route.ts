import { NextResponse } from "next/server";
import { createGeneration, isUuid, listJobs, parseGenerationInput } from "@/lib/creative/operations";
import { creativeSession } from "@/lib/server/creative";
import { logAudit } from "@/lib/server/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a generation (migration 0036).
 *
 * POST `{ org_id?, capability, model, params, mode?, idempotency_key?,
 * max_credits }` (or an `Idempotency-Key` header). One database transaction,
 * under the signed-in user's session: membership, the model being sellable,
 * the price, the credit hold (= the quote) and the queued job. `max_credits`
 * is the price the member confirmed; a higher one is refused, never charged.
 * A replayed key answers the first job (200) instead of paying twice.
 *
 * GET `?org_id=` lists the organization's newest jobs (RLS: its members).
 */
export async function POST(request: Request) {
  const session = await creativeSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = parseGenerationInput(body, session.defaultOrg, {
    requirePrice: true,
    idempotencyHeader: request.headers.get("idempotency-key"),
  });
  if (!parsed.ok) return NextResponse.json(parsed.result.body, { status: parsed.result.status });
  const out = await createGeneration(session.db, parsed.input);
  if (out.status === 201) {
    const job = out.body.job as { id?: string; quoted_credits?: number };
    await logAudit({
      action: "creative.generate",
      target: job.id,
      detail: { org_id: parsed.input.orgId, capability: parsed.input.capability, model: parsed.input.model,
                quoted_credits: job.quoted_credits ?? null },
    });
  }
  return NextResponse.json(out.body, { status: out.status });
}

export async function GET(request: Request) {
  const session = await creativeSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const q = new URL(request.url).searchParams.get("org_id");
  const out = await listJobs(session.db, isUuid(q) ? q : session.defaultOrg);
  return NextResponse.json(out.body, { status: out.status });
}
