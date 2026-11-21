import { NextResponse } from "next/server";
import { createGeneration, isUuid, listJobs, parseCapabilityFilter, parseGenerationInput } from "@/lib/creative/operations";
import { creativeSession } from "@/lib/server/creative";
import { logAudit } from "@/lib/server/audit";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";
import { blockedModelsHere, geoRefusal } from "@/lib/server/geo";
import { missingWords, sellableFor } from "@/lib/creative/route-around";

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
 * edit / i2v / upscale / remove_bg (migration 0046) name their input picture
 * as `params.source_asset_id`. The database refuses (422
 * `source_unavailable`) an id that is not a live image of THIS organization —
 * another organization's id answers exactly like one that does not exist —
 * before anything is held.
 *
 * A model whose vendor forbids the country this request comes from is refused
 * here, 451 `country_blocked`, before the database is called: nothing is quoted,
 * held or queued (docs/GEO_BLOCK.md). An unknown country is allowed (and logged).
 *
 * GET `?org_id=` lists the organization's newest jobs (RLS: its members);
 * `&capability=t2v,i2v` lists only those tools' jobs (a Studio desk's).
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const session = await creativeSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  let body: unknown;
  try {
    body = await parseJsonCapped(request);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = parseGenerationInput(body, session.defaultOrg, {
    requirePrice: true,
    idempotencyHeader: request.headers.get("idempotency-key"),
  });
  if (!parsed.ok) return NextResponse.json(parsed.result.body, { status: parsed.result.status });
  // A routed create names the model its quote picked (0075), so this one check covers every mode.
  const blocked = parsed.input.model ? geoRefusal(parsed.input.model, request.headers) : null;
  if (blocked) return NextResponse.json(blocked.body, { status: blocked.status });
  // Rule 6: refused before anything is held when the model needs words that were not sent (registry inputs.prompt_required).
  const words = await missingWords(session.db, parsed.input.capability, parsed.input.model, parsed.input.params);
  if (words) return NextResponse.json(words.body, { status: words.status });
  let input = parsed.input;
  if (input.mode !== "exact") {
    // A routed job can fail over to another model (0088), chosen by the database, which does not know the country. Where this
    // country forbids a model that could make this, the job runs the model the person confirmed and nothing else: `exact`
    // never fails over. A list that cannot be read takes the same, safe side.
    const forbidden = blockedModelsHere(request.headers);
    if (forbidden) {
      const sellable = await sellableFor(session.db, input.capability);
      if (!sellable || sellable.some((m) => forbidden(m.id))) input = { ...input, mode: "exact" };
    }
  }
  const out = await createGeneration(session.db, input);
  if (out.status === 201) {
    const job = out.body.job as { id?: string; quoted_credits?: number };
    await logAudit({
      action: "creative.generate",
      target: job.id,
      detail: { org_id: input.orgId, capability: input.capability, model: input.model,
                quoted_credits: job.quoted_credits ?? null,
                source_asset_id: typeof input.params.source_asset_id === "string"
                  ? input.params.source_asset_id : null },
    });
  }
  return NextResponse.json(out.body, { status: out.status });
});

export async function GET(request: Request) {
  const session = await creativeSession();
  if (!session.ok) return NextResponse.json(session.result.body, { status: session.result.status });
  const params = new URL(request.url).searchParams;
  const q = params.get("org_id");
  // ?capability=t2v,i2v — a Studio desk's tools only (RLS still decides which rows are visible).
  const only = parseCapabilityFilter(params.get("capability"));
  if (!only.ok) return NextResponse.json({ error: "invalid_params" }, { status: 400 });
  const out = await listJobs(session.db, isUuid(q) ? q : session.defaultOrg, 50, only.value);
  return NextResponse.json(out.body, { status: out.status });
}
