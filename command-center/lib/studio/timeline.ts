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

/** A finished take's picture, as film_json names it (the columns P1's FilmTake drops). */
export interface TakeMedia {
  id: string;
  kind: string;
  status: string;
  version: number;
  shotIndex: number;
  durationS: number | null;
  resultAssetId: string | null;
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
  /** V1 only: no finished clip take, so it is the plan, not a picture. */
  draft?: boolean;
  /** The media asset to preview (a finished clip take's result, the film's narration or music file). */
  assetId?: string | null;
  /** Whether `length` is the take's measured duration (true) or the scene's planned seconds (false). */
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
    durationS: d !== null && d > 0 ? d : null,
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
  const scenesRaw = Array.isArray(r.scenes) ? r.scenes : [];
  for (const s of scenesRaw) {
    if (!s || typeof s !== "object") continue;
    const id = str((s as Record<string, unknown>).id);
    const takes = (s as Record<string, unknown>).takes;
    if (id) sceneTakes.set(id, (Array.isArray(takes) ? takes : []).map(coerceTake).filter((x): x is TakeMedia => x !== null));
  }
  return {
    view,
    musicAssetId: str(f.music_asset_id),
    musicMissing: r.music_missing === true,
    musicGainDb: num(f.music_gain_db),
    duckDb: num(f.duck_db),
    filmTakes: (Array.isArray(r.takes) ? r.takes : []).map(coerceTake).filter((x): x is TakeMedia => x !== null),
    sceneTakes,
  };
}

/**
 * The scene's chosen picture: the completed clip take of its current version (0166: current_version is the chosen one), else none.
 * A scene never shot has current_version null, and is a draft whatever takes are planned or running.
 */
export function chosenClip(scene: FilmScene, takes: readonly TakeMedia[]): TakeMedia | null {
  if (scene.currentVersion === null) return null;
  const done = takes.filter((t) => t.version === scene.currentVersion && t.status === "completed" && t.resultAssetId && (t.kind === "clip" || t.kind === "extend"));
  done.sort((a, b) => a.shotIndex - b.shotIndex);
  return done[0] ?? null;
}

/** The chosen version's key frame, for a thumbnail when the clip itself is not there. */
export function chosenKeyframe(scene: FilmScene, takes: readonly TakeMedia[]): TakeMedia | null {
  if (scene.currentVersion === null) return null;
  return takes.find((t) => t.version === scene.currentVersion && t.kind === "keyframe" && t.status === "completed" && t.resultAssetId) ?? null;
}

/** The newest completed film-level narration take: one file for the whole film (0171's narration line). */
export function narrationTake(film: TimelineFilm): TakeMedia | null {
  const done = film.filmTakes.filter((t) => t.kind === "narration" && t.status === "completed" && t.resultAssetId);
  done.sort((a, b) => b.version - a.version);
  return done[0] ?? null;
}

export interface TimelineLayout {
  clips: TimelineClip[];
  /** Seconds: the sum of what V1 lays out (planned where nothing was measured). */
  duration: number;
  /** The film's planned seconds (film_json's totals): the chip in the tools row. */
  planned: number;
}

/**
 * The lanes. V1 is the scenes in their saved order, each as long as its chosen clip measured, else its planned seconds (a draft).
 * C1 is each scene's narration text over the same span. A1 is the film's narration take when one finished, else nothing. A2 is the
 * film's music file across the film when one is set. A3 and A4 are always empty: no table stores an effect or an ambience clip.
 */
export function layoutTimeline(film: TimelineFilm): TimelineLayout {
  const clips: TimelineClip[] = [];
  let t = 0;
  film.view.scenes.forEach((scene, i) => {
    const takes = film.sceneTakes.get(scene.id) ?? [];
    const clip = chosenClip(scene, takes);
    const length = clip?.durationS ?? scene.plannedSeconds;
    const n = String(i + 1).padStart(2, "0");
    clips.push({
      id: `v1:${scene.id}`,
      track: "V1",
      start: t,
      length,
      label: scene.title ? `${n} · ${scene.title}` : n,
      sceneId: scene.id,
      draft: !clip,
      assetId: clip?.resultAssetId ?? null,
      measured: Boolean(clip?.durationS),
    });
    const words = scene.narration.trim();
    if (words) clips.push({ id: `c1:${scene.id}`, track: "C1", start: t, length, label: words, sceneId: scene.id, measured: false });
    t += length;
  });
  const narr = narrationTake(film);
  if (narr) {
    clips.push({ id: `a1:${narr.id}`, track: "A1", start: 0, length: narr.durationS ?? t, label: "", assetId: narr.resultAssetId, measured: Boolean(narr.durationS) });
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

/**
 * May a Timeline shortcut act on this key press? Never while a person types (an input, a text area, a select, anything editable), and
 * never with focus inside the inspector: the canvas once took Space and arrows from a person typing in its composer.
 */
export function shortcutAllowed(target: EventTarget | null, inspector: Element | null): boolean {
  if (!target || typeof (target as Node).nodeType !== "number") return true;
  const el = target as HTMLElement;
  if (inspector && inspector.contains(el)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (el.isContentEditable) return false;
  if (el.closest?.("[contenteditable=''], [contenteditable='true'], [role='textbox'], [data-no-shortcuts]")) return false;
  return true;
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

const START_REASONS = ["insufficient_credits", "quote_expired", "price_changed", "film_changed", "film_studio_disabled", "film_not_startable", "run_slots_full", "limit_reached", "cap_exceeded"] as const;

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

/**
 * A poller that survives a failed read: the canvas once stopped polling for good after one rejected fetch. Each tick runs `read`;
 * whatever it does (resolve, reject, throw), the next tick is scheduled until `stop()`.
 */
export function startPolling(read: () => Promise<unknown>, everyMs: number, timers: { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (h: ReturnType<typeof setTimeout>) => void } = {
    // Wrapped: a browser's setTimeout called as a method of another object throws "Illegal invocation".
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h),
  },
) {
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      await read();
    } catch {
      // Said by the caller's own state; the loop's job is only to come back.
    }
    if (!stopped) handle = timers.set(() => void tick(), everyMs);
  };
  handle = timers.set(() => void tick(), everyMs);
  return {
    stop() {
      stopped = true;
      if (handle !== null) timers.clear(handle);
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
