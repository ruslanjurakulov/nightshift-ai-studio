import { NextResponse } from "next/server";
import { parseGenerationInput, quote } from "@/lib/creative/operations";
import { creativeSession } from "@/lib/server/creative";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";
import { geoRefusal } from "@/lib/server/geo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The price of one generation (migration 0036), before anything is held.
 *
 * POST `{ org_id?, capability, model, params }`. The database prices it from
 * the model's registry entry and credit_prices — this route never computes a
 * number — and answers `unpriced` / `model_not_sellable` rather than a zero.
 * Without 0036 applied: 503 `creative_unavailable`. edit / i2v / upscale /
 * remove_bg take `params.source_asset_id` (and upscale `params.factor`); the
 * database checks the picture is this organization's (0046).
 *
 * A model whose vendor forbids the country this request comes from is answered
 * 451 `country_blocked` (docs/GEO_BLOCK.md): before the database is asked when
 * the model is named, and instead of the price when the automatic choice picked
 * it. An unknown country is allowed (and logged).
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
  const parsed = parseGenerationInput(body, session.defaultOrg, { requirePrice: false });
  if (!parsed.ok) return NextResponse.json(parsed.result.body, { status: parsed.result.status });
  const named = parsed.input.mode === "exact" && parsed.input.model ? geoRefusal(parsed.input.model, request.headers) : null;
  if (named) return NextResponse.json(named.body, { status: named.status });
  const out = await quote(session.db, parsed.input);
  const picked = (out.body.quote as { model?: unknown } | undefined)?.model;
  const routed = out.status === 200 && parsed.input.mode !== "exact" && typeof picked === "string" ? geoRefusal(picked, request.headers) : null;
  if (routed) return NextResponse.json(routed.body, { status: routed.status });
  return NextResponse.json(out.body, { status: out.status });
});
