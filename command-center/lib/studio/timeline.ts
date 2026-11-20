/**
 * Nightshift Studio's Timeline (docs/studio/prototype/studio-timeline-prototype.html): a project (internal name: film; 0166,
 * docs/FILM_STUDIO.md) laid out as an edit page. This file is the pure part: what film_json answers, read into lanes, and the
 * quote/start answers of 0171, read into what the Assemble key may say.
 *
 * Rule 5 runs through all of it. A scene with no finished take is a draft block at its PLANNED length (never a measured one); a lane
 * with no backend (effects, ambience) is empty, never filled with a sample; a number of credits exists only once quote_film answered
 * one; a per-clip level, fade or duck control is disabled because no column holds it.
 */
import { coerceFilmView, type FilmScene, type FilmView } from "@/lib/films";

export type TrackId = "V1" | "A1" | "A2" | "A3" | "A4" | "C1";
export const TRACKS: readonly TrackId[] = ["V1", "A1", "A2", "A3", "A4", "C1"];

/** What a track's lane can hold today. `none`: no table stores it, so the lane is honestly empty and nothing can be dropped on it. */
export const TRACK_BACKEND: Record<TrackId, "scenes" | "takes" | "film" | "none"> = {
  V1: "scenes",
  A1: "takes",
  A2: "film",
  A3: "none",
  A4: "none",
  C1: "scenes",
};

/** A take as film_json names it (the columns P1's FilmTake drops). `requestedS` is the length that was REQUESTED, never a measurement. */
export interface TakeMedia {
  id: string;
  kind: string;
  status: string;
  version: number;
  shotIndex: number;
  attempt: number;
  requestedS: number | null;
  resultAssetId: string | null;
}

/** One file under a V1 block or an audio clip: placed only when the library recorded its length. */
export interface ClipSegment {
  assetId: string;
  /** Seconds from the start of the film. */
  start: number;
  length: number;
  /** Where in the file this piece starts (the worker's in-point: a chained shot skips its first frame, a trimmed head is skipped). */
  inPoint: number;
}

export interface TimelineClip {
  id: string;
  track: TrackId;
  /** Seconds from the start of the film. */
  start: number;
  length: number;
  label: string;
  /** V1: the scene this block is; C1: the scene whose narration it shows. */
  sceneId?: string;
  /** V1 only: not every shot of the chosen version has a finished take, so it is the plan, not a picture. */
  draft?: boolean;
  /** The first file to preview (shot 1 of a scene, the narration or the music). */
  assetId?: string | null;
  /** Every shot's file in order (V1). */
  assetIds?: string[];
  /** The pieces of footage the film will show in this scene's slot, only when every shot's length was measured by the library. */
  segments?: ClipSegment[];
  /** V1: every shot finished, but its usable footage is shorter than the slot: the assembly will refuse this scene (scene_too_short). */
  short?: boolean;
  /** Both seams are held and the footage is too long to trim within SEAM_TOLERANCE_S: the assembly would refuse it. */
  trim?: boolean;
  /**
   * V1: true only when the library recorded the length of every shot file and they cover the slot, so the pieces shown are known.
   * A V1 block is ALWAYS its planned seconds long (the worker trims longer footage to it); `measured` says whether the footage that
   * fills it is known. A1: true when `length` is the narration file's recorded duration. film_takes.duration_s (the requested length)
   * is never a measurement.
   */
  measured?: boolean;
}

export interface TimelineFilm {
  view: FilmView;
  musicAssetId: string | null;
  musicMissing: boolean;
  musicGainDb: number | null;
  duckDb: number | null;
  /** Film-level takes (narration, captions), with their result files. */
  filmTakes: TakeMedia[];
  /** Per scene id, its takes with their result files. */
  sceneTakes: Map<string, TakeMedia[]>;
  /** Per scene id, film_scenes.transition_in (null: the film's default). */
  sceneTransitions: Map<string, string | null>;
  /** films.transition_default. */
  transitionDefault: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function coerceTake(raw: unknown): TakeMedia | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const id = str(t.id);
  const kind = str(t.kind);
  const status = str(t.status);
  if (!id || !kind || !status) return null;
  const d = num(t.duration_s);
  return {
    id,
    kind,
    status,
    version: num(t.version) ?? 0,
    shotIndex: num(t.shot_index) ?? 0,
    attempt: num(t.attempt) ?? 1,
    requestedS: d !== null && d > 0 ? d : null,
    resultAssetId: str(t.result_asset_id),
  };
}

/** film_json's answer as the Timeline reads it, or null when it is not one (the caller says so; it never draws a guess). */
export function coerceTimelineFilm(raw: unknown): TimelineFilm | null {
  const view = coerceFilmView(raw);
  if (!view || !raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const f = (r.film && typeof r.film === "object" ? r.film : {}) as Record<string, unknown>;
  const sceneTakes = new Map<string, TakeMedia[]>();
  const sceneTransitions = new Map<string, string | null>();
  const scenesRaw = Array.isArray(r.scenes) ? r.scenes : [];
  for (const s of scenesRaw) {
    if (!s || typeof s !== "object") continue;
    const id = str((s as Record<string, unknown>).id);
    const takes = (s as Record<string, unknown>).takes;
    if (!id) continue;
    sceneTakes.set(id, (Array.isArray(takes) ? takes : []).map(coerceTake).filter((x): x is TakeMedia => x !== null));
    sceneTransitions.set(id, str((s as Record<string, unknown>).transition_in));
  }
  return {
    view,
    musicAssetId: str(f.music_asset_id),
    musicMissing: r.music_missing === true,
    musicGainDb: num(f.music_gain_db),
    duckDb: num(f.duck_db),
    filmTakes: (Array.isArray(r.takes) ? r.takes : []).map(coerceTake).filter((x): x is TakeMedia => x !== null),
    sceneTakes,
    sceneTransitions,
    transitionDefault: str(f.transition_default) ?? "cut",
  };
}

/**
 * The scene's chosen shots, exactly as the assembly worker picks them (modules/film_timeline.py `_chosen_shots`): for every shot
 * 1..shot_count of the current version (shot 1 a `clip`, later shots `extend`s), the completed take with the HIGHEST attempt, which
 * must have a result file. If any shot has none, the scene is not shot and this is null: the Timeline draws it as a draft, so it never
 * shows a scene as ready that the worker would refuse.
 */
export function chosenShots(scene: FilmScene, takes: readonly TakeMedia[]): TakeMedia[] | null {
  if (scene.currentVersion === null) return null;
  const shots: TakeMedia[] = [];
  for (let idx = 1; idx <= Math.max(1, scene.shotCount); idx++) {
    const kind = idx === 1 ? "clip" : "extend";
    const done = takes
      .filter((t) => t.kind === kind && t.shotIndex === idx && t.version === scene.currentVersion && t.status === "completed")
      .sort((a, b) => a.attempt - b.attempt);
    const take = done[done.length - 1];
    if (!take || !take.resultAssetId) return null;
    shots.push(take);
  }
  return shots;
}

/** The first chosen shot (the scene's preview picture), or null while the scene is a draft. */
export function chosenClip(scene: FilmScene, takes: readonly TakeMedia[]): TakeMedia | null {
  return chosenShots(scene, takes)?.[0] ?? null;
}

/** The chosen version's key frame (highest attempt), for a thumbnail when the clip itself is not there. */
export function chosenKeyframe(scene: FilmScene, takes: readonly TakeMedia[]): TakeMedia | null {
  if (scene.currentVersion === null) return null;
  const done = takes
    .filter((t) => t.version === scene.currentVersion && t.kind === "keyframe" && t.status === "completed" && t.resultAssetId)
    .sort((a, b) => a.attempt - b.attempt);
  return done[done.length - 1] ?? null;
}

/** The newest completed film-level narration take (highest version, then attempt): one file for the whole film. */
export function narrationTake(film: TimelineFilm): TakeMedia | null {
  const done = film.filmTakes.filter((t) => t.kind === "narration" && t.status === "completed" && t.resultAssetId);
  done.sort((a, b) => b.version - a.version || b.attempt - a.attempt);
  return done[0] ?? null;
}

export interface TimelineLayout {
  clips: TimelineClip[];
  /** Seconds: the sum of what V1 lays out (measured where the library knows a file's length, planned elsewhere). */
  duration: number;
  /** The film's planned seconds (film_json's totals): the chip in the tools row. */
  planned: number;
}

/** A recorded length in seconds for each asset id the library has probed (GET /api/media's `asset.durationS`). */
export type AssetDurations = ReadonlyMap<string, number>;

/** The assembly worker's constants (modules/film_timeline.py), seconds. */
export const CHAIN_SKIP_S = 0.042;
export const CROSSFADE_S = 0.5;
export const MIN_PIECE_S = 1.0;
export const SEAM_TOLERANCE_S = 0.1;

/** The worker counts whole milliseconds (`_ms`); comparing floats here would judge footage within half a millisecond differently. */
const ms = (seconds: number) => Math.round(seconds * 1000);

/** The way into scene `i`, as the worker reads it: the first scene, and one that continues the previous, cut in. */
function transitionIn(scenes: readonly FilmScene[], i: number, film: Pick<TimelineFilm, "sceneTransitions" | "transitionDefault">): string {
  const scene = scenes[i];
  if (i === 0 || scene.firstFrame === "previous") return "cut";
  return film.sceneTransitions.get(scene.id) ?? film.transitionDefault;
}

/**
 * Which footage fills one scene's slot, as the assembly worker cuts it (modules/film_timeline.py, the picture loop):
 * - every scene is exactly its planned seconds on screen; a cross-fade in needs CROSSFADE_S more footage at its head;
 * - a chained shot (shot 2+, or shot 1 of a scene that continues the previous one) skips its first CHAIN_SKIP_S;
 * - the window starts at the footage's start, or ends at its end when the NEXT scene continues this one;
 * - when the way out is not a cut, the window moves later so its last piece is at least MIN_PIECE_S long.
 * Each of the worker's refusals is mirrored, so a scene drawn ready is one the worker accepts (Lens round 4):
 * - `short`: too little footage for the slot, or for the MIN_PIECE_S the way out needs (scene_too_short);
 * - `trim`: both seams are held and there is more than SEAM_TOLERANCE_S of extra footage to lose (continuity_trim).
 */
export function sceneWindow(
  scenes: readonly FilmScene[],
  i: number,
  shots: readonly TakeMedia[],
  durations: AssetDurations,
  film: Pick<TimelineFilm, "sceneTransitions" | "transitionDefault">,
  blockStart: number,
):
  | { state: "unknown" }
  | { state: "short"; usable: number; need: number }
  | { state: "trim"; extra: number }
  | { state: "ok"; segments: ClipSegment[] } {
  const scene = scenes[i];
  const continues = i > 0 && scene.firstFrame === "previous";
  const headMs = transitionIn(scenes, i, film) === "crossfade" ? ms(CROSSFADE_S) : 0;
  const pieces: { assetId: string; inMs: number; usable: number; off: number }[] = [];
  let off = 0;
  for (let k = 0; k < shots.length; k++) {
    const assetId = shots[k].resultAssetId as string;
    const d = durations.get(assetId);
    if (typeof d !== "number" || !(d > 0)) return { state: "unknown" };
    const chained = k > 0 || continues;
    const inMs = chained ? ms(CHAIN_SKIP_S) : 0;
    const usable = Math.max(0, ms(d) - inMs);
    pieces.push({ assetId, inMs, usable, off });
    off += usable;
  }
  const total = off;
  const need = scene.plannedSeconds * 1000 + headMs;
  if (total < need) return { state: "short", usable: total / 1000, need: need / 1000 };
  const keepEnd = i + 1 < scenes.length && scenes[i + 1].firstFrame === "previous";
  let x = keepEnd ? total - need : 0;
  if (keepEnd && continues && x > ms(SEAM_TOLERANCE_S)) return { state: "trim", extra: x / 1000 };
  const outTr = i + 1 < scenes.length ? transitionIn(scenes, i + 1, film) : "cut";
  if (!keepEnd && outTr !== "cut") {
    const last = [...pieces].reverse().find((p) => p.off < need) as (typeof pieces)[number];
    const short = ms(MIN_PIECE_S) - (need - last.off);
    if (short > 0 && last !== pieces[0]) {
      if (continues || need + short > total) return { state: "short", usable: total / 1000, need: (need + short) / 1000 };
      x = short;
    }
  }
  const segments: ClipSegment[] = [];
  // The head of a cross-fade overlaps the previous scene; the preview shows the scene from its own start, after the head.
  let at = blockStart;
  for (const p of pieces) {
    const lo = Math.max(x + headMs, p.off);
    const hi = Math.min(x + need, p.off + p.usable);
    if (hi > lo) {
      segments.push({ assetId: p.assetId, start: at, length: (hi - lo) / 1000, inPoint: (p.inMs + lo - p.off) / 1000 });
      at += (hi - lo) / 1000;
    }
  }
  return { state: "ok", segments };
}

/**
 * The lanes. V1 is the scenes in their saved order, every block exactly its planned seconds long, as in the assembled film. A scene
 * whose every shot finished is drawn shot; its footage is placed inside the slot as the worker will cut it once the library has the
 * length of every file (`measured`), and flagged `short` when that footage cannot fill the slot (the assembly would refuse it). A scene
 * not fully shot is a dashed draft. C1 is each scene's narration text over the same span. A1 is the film's narration file, A2 its
 * music, each only when the file exists. A3 and A4 are always empty: no table stores an effect or an ambience clip.
 */
export function layoutTimeline(film: TimelineFilm, durations: AssetDurations = new Map()): TimelineLayout {
  const clips: TimelineClip[] = [];
  const scenes = film.view.scenes;
  let t = 0;
  scenes.forEach((scene, i) => {
    const takes = film.sceneTakes.get(scene.id) ?? [];
    const shots = chosenShots(scene, takes);
    const ids = shots ? shots.map((s) => s.resultAssetId as string) : [];
    const win = shots ? sceneWindow(scenes, i, shots, durations, film, t) : null;
    const length = scene.plannedSeconds;
    const n = String(i + 1).padStart(2, "0");
    clips.push({
      id: `v1:${scene.id}`,
      track: "V1",
      start: t,
      length,
      label: scene.title ? `${n} · ${scene.title}` : n,
      sceneId: scene.id,
      draft: !shots,
      short: win?.state === "short",
      trim: win?.state === "trim",
      assetId: ids[0] ?? null,
      assetIds: ids,
      segments: win?.state === "ok" ? win.segments : undefined,
      measured: win?.state === "ok",
    });
    const words = scene.narration.trim();
    if (words) clips.push({ id: `c1:${scene.id}`, track: "C1", start: t, length, label: words, sceneId: scene.id, measured: false });
    t += length;
  });
  const narr = narrationTake(film);
  if (narr?.resultAssetId) {
    const d = durations.get(narr.resultAssetId);
    clips.push({ id: `a1:${narr.id}`, track: "A1", start: 0, length: d ?? t, label: "", assetId: narr.resultAssetId, measured: d !== undefined });
  }
  if (film.musicAssetId && !film.musicMissing && t > 0) {
    clips.push({ id: `a2:${film.musicAssetId}`, track: "A2", start: 0, length: t, label: "", assetId: film.musicAssetId, measured: false });
  }
  return { clips, duration: t, planned: film.view.totals.plannedSeconds };
}

/** Where a time falls: the V1 block under it (the scene playing), or null past the end. */
export function sceneAt(clips: readonly TimelineClip[], seconds: number): TimelineClip | null {
  const v = clips.filter((c) => c.track === "V1");
  return v.find((c) => seconds >= c.start && seconds < c.start + c.length) ?? (seconds >= 0 && v.length && seconds === v[v.length - 1].start + v[v.length - 1].length ? v[v.length - 1] : null);
}

/**
 * What the viewer plays at a time: the file under it and where in that file, inside the worker's window (its in-points), only where
 * the scene's footage is measured. Otherwise the scene's first shot plays from its start and the clock runs by real time, so nothing
 * jumps at a block's end; a short scene plays what footage it has and then shows nothing more.
 */
export function segmentAt(clip: TimelineClip | null, seconds: number): { assetId: string; offset: number; measured: boolean; segment?: ClipSegment } | null {
  if (!clip || !clip.assetId) return null;
  if (clip.measured && clip.segments?.length) {
    const seg = clip.segments.find((s) => seconds >= s.start && seconds < s.start + s.length) ?? clip.segments[clip.segments.length - 1];
    const into = Math.max(0, Math.min(seg.length, seconds - seg.start));
    return { assetId: seg.assetId, offset: seg.inPoint + into, measured: true, segment: seg };
  }
  return { assetId: clip.assetId, offset: Math.max(0, seconds - clip.start), measured: false };
}

export const FPS = 25;

/** HH:MM:SS:FF at 25 frames a second (the reference's timecode). */
export function timecode(seconds: number): string {
  // Counted in whole frames, with a hair of tolerance: 3723.52 s is frame 13 of its second, not 12 from a float's 12.999….
  const frames = Math.floor(Math.max(0, seconds) * FPS + 1e-6);
  const whole = Math.floor(frames / FPS);
  const ff = frames % FPS;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(whole / 3600))}:${p(Math.floor((whole % 3600) / 60))}:${p(whole % 60)}:${p(ff)}`;
}

/** Move one scene from `from` to `to` in the saved order, as the ids save_film is sent. */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

// ─── keyboard ────────────────────────────────────────────────────────────────

/** Elements that own their keys: a shortcut never takes Space or an arrow from them. */
const OWNS_KEYS =
  "input, textarea, select, button, a[href], summary, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='button'], [role='tab'], [role='slider'], [role='menuitem'], [role='dialog'], [data-no-shortcuts]";

/**
 * May a Timeline shortcut act on this key press? Only when focus is on the page itself or on the timeline's own surfaces (the viewer,
 * the lanes; marked `data-tl-surface`), never on something that owns its keys (a button, a link, a tab, a slider, a field, a dialog),
 * and never inside the inspector: the canvas once took Space and arrows from a person typing in its composer, and Space on a focused
 * button must press the button, not play the film.
 */
export function shortcutAllowed(target: EventTarget | null, inspector: Element | null): boolean {
  if (!target || typeof (target as Node).nodeType !== "number") return true;
  const el = target as HTMLElement;
  if (el === el.ownerDocument?.body || el === el.ownerDocument?.documentElement) return true;
  if (inspector && inspector.contains(el)) return false;
  if (el.isContentEditable) return false;
  if (el.closest?.(OWNS_KEYS)) return false;
  return Boolean(el.closest?.("[data-tl-surface]"));
}

export type TimelineKey = "toggle" | "back" | "pause" | "forward" | "prevFrame" | "nextFrame" | "markIn" | "markOut";

export function keyAction(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey">): TimelineKey | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.code === "Space" || e.key === " ") return "toggle";
  switch (e.key.toLowerCase()) {
    case "j":
      return "back";
    case "k":
      return "pause";
    case "l":
      return "forward";
    case "i":
      return "markIn";
    case "o":
      return "markOut";
  }
  if (e.key === "ArrowLeft") return "prevFrame";
  if (e.key === "ArrowRight") return "nextFrame";
  return null;
}

// ─── the money (0171's quote_film / start_film) ──────────────────────────────

export const QUOTE_BLOCKS = ["film_studio_disabled", "insufficient_credits", "cap_exceeded", "limit_reached", "run_slots_full"] as const;
export type QuoteBlock = (typeof QUOTE_BLOCKS)[number] | "other";

export interface FilmQuote {
  priced: boolean;
  /** Credits, only when the database priced every line. */
  total: number | null;
  quoteId: string | null;
  startable: boolean;
  mayStart: boolean;
  blockedBy: QuoteBlock[];
  /** The first unpriced line's reason (model_not_available, unpriced…), when the film could not be priced. */
  refusal: string | null;
  /** Minutes of assembly the quote counts (film_assembly_minute). */
  assemblyMinutes: number | null;
  available: number | null;
  exempt: boolean;
}

/** quote_film's answer, or null when it is not one. A missing total is null, never 0 (0171 says so in the line itself). */
export function coerceQuote(raw: unknown): FilmQuote | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  if (typeof q.priced !== "boolean") return null;
  const total = q.priced ? num(q.total) : null;
  const quoteId = typeof q.quote_id === "string" && /^fq-[0-9]{1,9}-[0-9a-f]{32}$/.test(q.quote_id) ? q.quote_id : null;
  const priced = q.priced && total !== null && quoteId !== null;
  const blocked = Array.isArray(q.blocked_by) ? q.blocked_by : [];
  const blockedBy = blocked.map((b) => {
    const r = b && typeof b === "object" ? (b as Record<string, unknown>).reason : null;
    return (QUOTE_BLOCKS as readonly string[]).includes(String(r)) ? (r as QuoteBlock) : "other";
  });
  const refusals = Array.isArray(q.refusals) ? q.refusals : [];
  const first = refusals[0] && typeof refusals[0] === "object" ? (refusals[0] as Record<string, unknown>).reason : null;
  return {
    priced,
    total: priced ? total : null,
    quoteId: priced ? quoteId : null,
    startable: priced && q.startable === true,
    mayStart: q.may_start === true,
    blockedBy,
    refusal: typeof first === "string" && /^[a-z0-9_]{1,64}$/.test(first) ? first : null,
    assemblyMinutes: num(q.assembly_minutes),
    available: num(q.available),
    exempt: q.exempt === true,
  };
}

export type StartOutcome =
  | { ok: true; replayed: boolean }
  | { ok: false; reason: (typeof START_REASONS)[number] | "other" };

const START_REASONS = ["insufficient_credits", "quote_expired", "price_changed", "film_changed", "film_studio_disabled", "film_not_startable", "reference_missing", "run_slots_full", "limit_reached", "cap_exceeded"] as const;

/** start_film's answer (refusals that counted come back as `ok: false` rows, not errors). */
export function coerceStart(raw: unknown): StartOutcome {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (r.ok === true) return { ok: true, replayed: r.replayed === true };
  const reason = (START_REASONS as readonly string[]).includes(String(r.reason)) ? (r.reason as (typeof START_REASONS)[number]) : "other";
  return { ok: false, reason };
}

/**
 * What the Assemble key says. `none`: no number at all (nothing quoted yet, or the quote could not price). `credits`: the backend's
 * total. The key never computes a price: it shows the one number quote_film answered, or nothing.
 */
export function assembleLabel(q: FilmQuote | null): { kind: "none" } | { kind: "credits"; total: number } {
  return q && q.priced && q.total !== null ? { kind: "credits", total: q.total } : { kind: "none" };
}

// ─── polling ─────────────────────────────────────────────────────────────────

/** What one read tells the poller: carry on, back off (a failed read), or stop for good (the project is gone or the session ended). */
export type PollVerdict = "ok" | "error" | "stop";

type Timers = { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (h: ReturnType<typeof setTimeout>) => void };

/**
 * A poller that survives a failed read (the canvas once stopped polling for good after one rejected fetch) without hammering a
 * server that is failing: each failed or thrown read doubles the wait up to `maxMs`, a good one resets it, and a `stop` verdict ends
 * the loop. `pause()`/`resume()` let the page stop reading while it is hidden; `resume` reads at once.
 */
export function startPolling(
  read: () => Promise<PollVerdict | unknown>,
  everyMs: number,
  timers: Timers = {
    // Wrapped: a browser's setTimeout called as a method of another object throws "Illegal invocation".
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h),
  },
  maxMs = everyMs * 8,
) {
  let stopped = false;
  let paused = false;
  let wait = everyMs;
  let handle: ReturnType<typeof setTimeout> | null = null;
  const schedule = (ms: number) => {
    if (handle !== null) timers.clear(handle);
    handle = stopped || paused ? null : timers.set(() => void tick(), ms);
  };
  const tick = async () => {
    handle = null;
    if (stopped || paused) return;
    let verdict: unknown;
    try {
      verdict = await read();
    } catch {
      verdict = "error";
    }
    if (verdict === "stop") stopped = true;
    wait = verdict === "error" ? Math.min(maxMs, wait * 2) : everyMs;
    schedule(wait);
  };
  schedule(everyMs);
  return {
    stop() {
      stopped = true;
      if (handle !== null) timers.clear(handle);
      handle = null;
    },
    pause() {
      paused = true;
      if (handle !== null) timers.clear(handle);
      handle = null;
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      void tick();
    },
    get stopped() {
      return stopped;
    },
  };
}

// ─── one start per press ─────────────────────────────────────────────────────

/**
 * The Assemble press: one request in flight at a time, and one idempotency key per confirmed quote, kept across retries, so a double
 * press or a retry after a network error is the same start (0171 answers the first segment, `replayed`), never a second hold.
 * `reset()` forgets the key once a start succeeded or the quote changed.
 */
export function startOnce<T>(send: (idem: string) => Promise<T>, newKey: () => string) {
  let inflight: Promise<T> | null = null;
  let idem: string | null = null;
  return {
    run(): Promise<T> {
      if (inflight) return inflight;
      idem ??= newKey();
      inflight = send(idem).finally(() => {
        inflight = null;
      });
      return inflight;
    },
    reset() {
      idem = null;
    },
    get busy() {
      return inflight !== null;
    },
  };
}

/** Someone (a person, or later an MCP agent over Realtime) working on a clip. The product passes none until that data is real. */
export interface TimelineActor {
  id: string;
  name: string;
  /** A CSS colour for the ring and the pill. */
  color: string;
  /** What they are doing, in their own words ("trimming 03"). */
  doing?: string;
}
