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
 *   - `on` (also 1/true/yes): a member of a workspace whose own switch is on (org_film_settings.film_studio_enabled, migration
 *     0198, default false; filmStudioOrgOn). Without that, `on` would open the section to every workspace the moment the owner
 *     tried it for one, while start_film still refused them all: a section that answers "not open" on every click.
 * The platform switch (film_studio_settings, 0171) is not readable by any API role, so it is not read here: quote_film and
 * start_film enforce it themselves (both read 0198's film_studio_on_for, the platform's switch AND the workspace's), as before.
 */
export const FILM_STUDIO_FLAG = "NIGHTSHIFT_FILM_STUDIO";
export type FilmStudioMode = "off" | "admins" | "on";

export function filmStudioMode(raw: string | undefined = process.env.NIGHTSHIFT_FILM_STUDIO): FilmStudioMode {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "admins") return "admins";
  return ["on", "1", "true", "yes"].includes(v) ? "on" : "off";
}

/**
 * Is the section listed for this viewer? Presentation only: the pages and routes check again (filmStudioOpen / filmGate). `orgOn` is
 * the workspace answer (filmStudioViewerOn / filmStudioOpen), and counts only under `on`: `admins` is the operator's beta, whatever a
 * workspace's switch says.
 */
export function filmStudioListed(mode: FilmStudioMode, operator: boolean, orgOn: boolean): boolean {
  return mode === "on" ? orgOn : mode === "admins" && operator;
}

type OrgSwitchRow = { org_id: string; film_studio_enabled: boolean };

function isOrgSwitchRow(row: unknown): row is OrgSwitchRow {
  const r = row as Partial<OrgSwitchRow> | null;
  return !!r && typeof r === "object" && typeof r.org_id === "string" && typeof r.film_studio_enabled === "boolean";
}

function orgSwitchUnknown(orgIds: readonly string[], code: string) {
  // The organization ids and a closed code only: never the client, a header or the database's message.
  console.error("films: org_film_settings could not be read (org %s, %s); Film Studio is hidden", orgIds.join(",") || "none", code);
}

/**
 * Is Film Studio switched on for any of these workspaces (org_film_settings.film_studio_enabled, 0198)? Read with the member's own
 * client: 0198 grants authenticated `select (film_studio_enabled)` and 0171's org_film_settings_select (RLS) lets a member read only
 * their own workspaces' rows, so an id the caller is not in simply has no row. No row is false (every workspace starts off). A failed
 * read, a throw or an answer of the wrong shape is also false, logged once: an unknown is not a yes (CLAUDE.md rules 4 and 5).
 */
export async function filmStudioOrgOn(supabase: Client | null, orgIds: readonly string[]): Promise<boolean> {
  const ids = orgIds.map((id) => parseFilmId(id)).filter((id): id is string => id !== null);
  if (ids.length === 0) return false;
  if (!supabase) {
    orgSwitchUnknown(ids, "no_client");
    return false;
  }
  try {
    const { data, error } = await supabase.from("org_film_settings").select("org_id, film_studio_enabled").in("org_id", ids);
    if (error) {
      orgSwitchUnknown(ids, typeof error.code === "string" && error.code ? error.code : "error");
      return false;
    }
    if (!Array.isArray(data) || !data.every(isOrgSwitchRow)) {
      orgSwitchUnknown(ids, "unexpected_shape");
      return false;
    }
    return data.some((r) => r.film_studio_enabled === true && ids.includes(r.org_id.toLowerCase()));
  } catch {
    orgSwitchUnknown(ids, "threw");
    return false;
  }
}

/**
 * The workspace answer for the navigation under `on` (no read under `off` or `admins`). A channel view asks about the workspace the
 * app has open (getOrgContext's `current`); the every-channel roll-up asks about any workspace the viewer is in (`switchable`: their
 * own memberships, not every organization a platform admin may read).
 */
export async function filmStudioViewerOn(mode: FilmStudioMode, allChannels: boolean): Promise<boolean> {
  if (mode !== "on") return false;
  let ids: string[] = [];
  try {
    const ctx = await getOrgContext();
    ids = allChannels ? ctx.switchable.map((o) => o.id) : ctx.current ? [ctx.current.id] : [];
    if (ids.length === 0) return false;
    return await filmStudioOrgOn(await createClient(), ids);
  } catch {
    orgSwitchUnknown(ids, "threw");
    return false;
  }
}

/** May this request open the section's pages? An unknown admin answer is "no" (isPlatformAdmin folds errors to false), and so is an unknown workspace switch. */
export async function filmStudioOpen(mode: FilmStudioMode = filmStudioMode()): Promise<boolean> {
  if (mode === "off") return false;
  if (mode === "on") return filmStudioViewerOn(mode, false);
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
 * not tell a visitor whether they are signed in), the session (401), the admins-only check (404, the same answer as "off"), the client,
 * and under `on` the open workspace's own switch (404 again, so a workspace that is off cannot tell the section exists).
 *
 * The workspace checked is the one the app has open, also for a route that names a project, and that is enough: a project of a
 * workspace the caller is not in reads and writes like a missing one through this client (films RLS, 0166's functions check the
 * organization again). The one way to name a project of another workspace the caller can read (the platform operator's support
 * read) still cannot spend through it: quote_film and start_film ask film_studio_on_for about the film's own organization (0198).
 */
export async function filmGate(mode: FilmStudioMode = filmStudioMode()): Promise<FilmGate> {
  if (mode === "off") return { ok: false, response: filmFail("not_found", 404) };
  const user = await getUser();
  if (!user) return { ok: false, response: filmFail("session_expired", 401) };
  if (mode === "admins" && !(await isPlatformAdmin())) return { ok: false, response: filmFail("not_found", 404) };
  const supabase = await createClient();
  if (!supabase) return { ok: false, response: filmFail("not_configured", 503) };
  if (mode === "on") {
    const org = await currentFilmOrg();
    if (!org || !(await filmStudioOrgOn(supabase, [org.id]))) return { ok: false, response: filmFail("not_found", 404) };
  }
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
