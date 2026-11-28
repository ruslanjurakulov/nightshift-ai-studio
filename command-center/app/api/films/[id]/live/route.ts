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
 * its final file and its credits, and 0246's assembly percent), each take's stored money and error word (and 0246's vendor percent and
 * status word), and 0248's typical take durations. A read of either that fails is null in the answer
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

  // 0246's assembly_progress first; a database without it answers the shape before it (the progress then reads "not known").
  let segments: unknown[] | null = null;
  const segmentBase = "id,status,assembly_status,assembly_asset_id,confirmed_credits,captured_credits,assembly_confirmed_credits,assembly_charged_credits,created_at";
  for (const columns of [`${segmentBase},assembly_progress,assembly_progress_at`, segmentBase]) {
    try {
      const s = await gate.supabase.from("film_segments").select(columns).eq("film_id", filmId).order("created_at", { ascending: false }).limit(MAX_SEGMENTS);
      if (!s.error && Array.isArray(s.data)) {
        segments = s.data;
        break;
      }
    } catch {
      /* the next shape, or null */
    }
  }

  // The money columns are 0171's (and charge_basis); without them the error words (0166) are still worth having, so a refused read tries once more
  // without the money, and the money then reads as "not recorded".
  let takes: unknown[] | null = null;
  // charge_basis (0171) tells a retry's superseded first attempt from any other superseding (lib/studio/liveGraph pickSlot).
  // progress, vendor_state, progress_at (0246): the vendor's own percent and status word of a running take, null when not known.
  for (const columns of [
    "id,error_code,confirmed_credits,charged_credits,charge_basis,progress,vendor_state,progress_at",
    "id,error_code,confirmed_credits,charged_credits,charge_basis",
    "id,error_code,confirmed_credits,charged_credits",
    "id,error_code",
  ]) {
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

  // 0248: this workspace's typical take durations per model and capability (median and n; no ids). Null when not readable.
  let typical: unknown[] | null = null;
  try {
    const m = await gate.supabase.rpc("film_take_typical_seconds", { p_film: filmId });
    if (!m.error && Array.isArray(m.data)) typical = m.data;
  } catch {
    typical = null;
  }

  return NextResponse.json({ film: read.raw, segments, takes, typical }, { headers: NO_STORE });
}
