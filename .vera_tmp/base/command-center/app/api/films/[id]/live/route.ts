import { NextResponse } from "next/server";
import { NO_STORE, filmFail, filmGateFor, readFilm } from "@/lib/server/films";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bounded reads: a film has at most a few dozen takes and a handful of funding segments. */
const MAX_TAKES = 500;
const MAX_SEGMENTS = 20;

/**
 * GET: one project as the Studio's live view reads it (lib/studio/liveGraph.ts). Read-only, with the person's own session (RLS, never
 * the service key): 0166's film_json, plus what film_json does not carry. That is the film's funding segments (0171: the assembly,
 * its final file and its credits) and each take's stored money and error word. A read of either that fails is null in the answer
 * ("not known"), never an empty list: an assembly that cannot be read must not look like one that has not started (CLAUDE.md rule 5).
 * Nothing here starts, prices or retries anything.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await filmGateFor(id);
  if (!gate.ok) return gate.response;
  const read = await readFilm(gate.supabase, id);
  if (!read.ok) return filmFail(read.error, read.status);
  const filmId = read.view.film.id;

  let segments: unknown[] | null = null;
  try {
    const s = await gate.supabase
      .from("film_segments")
      .select("id,status,assembly_status,assembly_asset_id,confirmed_credits,captured_credits,assembly_confirmed_credits,assembly_charged_credits,created_at")
      .eq("film_id", filmId)
      .order("created_at", { ascending: false })
      .limit(MAX_SEGMENTS);
    if (!s.error && Array.isArray(s.data)) segments = s.data;
  } catch {
    segments = null;
  }

  // The money columns are 0171's; without them the error words (0166) are still worth having, so a refused read tries once more
  // without the money, and the money then reads as "not recorded".
  let takes: unknown[] | null = null;
  for (const columns of ["id,error_code,confirmed_credits,charged_credits", "id,error_code"]) {
    try {
      const t = await gate.supabase.from("film_takes").select(columns).eq("film_id", filmId).limit(MAX_TAKES);
      if (!t.error && Array.isArray(t.data)) {
        takes = t.data;
        break;
      }
    } catch {
      /* the next shape, or null */
    }
  }

  return NextResponse.json({ film: read.raw, segments, takes }, { headers: NO_STORE });
}
