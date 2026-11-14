import { requireSameOrigin } from "@/lib/server/same-origin";
import { FILM_ARCHIVE_RATE } from "@/lib/server/web-rate";
import { filmAnswer, filmFail, filmGate, filmRate, filmRefusal } from "@/lib/server/films";
import { parseFilmId } from "@/lib/films";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST: put a draft away (0166's archive_film; editor and up). It keeps its scenes and history, stops counting toward the open drafts,
 * and can no longer be edited. Archiving an archived project again changes nothing. Spends nothing.
 */
export const POST = requireSameOrigin(async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await filmGate();
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const filmId = parseFilmId(id);
  if (!filmId) return filmFail("not_found", 404);
  const limited = await filmRate(gate.userId, FILM_ARCHIVE_RATE);
  if (limited) return limited;
  const { data, error } = await gate.supabase.rpc("archive_film", { p_film: filmId });
  if (error) return filmRefusal(error);
  return filmAnswer(data);
});
