/**
 * Studio → Projects (internal name: films; migration 0166, docs/FILM_STUDIO.md): the shapes the pages, the routes and the
 * canvas share, the database's refusals as closed words, and the browser's calls to /api/films.
 *
 * Pure: no React, no environment, no Supabase. The browser never talks to the database here: it calls the app's own routes, which call
 * 0166's four functions with the member's own session (anon key + cookie, lib/server/films.ts). No route and no helper here ever holds
 * the service key, and nothing here prices, starts or spends anything: P1 has drafts only (CLAUDE.md rule 3).
 *
 * The limits are the database's own (film_json.limits). The canvas checks a draft against them so a person sees the problem beside the
 * field, but the database is the judge; a read model that arrives without its limits is treated as unreadable, never filled in.
 */

export const FILM_STATUSES = [
  "draft",
  "planning",
  "planned",
  // 0171: the hold is taken and the project waits for the worker to pick it up.
  "queued",
  "running",
  "draining",
  "paused",
  "assembling",
  "ready",
  "failed",
  "cancelled",
  "archived",
] as const;
export type FilmStatus = (typeof FILM_STATUSES)[number];

export const SCENE_STATUSES = ["draft", "queued", "generating", "ready", "failed"] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];

export const FILM_LANGUAGES = ["en", "ru", "uz"] as const;
export type FilmLanguage = (typeof FILM_LANGUAGES)[number];
export const FILM_ASPECTS = ["16:9", "9:16", "1:1"] as const;
export type FilmAspect = (typeof FILM_ASPECTS)[number];
export const SOURCE_KINDS = ["topic", "script"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const FIRST_FRAMES = ["keyframe", "previous", "asset"] as const;
export type FirstFrame = (typeof FIRST_FRAMES)[number];
export const LAST_FRAMES = ["none", "next_keyframe", "asset"] as const;
export type LastFrame = (typeof LAST_FRAMES)[number];
export const REF_KINDS = ["character", "style", "location"] as const;
export type RefKind = (typeof REF_KINDS)[number];

/** film_limits() as film_json hands it over. Every key is required: a read without them is not a read. */
export const LIMIT_KEYS = [
  "max_scenes",
  "scene_seconds_min",
  "scene_seconds_max",
  "max_shots",
  "max_film_seconds",
  "target_seconds_min",
  "target_seconds_max",
  "max_topic_chars",
  "max_script_chars",
  "max_title_chars",
  "max_narration_chars",
  "max_prompt_chars",
  "max_negative_chars",
  "max_film_refs",
  "max_scene_refs",
  "max_open_drafts",
  "max_patch_bytes",
  "creates_per_hour",
  "saves_per_hour",
  "archives_per_hour",
] as const;
export type FilmLimits = Record<(typeof LIMIT_KEYS)[number], number>;

/**
 * The limits the "New project" form checks before a film exists (it has no film_json to read them from yet). The same numbers as
 * film_limits() in the latest migration that writes it (0166, then 0198: a film may target 10 s, so a 15-30 s advert is a film);
 * tests/films.test.ts pins them against the migration's text, so the two cannot drift apart unnoticed. The database checks them
 * again either way.
 */
export const CREATE_LIMITS = {
  max_title_chars: 120,
  max_topic_chars: 2000,
  max_script_chars: 40000,
  target_seconds_min: 10,
  target_seconds_max: 1200,
  max_open_drafts: 50,
} as const;

export interface FilmRef {
  id: string | null;
  sceneId: string | null;
  kind: RefKind;
  characterId: string | null;
  assetId: string | null;
  position: number;
  /** The character or picture no longer exists (film_json's own flag). */
  missing: boolean;
}

export interface FilmTake {
  id: string;
  sceneId: string | null;
  kind: string;
  status: string;
  version: number;
  shotIndex: number;
  errorCode: string | null;
}

export interface FilmScene {
  id: string;
  position: number;
  title: string;
  narration: string;
  visualPrompt: string;
  negativePrompt: string;
  plannedSeconds: number;
  shotCount: number;
  firstFrame: FirstFrame;
  firstFrameAssetId: string | null;
  lastFrame: LastFrame;
  lastFrameAssetId: string | null;
  status: SceneStatus;
  /** Null until a take is chosen: "never shot" is not version 0 of anything. */
  currentVersion: number | null;
  firstFrameMissing: boolean;
  lastFrameMissing: boolean;
  refs: FilmRef[];
  takes: FilmTake[];
}

export interface Film {
  id: string;
  orgId: string;
  channelId: string | null;
  title: string;
  sourceKind: SourceKind | "storyboard";
  sourceText: string;
  language: FilmLanguage;
  aspect: FilmAspect;
  targetSeconds: number;
  status: FilmStatus;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
}

export interface FilmView {
  film: Film;
  /** film_is_editable(status), the database's answer: draft or planned. */
  editable: boolean;
  scenes: FilmScene[];
  refs: FilmRef[];
  totals: { scenes: number; plannedSeconds: number };
  limits: FilmLimits;
}

export interface FilmListItem {
  id: string;
  channelId: string | null;
  title: string;
  sourceKind: string;
  language: FilmLanguage;
  aspect: FilmAspect;
  targetSeconds: number;
  status: FilmStatus;
  updatedAt: string | null;
  archivedAt: string | null;
}

/** The columns a member may read on public.films (0166's column grant names them; never the request hash). */
export const FILM_LIST_COLUMNS = "id, channel_id, title, source_kind, language, aspect, target_seconds, status, updated_at, archived_at";

// ─── reading the database's answers ──────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseFilmId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return UUID.test(v) ? v : null;
}

/** 0166's idempotency key rule: 8-128 letters, digits or _.:- starting with a letter or digit. */
export const IDEM_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
function oneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null;
}

export function coerceLimits(raw: unknown): FilmLimits | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out = {} as FilmLimits;
  for (const k of LIMIT_KEYS) {
    const n = typeof r[k] === "number" ? (r[k] as number) : typeof r[k] === "string" ? Number(r[k]) : NaN;
    if (!Number.isFinite(n)) return null;
    out[k] = n;
  }
  return out;
}

function coerceRef(raw: unknown): FilmRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = oneOf(REF_KINDS, r.kind);
  const characterId = parseFilmId(r.character_id);
  const assetId = parseFilmId(r.asset_id);
  if (!kind || (characterId === null) === (assetId === null)) return null;
  return {
    id: parseFilmId(r.id),
    sceneId: parseFilmId(r.scene_id),
    kind,
    characterId,
    assetId,
    position: int(r.position) ?? 0,
    missing: r.missing === true,
  };
}

function coerceTake(raw: unknown): FilmTake | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = parseFilmId(r.id);
  if (!id || typeof r.kind !== "string" || typeof r.status !== "string") return null;
  return {
    id,
    sceneId: parseFilmId(r.scene_id),
    kind: r.kind,
    status: r.status,
    version: int(r.version) ?? 0,
    shotIndex: int(r.shot_index) ?? 0,
    errorCode: str(r.error_code),
  };
}

const list = <T>(raw: unknown, f: (x: unknown) => T | null): T[] => (Array.isArray(raw) ? raw.flatMap((x) => f(x) ?? []) : []);

function coerceScene(raw: unknown): FilmScene | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = parseFilmId(r.id);
  const plannedSeconds = int(r.planned_seconds);
  const firstFrame = oneOf(FIRST_FRAMES, r.first_frame);
  const lastFrame = oneOf(LAST_FRAMES, r.last_frame);
  if (!id || plannedSeconds === null || !firstFrame || !lastFrame) return null;
  return {
    id,
    position: int(r.position) ?? 0,
    title: str(r.title) ?? "",
    narration: str(r.narration) ?? "",
    visualPrompt: str(r.visual_prompt) ?? "",
    negativePrompt: str(r.negative_prompt) ?? "",
    plannedSeconds,
    shotCount: int(r.shot_count) ?? 1,
    firstFrame,
    firstFrameAssetId: parseFilmId(r.first_frame_asset_id),
    lastFrame,
    lastFrameAssetId: parseFilmId(r.last_frame_asset_id),
    // A status this build does not know reads as the draft it most resembles only when it is literally unknown; a real one is kept.
    status: oneOf(SCENE_STATUSES, r.status) ?? "draft",
    currentVersion: int(r.current_version),
    firstFrameMissing: r.first_frame_missing === true,
    lastFrameMissing: r.last_frame_missing === true,
    refs: list(r.refs, coerceRef),
    takes: list(r.takes, coerceTake),
  };
}

function coerceFilm(raw: unknown): Film | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = parseFilmId(r.id);
  const orgId = parseFilmId(r.org_id);
  const language = oneOf(FILM_LANGUAGES, r.language);
  const aspect = oneOf(FILM_ASPECTS, r.aspect);
  const status = oneOf(FILM_STATUSES, r.status);
  const version = int(r.version);
  const targetSeconds = int(r.target_seconds);
  const sourceKind = oneOf(["topic", "script", "storyboard"] as const, r.source_kind);
  if (!id || !orgId || !language || !aspect || !status || version === null || targetSeconds === null || !sourceKind) return null;
  return {
    id,
    orgId,
    channelId: str(r.channel_id),
    title: str(r.title) ?? "",
    sourceKind,
    sourceText: str(r.source_text) ?? "",
    language,
    aspect,
    targetSeconds,
    status,
    version,
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    archivedAt: str(r.archived_at),
  };
}

/** film_json's answer, or null when it is not one (then the page says "could not be read", never an empty project). */
export function coerceFilmView(raw: unknown): FilmView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const film = coerceFilm(r.film);
  const limits = coerceLimits(r.limits);
  if (!film || !limits || typeof r.editable !== "boolean") return null;
  const scenes = list(r.scenes, coerceScene).sort((a, b) => a.position - b.position);
  const t = (r.totals ?? {}) as Record<string, unknown>;
  return {
    film,
    editable: r.editable,
    scenes,
    refs: list(r.refs, coerceRef).sort((a, b) => a.position - b.position),
    totals: {
      scenes: int(t.scenes) ?? scenes.length,
      plannedSeconds: int(t.planned_seconds) ?? scenes.reduce((s, x) => s + x.plannedSeconds, 0),
    },
    limits,
  };
}

export function coerceFilmList(raw: unknown): FilmListItem[] {
  return list(raw, (x) => {
    if (!x || typeof x !== "object") return null;
    const r = x as Record<string, unknown>;
    const id = parseFilmId(r.id);
    const status = oneOf(FILM_STATUSES, r.status);
    const language = oneOf(FILM_LANGUAGES, r.language);
    const aspect = oneOf(FILM_ASPECTS, r.aspect);
    const targetSeconds = int(r.target_seconds);
    if (!id || !status || !language || !aspect || targetSeconds === null) return null;
    return {
      id,
      channelId: str(r.channel_id),
      title: str(r.title) ?? "",
      sourceKind: str(r.source_kind) ?? "topic",
      language,
      aspect,
      targetSeconds,
      status,
      updatedAt: str(r.updated_at),
      archivedAt: str(r.archived_at),
    };
  });
}

/**
 * GET /api/films's rows as the browser reads them. The route already read the database rows into FilmListItem (camelCase), so
 * reading them again with coerceFilmList (snake_case) dropped every one: the archived tab showed nothing. Checked, never trusted.
 */
export function coerceFilmListItems(raw: unknown): FilmListItem[] {
  return list(raw, (x) => {
    if (!x || typeof x !== "object") return null;
    const r = x as Record<string, unknown>;
    const id = parseFilmId(r.id);
    const status = oneOf(FILM_STATUSES, r.status);
    const language = oneOf(FILM_LANGUAGES, r.language);
    const aspect = oneOf(FILM_ASPECTS, r.aspect);
    const targetSeconds = int(r.targetSeconds);
    if (!id || !status || !language || !aspect || targetSeconds === null) return null;
    return {
      id,
      channelId: str(r.channelId),
      title: str(r.title) ?? "",
      sourceKind: str(r.sourceKind) ?? "topic",
      language,
      aspect,
      targetSeconds,
      status,
      updatedAt: str(r.updatedAt),
      archivedAt: str(r.archivedAt),
    };
  });
}

// ─── refusals ────────────────────────────────────────────────────────────────

/** Every refusal the screens can show. Each has a sentence in lib/i18n/film-studio/{en,ru,uz}.ts `errors` (a test checks). */
export const FILM_ERRORS = [
  // 0166's own words (SQLSTATE 42501 / P0002 / NS400 / NS409 / NS429).
  "forbidden",
  "not_found",
  "invalid_params",
  "invalid_idempotency_key",
  "limit_reached",
  "model_not_offered",
  "model_not_available",
  "asset_not_usable",
  // 0171's start_film: a reference picture or character was deleted after the quote.
  "reference_missing",
  // 0214's voice_language_problem, a quote line's refusal once quote_film asks it: the voice model does not speak the film's
  // language, or nobody can say whether it does (unknown is never "speaks").
  "voice_language_unsupported",
  "voice_language_unknown",
  "film_changed",
  "film_not_editable",
  "idempotency_conflict",
  "scene_has_takes",
  "rate_limited",
  // The route's and the browser's own.
  "session_expired",
  "network",
  "bad_request",
  "org_required",
  "not_available",
  "not_configured",
  "rate_limit_unavailable",
  "failed",
] as const;
export type FilmError = (typeof FILM_ERRORS)[number];

const NS400_WORDS: readonly FilmError[] = [
  "invalid_params",
  "invalid_idempotency_key",
  "limit_reached",
  "model_not_offered",
  "model_not_available",
  "asset_not_usable",
  "reference_missing",
];
const NS409_WORDS: readonly FilmError[] = ["film_changed", "film_not_editable", "idempotency_conflict", "scene_has_takes"];

export interface MappedFilmError {
  error: FilmError;
  status: number;
  /** The database's own sentence for a refused value ("scene 3: planned_seconds must be…"): shown as a detail under the message. */
  detail?: string;
}

/**
 * A PostgREST error from one of 0166's functions as the route's answer. The machine word rides in `message`, the SQLSTATE in `code`
 * (creative_refuse, 0036). A word this build does not know is "failed", never guessed into a nearby one.
 */
export function mapFilmDbError(error: { code?: string; message?: string; details?: string | null } | null | undefined): MappedFilmError {
  const code = error?.code ?? "";
  const word = (error?.message ?? "").trim();
  const detail = typeof error?.details === "string" && error.details && error.details !== word ? error.details.slice(0, 300) : undefined;
  if (code === "PGRST202" || code === "42883" || code === "42P01" || code === "PGRST205") return { error: "not_available", status: 503 };
  if (code === "42501") return { error: "forbidden", status: 403 };
  if (code === "P0002") return { error: "not_found", status: 404 };
  if (code === "NS429") return { error: "rate_limited", status: 429 };
  if (code === "NS400") {
    const w = NS400_WORDS.find((x) => x === word);
    return w ? { error: w, status: 400, ...(detail ? { detail } : {}) } : { error: "failed", status: 502 };
  }
  if (code === "NS409") {
    const w = NS409_WORDS.find((x) => x === word);
    return w ? { error: w, status: 409, ...(detail ? { detail } : {}) } : { error: "failed", status: 502 };
  }
  return { error: "failed", status: 502 };
}

/** A route's error answer as the browser reads it. A 401 is an expired session whatever the body says. */
export function filmErrorFromResponse(status: number, body: unknown): { error: FilmError; detail?: string; retryAfter?: number } {
  if (status === 401) return { error: "session_expired" };
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const error = oneOf(FILM_ERRORS, b.error) ?? (status === 429 ? "rate_limited" : status === 404 ? "not_found" : "failed");
  const detail = typeof b.detail === "string" ? b.detail.slice(0, 300) : undefined;
  return { error, ...(detail ? { detail } : {}) };
}

// ─── drafts the canvas edits ─────────────────────────────────────────────────

/** One scene as the canvas holds it while a person edits: `id` null for a scene not saved yet; `key` is the screen's own handle. */
export interface SceneDraft {
  key: string;
  id: string | null;
  title: string;
  narration: string;
  visualPrompt: string;
  negativePrompt: string;
  plannedSeconds: number;
  shotCount: number;
  firstFrame: FirstFrame;
  firstFrameAssetId: string | null;
  lastFrame: LastFrame;
  lastFrameAssetId: string | null;
  /** film_json's own flags: the saved picture left the library. Cleared when a person picks another. */
  firstFrameMissing: boolean;
  lastFrameMissing: boolean;
  /** Read-only, from the database: what the saved scene is. A new scene is a draft. */
  status: SceneStatus;
  hasTakes: boolean;
}

export interface RefDraft {
  kind: RefKind;
  characterId: string | null;
  assetId: string | null;
  missing: boolean;
}

export interface SettingsDraft {
  title: string;
  language: FilmLanguage;
  aspect: FilmAspect;
  targetSeconds: number;
}

// The characters 0166's film_clean_text removes (control characters and every character nobody sees). Kept in the migration's order.
const INVISIBLE_TAIL =
  "\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u2800\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb\\u{13430}-\\u{1343f}\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e0fff}";
const INVISIBLE_MULTI = new RegExp(`[\\u0001-\\u0009\\u000b-\\u001f\\u007f-\\u009f${INVISIBLE_TAIL}]`, "gu");
const INVISIBLE_SINGLE = new RegExp(`[\\u0001-\\u001f\\u007f-\\u009f${INVISIBLE_TAIL}]`, "gu");

/**
 * 0166's film_clean_text, in the browser: what the database will store for this text. The canvas sends and compares the cleaned
 * text, so a trailing space or a doubled space a person is still typing is not "unsaved" forever (the database would trim it on every
 * save, and autosave would save the same edit again and again). tests/films.test.ts pins it against the migration's own examples.
 */
export function cleanText(text: string, multiline: boolean): string {
  let x = multiline ? text.replace(/\r\n?/g, "\n") : text.replace(/[\u0009-\u000d\u2028\u2029]+/g, " ");
  x = x.replace(multiline ? INVISIBLE_MULTI : INVISIBLE_SINGLE, "");
  x = x.replace(/[ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, " ");
  return x.replace(/^[ \n]+|[ \n]+$/g, "");
}

export function sceneToDraft(s: FilmScene): SceneDraft {
  return {
    key: s.id,
    id: s.id,
    title: s.title,
    narration: s.narration,
    visualPrompt: s.visualPrompt,
    negativePrompt: s.negativePrompt,
    plannedSeconds: s.plannedSeconds,
    shotCount: s.shotCount,
    firstFrame: s.firstFrame,
    firstFrameAssetId: s.firstFrameAssetId,
    lastFrame: s.lastFrame,
    lastFrameAssetId: s.lastFrameAssetId,
    firstFrameMissing: s.firstFrameMissing,
    lastFrameMissing: s.lastFrameMissing,
    status: s.status,
    hasTakes: s.takes.length > 0,
  };
}

export function refToDraft(r: FilmRef): RefDraft {
  return { kind: r.kind, characterId: r.characterId, assetId: r.assetId, missing: r.missing };
}

/** A new scene: a planned length inside the limits, starting from its own key frame. Nothing about it is a measurement. */
export function newSceneDraft(key: string, limits: Pick<FilmLimits, "scene_seconds_min" | "scene_seconds_max">): SceneDraft {
  const seconds = Math.min(Math.max(8, limits.scene_seconds_min), limits.scene_seconds_max);
  return {
    key,
    id: null,
    title: "",
    narration: "",
    visualPrompt: "",
    negativePrompt: "",
    plannedSeconds: seconds,
    shotCount: 1,
    firstFrame: "keyframe",
    firstFrameAssetId: null,
    lastFrame: "none",
    lastFrameAssetId: null,
    firstFrameMissing: false,
    lastFrameMissing: false,
    status: "draft",
    hasTakes: false,
  };
}

/**
 * save_film's `scenes`: the whole ordered list. A saved scene names its id (it keeps the fields this screen does not edit: models,
 * clip parameters, its own references); a new one has none. A picture id is sent only while its mode uses it AND it is new or changed:
 * the database clears it when the mode no longer uses it, and keeps a saved one when it is not sent, so an unchanged picture that has
 * since been deleted from the library is not re-checked into a refusal on an unrelated edit (the scene shows it as missing instead).
 */
export function scenesPatch(
  scenes: readonly SceneDraft[],
  saved: ReadonlyMap<string, Pick<FilmScene, "firstFrame" | "firstFrameAssetId" | "lastFrame" | "lastFrameAssetId">> = new Map(),
): Record<string, unknown>[] {
  return scenes.map((s) => {
    const was = s.id ? saved.get(s.id) : undefined;
    const sendFirst = s.firstFrame === "asset" && !(was && was.firstFrame === "asset" && was.firstFrameAssetId === s.firstFrameAssetId);
    const sendLast = s.lastFrame === "asset" && !(was && was.lastFrame === "asset" && was.lastFrameAssetId === s.lastFrameAssetId);
    return {
      ...(s.id ? { id: s.id } : {}),
      title: cleanText(s.title, false),
      narration: cleanText(s.narration, true),
      visual_prompt: cleanText(s.visualPrompt, true),
      negative_prompt: cleanText(s.negativePrompt, true),
      planned_seconds: s.plannedSeconds,
      shot_count: s.shotCount,
      first_frame: s.firstFrame,
      ...(sendFirst ? { first_frame_asset_id: s.firstFrameAssetId } : {}),
      last_frame: s.lastFrame,
      ...(sendLast ? { last_frame_asset_id: s.lastFrameAssetId } : {}),
    };
  });
}

/** save_film's `refs`: the whole film-wide list, in order. */
export function refsPatch(refs: readonly RefDraft[]): Record<string, unknown>[] {
  return refs.map((r) => (r.characterId ? { kind: "character", character_id: r.characterId } : { kind: r.kind, asset_id: r.assetId }));
}

export function settingsPatch(s: SettingsDraft): Record<string, unknown> {
  return { title: cleanText(s.title, false), language: s.language, aspect: s.aspect, target_seconds: s.targetSeconds };
}

/** Every key a browser may send in a save (0166's save_film accepts these and refuses any other). */
export const SAVE_PATCH_KEYS = [
  "title",
  "source_text",
  "channel_id",
  "language",
  "aspect",
  "target_seconds",
  "resolution",
  "style_kit_id",
  "keyframe_model",
  "clip_model",
  "voice",
  "music_asset_id",
  "music_gain_db",
  "duck_db",
  "captions_mode",
  "transition_default",
  "scenes",
  "refs",
] as const;

// ─── checks before a save ────────────────────────────────────────────────────

export type ProblemCode =
  | "title_required"
  | "title_too_long"
  | "target_range"
  | "too_many_scenes"
  | "scene_title_too_long"
  | "narration_too_long"
  | "prompt_too_long"
  | "negative_too_long"
  | "seconds_range"
  | "shots_range"
  | "first_scene_previous"
  | "first_frame_picture"
  | "last_frame_picture"
  | "next_keyframe_needs_next"
  | "film_too_long"
  | "too_many_refs";

export interface Problem {
  code: ProblemCode;
  /** The scene's index (0-based) when the problem is a scene's. */
  scene?: number;
  /** The number the message names (a limit or a total), when it names one. */
  n?: number;
  /** The limit beside a total (film_too_long). */
  max?: number;
}

const len = (s: string) => [...s].length;

/** What 0166 would refuse, said before the save. The database repeats every check; this only keeps a person from a round trip. */
export function draftProblems(settings: SettingsDraft, scenes: readonly SceneDraft[], refs: readonly RefDraft[], limits: FilmLimits): Problem[] {
  const out: Problem[] = [];
  const title = cleanText(settings.title, false);
  if (len(title) < 1) out.push({ code: "title_required" });
  if (len(title) > limits.max_title_chars) out.push({ code: "title_too_long", n: limits.max_title_chars });
  if (!(Number.isInteger(settings.targetSeconds) && settings.targetSeconds >= limits.target_seconds_min && settings.targetSeconds <= limits.target_seconds_max))
    out.push({ code: "target_range" });
  if (scenes.length > limits.max_scenes) out.push({ code: "too_many_scenes", n: limits.max_scenes });
  if (refs.length > limits.max_film_refs) out.push({ code: "too_many_refs", n: limits.max_film_refs });
  let total = 0;
  scenes.forEach((s, i) => {
    total += s.plannedSeconds;
    if (len(cleanText(s.title, false)) > limits.max_title_chars) out.push({ code: "scene_title_too_long", scene: i, n: limits.max_title_chars });
    if (len(cleanText(s.narration, true)) > limits.max_narration_chars) out.push({ code: "narration_too_long", scene: i, n: limits.max_narration_chars });
    if (len(cleanText(s.visualPrompt, true)) > limits.max_prompt_chars) out.push({ code: "prompt_too_long", scene: i, n: limits.max_prompt_chars });
    if (len(cleanText(s.negativePrompt, true)) > limits.max_negative_chars) out.push({ code: "negative_too_long", scene: i, n: limits.max_negative_chars });
    if (!(Number.isInteger(s.plannedSeconds) && s.plannedSeconds >= limits.scene_seconds_min && s.plannedSeconds <= limits.scene_seconds_max))
      out.push({ code: "seconds_range", scene: i });
    if (!(Number.isInteger(s.shotCount) && s.shotCount >= 1 && s.shotCount <= limits.max_shots)) out.push({ code: "shots_range", scene: i });
    if (i === 0 && s.firstFrame === "previous") out.push({ code: "first_scene_previous", scene: i });
    if (s.firstFrame === "asset" && !s.firstFrameAssetId) out.push({ code: "first_frame_picture", scene: i });
    if (s.lastFrame === "asset" && !s.lastFrameAssetId) out.push({ code: "last_frame_picture", scene: i });
    const next = scenes[i + 1];
    if (s.lastFrame === "next_keyframe" && (!next || next.firstFrame === "previous")) out.push({ code: "next_keyframe_needs_next", scene: i });
  });
  if (total > limits.max_film_seconds) out.push({ code: "film_too_long", n: total, max: limits.max_film_seconds });
  return out;
}

// ─── where the project is (the station track) ────────────────────────────────

/**
 * The target lengths the screens offer, in seconds, all inside film_limits' 10-1200 s (0198 lowered the floor from 60). The short ones
 * are for ads (a 15-30 s ad is 1-3 scenes of 3-30 s); the long ones are a whole video, usually 3-10 minutes.
 */
export const TARGET_SECONDS = [15, 30, 60, 120, 180, 300, 480, 600, 900, 1200] as const;

/** Mixed durations keep their total seconds so callers can choose clock notation or localized units. */
export function targetLabel(seconds: number): { unit: "s" | "min" | "clock"; n: number } {
  if (seconds < 60) return { unit: "s", n: seconds };
  if (seconds % 60 === 0) return { unit: "min", n: seconds / 60 };
  return { unit: "clock", n: seconds };
}

export const STATIONS = ["idea", "storyboard", "sound", "shoot", "assemble", "handoff"] as const;
export type Station = (typeof STATIONS)[number];
export type StationState = "done" | "current" | "later";

/**
 * Each station's state from the project's real state, nothing else. A project exists, so its idea is in (done); the storyboard is where
 * every draft is (current). Sound, shooting, assembly and the handoff have no code behind them in this release, so they are "later" and
 * never lit, whatever the storyboard holds: light is information (docs/FILM_STUDIO.md, the design's principle 1).
 */
export function stationStates(): Record<Station, StationState> {
  return { idea: "done", storyboard: "current", sound: "later", shoot: "later", assemble: "later", handoff: "later" };
}

/** m:ss for a length in whole seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ─── the browser's calls ─────────────────────────────────────────────────────

export type FilmResult<T> = { ok: true; data: T } | { ok: false; error: FilmError; detail?: string };

export interface CreateFilmInput {
  source_kind: SourceKind;
  source_text: string;
  title: string;
  language: FilmLanguage;
  aspect: FilmAspect;
  target_seconds: number;
  channel_id: string | null;
  idem: string;
}

type Fetch = typeof fetch;

async function call<T>(f: Fetch, method: "GET" | "POST" | "PATCH", url: string, body: unknown, read: (j: unknown) => T | null): Promise<FilmResult<T>> {
  let res: Response;
  try {
    res = await f(url, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, ...filmErrorFromResponse(res.status, json) };
  const data = read(json);
  return data === null ? { ok: false, error: "failed" } : { ok: true, data };
}

const viewOf = (j: unknown) => coerceFilmView((j as { film?: unknown } | null)?.film);

/**
 * The browser's four calls, to the app's own routes (same origin, the session cookie). `f` is injectable for tests; it defaults to the
 * global fetch at call time.
 */
export function filmsApi(f?: Fetch) {
  const go: Fetch = (...a) => (f ?? fetch)(...a);
  return {
    list: (archived = false) =>
      call(go, "GET", `/api/films${archived ? "?archived=1" : ""}`, undefined, (j) => {
        const films = (j as { films?: unknown } | null)?.films;
        return Array.isArray(films) ? coerceFilmListItems(films) : null;
      }),
    create: (input: CreateFilmInput) => call(go, "POST", "/api/films", input, viewOf),
    get: (id: string) => call(go, "GET", `/api/films/${encodeURIComponent(id)}`, undefined, viewOf),
    save: (id: string, version: number, patch: Record<string, unknown>) =>
      call(go, "PATCH", `/api/films/${encodeURIComponent(id)}`, { version, patch }, viewOf),
    archive: (id: string) => call(go, "POST", `/api/films/${encodeURIComponent(id)}/archive`, {}, viewOf),
  };
}

/** A fresh idempotency key for one "Create" press: kept across retries of the same press, so a double submit makes one draft. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `film-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
