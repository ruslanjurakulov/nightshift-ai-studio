import { NextResponse } from "next/server";
import { parseGenerationInput, quote } from "@/lib/creative/operations";
import { creativeSession } from "@/lib/server/creative";

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
  const parsed = parseGenerationInput(body, session.defaultOrg, { requirePrice: false });
  if (!parsed.ok) return NextResponse.json(parsed.result.body, { status: parsed.result.status });
  const out = await quote(session.db, parsed.input);
  return NextResponse.json(out.body, { status: out.status });
}
