import { NextResponse } from "next/server";
import { parseGenerationInput, quote } from "@/lib/creative/operations";
import { creativeSession } from "@/lib/server/creative";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { parseJsonCapped } from "@/lib/server/json-body";
import { blockedModelsHere, geoRefusal } from "@/lib/server/geo";
import { quoteAround } from "@/lib/creative/route-around";

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
 * the model is named. When the automatic choice picked it, the choice is made
 * again among the models offered there, and 451 only if none remains. An unknown
 * country is allowed (and logged).
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
  let out = await quote(session.db, parsed.input);
  if (out.status === 200 && parsed.input.mode !== "exact") {
    // The database picked without knowing the country. A pick this country forbids is not shown as a price: the same choice
    // is made among the models that remain (lib/creative/route-around.ts), so the automatic choice is never a dead end.
    const q = out.body.quote as { routed_model?: unknown; model?: unknown } | undefined;
    const picked = typeof q?.routed_model === "string" ? q.routed_model : typeof q?.model === "string" ? q.model : "";
    if (picked && geoRefusal(picked, request.headers)) {
      const blocked = blockedModelsHere(request.headers);
      out = blocked ? await quoteAround(session.db, parsed.input, blocked) : { status: 451, body: { error: "country_blocked" } };
    }
  }
  return NextResponse.json(out.body, { status: out.status });
});
