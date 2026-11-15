import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { FILM_SAVE_RATE } from "@/lib/server/web-rate";
import { NO_STORE, filmFail, filmGate, filmRate, filmRefusal, readFilmBody } from "@/lib/server/films";
import { parseFilmId } from "@/lib/films";
import { coerceQuote } from "@/lib/studio/timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST `{ version }`: 0171's quote_film for the version the person is looking at. The database prices every line at today's rates,
 * stores the quote for 30 minutes and says what would block a start (switched off, credits, caps, slots). Nothing is held or spent.
 * Until 0171 is applied the function does not exist and this answers `not_available` (503): the Timeline then shows no number at all.
 */
export const POST = requireSameOrigin(async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await filmGate();
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const filmId = parseFilmId(id);
  if (!filmId) return filmFail("not_found", 404);
  const b = await readFilmBody(request, 1_000);
  const version = b?.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return filmFail("bad_request", 400);
  const limited = await filmRate(gate.userId, FILM_SAVE_RATE);
  if (limited) return limited;
  const { data, error } = await gate.supabase.rpc("quote_film", { p_film: filmId, p_version: version });
  if (error) return filmRefusal(error);
  if (!coerceQuote(data)) return filmFail("failed", 502);
  return NextResponse.json({ quote: data }, { headers: NO_STORE });
});
