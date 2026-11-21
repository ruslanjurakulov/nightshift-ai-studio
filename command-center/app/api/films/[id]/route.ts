import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { FILM_SAVE_RATE } from "@/lib/server/web-rate";
import { NO_STORE, filmAnswer, filmFail, filmGateFor, filmRate, filmRefusal, readFilm, readFilmBody } from "@/lib/server/films";
import { SAVE_PATCH_KEYS, parseFilmId } from "@/lib/films";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 0166 refuses a patch over 2,000,000 bytes itself; the body around it adds a version and a key. */
const SAVE_BODY_BYTES = 2_050_000;

/** GET: one project's read model (0166's film_json; viewer and up). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await filmGateFor(id);
  if (!gate.ok) return gate.response;
  const read = await readFilm(gate.supabase, id);
  if (!read.ok) return filmFail(read.error, read.status);
  return NextResponse.json({ film: read.raw }, { headers: NO_STORE });
}

/**
 * PATCH: save an edit at the version the person read (0166's save_film): `{ version, patch }`. The patch carries the project's settings,
 * the whole ordered list of scenes and the whole list of references; the database checks every field and the editor role, and refuses
 * a stale version with `film_changed` (409): nothing is merged and nothing is overwritten. Spends nothing.
 */
export const PATCH = requireSameOrigin(async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await filmGateFor(id);
  if (!gate.ok) return gate.response;
  const filmId = parseFilmId(id);
  if (!filmId) return filmFail("not_found", 404);
  const b = await readFilmBody(request, SAVE_BODY_BYTES);
  if (!b) return filmFail("bad_request", 400);
  const version = b.version;
  const patch = b.patch;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return filmFail("bad_request", 400);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return filmFail("bad_request", 400);
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((k) => !(SAVE_PATCH_KEYS as readonly string[]).includes(k))) return filmFail("bad_request", 400);
  const limited = await filmRate(gate.userId, FILM_SAVE_RATE);
  if (limited) return limited;
  const { data, error } = await gate.supabase.rpc("save_film", { p_film: filmId, p_version: version, p_patch: patch });
  if (error) return filmRefusal(error);
  return filmAnswer(data);
});
