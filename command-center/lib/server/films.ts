import "server-only";
import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/org-roles";
import { getOrgContext } from "@/lib/orgs-server";
import { parseJsonCapped } from "@/lib/server/json-body";
import { rateRefusal, takeWebRate, type RateRule } from "@/lib/server/web-rate";
import {
  FILM_LIST_COLUMNS,
  coerceFilmList,
  coerceFilmView,
  mapFilmDbError,
  parseFilmId,
  type FilmError,
  type FilmListItem,
  type FilmView,
} from "@/lib/films";

/**
 * Studio → Projects on the server (internal name: films; migration 0166, docs/FILM_STUDIO.md). Every call is the signed-in member's
 * own Supabase client (anon key + session cookie): RLS for the list, and 0166's four member functions, which check the role and the
 * organization again and write the audit row (film_events) themselves. Never the service key; 0166 does not even grant it these
 * functions. Nothing here prices, holds, starts or calls a vendor: P1 is drafts only.
 */

export const NO_STORE = { "cache-control": "no-store" };

/**
 * NIGHTSHIFT_FILM_STUDIO (server-side only, never a NEXT_PUBLIC value), default off:
 *   - `off` (unset, empty, anything unrecognised): the pages and the routes are a 404, and no navigation lists the section;
 *   - `admins`: only a platform owner/admin sees it (the operator trying the unfinished section in production); everyone else, 404;
 *   - `on` (also 1/true/yes): every member of a workspace.
 * Projects cannot be priced or started yet (P2), so customers should meet it only once the owner says so.
 */
export const FILM_STUDIO_FLAG = "NIGHTSHIFT_FILM_STUDIO";
export type FilmStudioMode = "off" | "admins" | "on";

export function filmStudioMode(raw: string | undefined = process.env.NIGHTSHIFT_FILM_STUDIO): FilmStudioMode {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "admins") return "admins";
  return ["on", "1", "true", "yes"].includes(v) ? "on" : "off";
}

/** Is the section listed for this viewer? Presentation only: the pages and routes check again (filmStudioOpen / filmGate). */
export function filmStudioListed(mode: FilmStudioMode, operator: boolean): boolean {
  return mode === "on" || (mode === "admins" && operator);
}

/** May this request open the section's pages? An unknown admin answer is "no" (isPlatformAdmin folds errors to false). */
export async function filmStudioOpen(mode: FilmStudioMode = filmStudioMode()): Promise<boolean> {
  if (mode === "off") return false;
  if (mode === "on") return true;
  return isPlatformAdmin();
}

export function filmFail(error: FilmError, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: { ...NO_STORE, ...headers } });
}

/** A database refusal as the route's answer: a closed word, its status, and the database's own sentence when it gave one. */
export function filmRefusal(error: { code?: string; message?: string; details?: string | null }) {
  const m = mapFilmDbError(error);
  return filmFail(m.error, m.status, m.detail ? { detail: m.detail } : {});
}

type Client = NonNullable<Awaited<ReturnType<typeof createClient>>>;
export type FilmGate = { ok: true; supabase: Client; userId: string } | { ok: false; response: NextResponse };

/**
 * The first lines of every /api/films route, in this order: the switch (404 before the session is read, so a switched-off route does
 * not tell a visitor whether they are signed in), the session (401), the admins-only check (404, the same answer as "off"), the client.
 */
export async function filmGate(mode: FilmStudioMode = filmStudioMode()): Promise<FilmGate> {
  if (mode === "off") return { ok: false, response: filmFail("not_found", 404) };
  const user = await getUser();
  if (!user) return { ok: false, response: filmFail("session_expired", 401) };
  if (mode === "admins" && !(await isPlatformAdmin())) return { ok: false, response: filmFail("not_found", 404) };
  const supabase = await createClient();
  if (!supabase) return { ok: false, response: filmFail("not_configured", 503) };
  return { ok: true, supabase, userId: user.id };
}

/** The route's per-person limit (lib/server/web-rate), or the refusal to send. */
export async function filmRate(userId: string, rule: RateRule): Promise<NextResponse | null> {
  const decision = await takeWebRate(userId, rule);
  if (decision === "ok") return null;
  const r = rateRefusal(decision, rule);
  return filmFail(r.body.error as FilmError, r.status, {}, r.headers);
}

/** A JSON object body under a byte cap, or undefined (a 400, not a 500). */
export async function readFilmBody(request: Request, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await parseJsonCapped(request, maxBytes);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The workspace the app has open: a project is created in it, and the list reads it. */
export async function currentFilmOrg(): Promise<{ id: string; role: string } | null> {
  const ctx = await getOrgContext();
  return ctx.current ? { id: ctx.current.id, role: ctx.current.role } : null;
}

export const FILM_LIST_LIMIT = 100;

export type FilmListRead = { ok: true; films: FilmListItem[] } | { ok: false; error: "not_available" | "read_failed" };

/** The workspace's projects, newest change first: the open ones, or the archived ones. A failed read is said, never an empty list. */
export async function listFilms(supabase: Client, orgId: string, archived: boolean): Promise<FilmListRead> {
  if (!parseFilmId(orgId)) return { ok: false, error: "read_failed" };
  try {
    let q = supabase.from("films").select(FILM_LIST_COLUMNS).eq("org_id", orgId);
    q = archived ? q.eq("status", "archived") : q.neq("status", "archived");
    const { data, error } = await q.order("updated_at", { ascending: false }).limit(FILM_LIST_LIMIT);
    if (error) return { ok: false, error: mapFilmDbError(error).error === "not_available" ? "not_available" : "read_failed" };
    return { ok: true, films: coerceFilmList(data) };
  } catch {
    return { ok: false, error: "read_failed" };
  }
}

export type FilmRead = { ok: true; view: FilmView; raw: unknown } | { ok: false; error: FilmError; status: number };

/** One project through film_json (viewer and up; another workspace's project reads exactly like a missing one). */
export async function readFilm(supabase: Client, id: string): Promise<FilmRead> {
  const filmId = parseFilmId(id);
  if (!filmId) return { ok: false, error: "not_found", status: 404 };
  try {
    const { data, error } = await supabase.rpc("film_json", { p_film: filmId });
    if (error) {
      const m = mapFilmDbError(error);
      // film_json answers 42501 only when there is no signed-in caller: an ended session, not a missing right.
      return m.error === "forbidden" ? { ok: false, error: "session_expired", status: 401 } : { ok: false, error: m.error, status: m.status };
    }
    const view = coerceFilmView(data);
    return view ? { ok: true, view, raw: data } : { ok: false, error: "failed", status: 502 };
  } catch {
    return { ok: false, error: "failed", status: 502 };
  }
}

/** A write's answer: the film's new read model (0166's functions all return film_read), checked before it is passed on. */
export function filmAnswer(data: unknown, status = 200) {
  if (!coerceFilmView(data)) return filmFail("failed", 502);
  return NextResponse.json({ film: data }, { status, headers: NO_STORE });
}
