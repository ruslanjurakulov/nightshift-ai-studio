/**
 * The live lane under the Studio's canvas, as data (docs/studio/S3_GAPS.md, G2-G4). Pure: a FilmReading (lib/studio/liveGraph.ts)
 * in, the pieces of the lane, the landings between two readings and the activity lines out. No UI, no fetch, no write.
 *
 * Rule 5 runs through every field. A piece is `landed` only when a completed take recorded its file; a length is `lengthKnown`
 * only when the library measured that file (film_takes.duration_s is the REQUESTED length, a scene's share is a plan); a start is
 * null once any earlier scene has no planned seconds; a master whose table cannot be read is `unknown`, never `pending`.
 */
import type { Activity, FilmReading } from "@/lib/studio/liveGraph";
import type { AssetDurations, TakeMedia } from "@/lib/studio/timeline";

export type { AssetDurations } from "@/lib/studio/timeline";

/**
 * - landed: a completed take (or assembly) with its recorded file
 * - working: a row says it is running now
 * - pending: planned or queued, or no row yet while the film has not got there
 * - failed / skipped: a row says so
 * - retried: the first attempt failed and its attempt-2 sibling has not begun yet (the slot's take is the sibling)
 * - unknown: no row can say (an unreadable table, a status this build does not know, a completed take with no file)
 */
export type PieceState = "landed" | "working" | "pending" | "failed" | "retried" | "skipped" | "unknown";

export interface LanePiece {
  /** Stable per SLOT across readings (not per take), so a retry or a refresh is compared with the same piece. */
  id: string;
  track: "video" | "audio" | "master";
  /** The take that drives the slot now (the newest attempt), or null when there is no row. */
  takeId: string | null;
  sceneId: string | null;
  /** 1-based, in scene position order. */
  scene: number | null;
  /** 1-based shot within the scene (film_takes.shot_index of a clip or extend). */
  shot: number | null;
  tag: string;
  state: PieceState;
  /** Seconds from the start of the film; null once an earlier scene has no planned seconds. */
  start: number | null;
  length: number | null;
  /** True only when `length` is the library's recorded duration of this piece's file. */
  lengthKnown: boolean;
  assetId: string | null;
  /** The stored error word (film_takes.error_code, or the master's reason), for the UI to map to a remedy. */
  error: string | null;
}

export interface LiveLane {
  video: LanePiece[];
  audio: LanePiece[];
  master: LanePiece | null;
  /** The film's planned seconds: the sum of its scenes' planned seconds. */
  planned: number;
  /** How many pieces (video, audio and master) are landed. */
  landed: number;
  total: number;
}

/**
 * The assembled master as the lane reads it. Stream S4 will publish its own read model; until then `masterFromSegments` builds one
 * from film_segments. `not_assembled` is "not assembled yet", `unknown` is "cannot be read".
 */
export interface MasterReading {
  state: "not_assembled" | "assembling" | "ready" | "failed" | "unknown";
  assetId: string | null;
  reason: string | null;
}

const BEFORE_WORK = new Set(["draft", "planning", "planned", "queued"]);
const IN_FLIGHT = new Set(["running", "draining", "paused"]);

const pad2 = (n: number) => String(n).padStart(2, "0");
const positive = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** A slot with no row: pending while the film has not got there; once the run is over, nothing can say. */
function noRow(filmStatus: string): PieceState {
  return BEFORE_WORK.has(filmStatus) || IN_FLIGHT.has(filmStatus) ? "pending" : "unknown";
}

function takeState(t: TakeMedia): PieceState {
  switch (t.status) {
    case "planned":
    case "queued":
      return "pending";
    case "running":
      return "working";
    // A completed row with no file is not a landing: nothing exists to place or play.
    case "completed":
      return t.resultAssetId ? "landed" : "unknown";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

interface Slot {
  take: TakeMedia | null;
  state: PieceState;
  error: string | null;
}

/**
 * One slot's rows (one kind and shot of the chosen version) read as a piece's take and state. The newest non-superseded attempt
 * drives it; a superseded row is history, except that while its attempt+1 sibling still waits the slot says `retried` (and why).
 */
function slot(rows: readonly TakeMedia[], errors: ReadonlyMap<string, string>, filmStatus: string): Slot {
  if (rows.length === 0) return { take: null, state: noRow(filmStatus), error: null };
  const live = rows.filter((t) => t.status !== "superseded").sort((a, b) => b.attempt - a.attempt);
  const take = live[0] ?? null;
  if (!take) {
    // Superseded with no sibling is P7's re-shoot or a row this build cannot place: not a state to guess.
    const newest = [...rows].sort((a, b) => b.attempt - a.attempt)[0];
    return { take: newest, state: "unknown", error: errors.get(newest.id) ?? null };
  }
  const state = takeState(take);
  const before = rows.find((t) => t.status === "superseded" && t.attempt === take.attempt - 1);
  if (before && state === "pending") return { take, state: "retried", error: errors.get(before.id) ?? null };
  return { take, state, error: state === "failed" ? (errors.get(take.id) ?? null) : null };
}

/** The rows of the version that counts: the scene's current version, or (no migration writes it yet) the newest one present. */
function ofVersion(rows: readonly TakeMedia[], version: number | null): TakeMedia[] {
  const v = version ?? rows.reduce((m, t) => Math.max(m, t.version), Number.NEGATIVE_INFINITY);
  return rows.filter((t) => t.version === v);
}

/** The newest film_segments row's assembly, as a MasterReading, under today's contract (docs/studio/NIGHTSHIFT_AI.md, P3). */
export function masterFromSegments(reading: FilmReading): MasterReading | null {
  const fs = reading.film.view.film.status;
  if (reading.segments === null) return { state: "unknown", assetId: null, reason: null };
  const seg = [...reading.segments].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0] ?? null;
  if (!seg) {
    if (fs === "draft") return null;
    return { state: BEFORE_WORK.has(fs) || IN_FLIGHT.has(fs) ? "not_assembled" : "unknown", assetId: null, reason: null };
  }
  switch (seg.assemblyStatus) {
    case "planned":
      return { state: "not_assembled", assetId: null, reason: null };
    // The segment settled without an assembly: nothing was made, and the row says so.
    case "skipped":
      return { state: "not_assembled", assetId: null, reason: "skipped" };
    case "running":
      return { state: "assembling", assetId: null, reason: null };
    case "completed":
      // Completed with no recorded file: the master cannot be placed or played, so it is not "ready".
      return seg.assemblyAssetId ? { state: "ready", assetId: seg.assemblyAssetId, reason: null } : { state: "unknown", assetId: null, reason: null };
    case "failed":
      // films.pause_reason is the word the worker handed to the settle; `assembly_failed` is the contract's own word when none was.
      return { state: "failed", assetId: null, reason: reading.pauseReason ?? "assembly_failed" };
    default:
      return { state: "unknown", assetId: null, reason: null };
  }
}

const MASTER_STATE: Record<MasterReading["state"], PieceState> = {
  not_assembled: "pending",
  assembling: "working",
  ready: "landed",
  failed: "failed",
  unknown: "unknown",
};

/** A piece's length: the file's recorded duration, else the requested or planned seconds marked as not measured. */
function lengthOf(assetId: string | null, durations: AssetDurations, ...fallbacks: (number | null | undefined)[]): { length: number | null; lengthKnown: boolean } {
  const d = assetId ? durations.get(assetId) : undefined;
  if (positive(d)) return { length: d, lengthKnown: true };
  const f = fallbacks.find(positive);
  return { length: f ?? null, lengthKnown: false };
}

/**
 * The lane of one reading: every clip shot slot of the chosen version in scene position order, the film's narration, and the
 * master. `master` overrides film_segments (S4's read model); omitted, it is built from the segments.
 */
export function liveLane(reading: FilmReading, durations: AssetDurations, master?: MasterReading | null): LiveLane {
  const fs = reading.film.view.film.status;
  const scenes = [...reading.film.view.scenes].sort((a, b) => a.position - b.position);
  const video: LanePiece[] = [];
  let clock: number | null = 0;
  let planned = 0;

  scenes.forEach((scene, i) => {
    const shots = Math.max(1, scene.shotCount);
    const sceneSeconds = positive(scene.plannedSeconds) ? scene.plannedSeconds : null;
    const share = sceneSeconds !== null ? sceneSeconds / shots : null;
    const takes = ofVersion(reading.film.sceneTakes.get(scene.id) ?? [], scene.currentVersion);
    for (let idx = 1; idx <= shots; idx++) {
      const kind = idx === 1 ? "clip" : "extend";
      const s = slot(
        takes.filter((t) => t.kind === kind && t.shotIndex === idx),
        reading.errors,
        fs,
      );
      const assetId = s.state === "landed" ? (s.take?.resultAssetId ?? null) : null;
      video.push({
        id: `v:${scene.id}:${idx}`,
        track: "video",
        takeId: s.take?.id ?? null,
        sceneId: scene.id,
        scene: i + 1,
        shot: idx,
        tag: `clip-${pad2(i + 1)}${shots > 1 ? `.${idx}` : ""}`,
        state: s.state,
        start: clock !== null && share !== null ? clock + (idx - 1) * share : null,
        ...lengthOf(assetId, durations, s.take?.requestedS, share),
        assetId,
        error: s.error,
      });
    }
    // A scene with no planned seconds leaves every later start unknown: a start after a guessed gap is a guess too.
    clock = clock !== null && sceneSeconds !== null ? clock + sceneSeconds : null;
    planned += sceneSeconds ?? 0;
  });

  const audio: LanePiece[] = [];
  const narration = reading.film.filmTakes.filter((t) => t.kind === "narration" && t.shotIndex === 0);
  // Once work started, a film with no narration row did not ask for one (as filmGraph reads it): no piece, not a pending one.
  if (narration.length > 0 || BEFORE_WORK.has(fs) || fs === "running") {
    const s = slot(ofVersion(narration, null), reading.errors, fs);
    const assetId = s.state === "landed" ? (s.take?.resultAssetId ?? null) : null;
    audio.push({
      id: "a:narration",
      track: "audio",
      takeId: s.take?.id ?? null,
      sceneId: null,
      scene: null,
      shot: null,
      tag: "voice",
      state: s.state,
      start: 0,
      ...lengthOf(assetId, durations, s.take?.requestedS, planned),
      assetId,
      error: s.error,
    });
  }

  const m = master === undefined ? masterFromSegments(reading) : master;
  const masterPiece: LanePiece | null = m
    ? {
        id: "m:master",
        track: "master",
        takeId: null,
        sceneId: null,
        scene: null,
        shot: null,
        tag: "master",
        // `ready` without a file is not a landing (rule 5): there is nothing to play.
        state: m.state === "ready" && !m.assetId ? "unknown" : MASTER_STATE[m.state],
        start: 0,
        ...lengthOf(m.state === "ready" ? m.assetId : null, durations, planned),
        assetId: m.state === "ready" ? m.assetId : null,
        error: m.state === "failed" ? m.reason : null,
      }
    : null;

  const all = [...video, ...audio, ...(masterPiece ? [masterPiece] : [])];
  return { video, audio, master: masterPiece, planned, landed: all.filter((p) => p.state === "landed").length, total: all.length };
}

/**
 * The pieces that landed between two readings: the tags to fly. With no previous reading (the first read after mount, or a
 * refresh) nothing flies: a restore must never replay every landing.
 */
export function landedSince(prev: LiveLane | null, next: LiveLane): LanePiece[] {
  if (prev === null) return [];
  const before = new Map([...prev.video, ...prev.audio, ...(prev.master ? [prev.master] : [])].map((p) => [p.id, p.state]));
  return [...next.video, ...next.audio, ...(next.master ? [next.master] : [])].filter((p) => p.state === "landed" && before.get(p.id) !== "landed");
}

/* ------------------------------------------------------------------ activity --------------------------------------------------- */

export type LogFamily = "clip" | "key" | "voice" | "asm" | "seg" | "film" | "log";

/**
 * One activity line in the reference ("agentcut") style: one per recorded film_events row, never a simulated one. Only row facts
 * are kept: the event word, the time, the scene, and from `detail` only a validated kind, shot_index and take_id. The worker's id
 * (an internal host name), credits and every free-text detail are never copied.
 */
export interface LogLine {
  /** `f:<film_events.id>`, the same key the Activity panel gives the row. */
  id: string;
  at: string;
  tag: string;
  family: LogFamily;
  /** The event word as recorded; the UI says a sentence for the words it knows and shows any other as this code. */
  word: string;
  scene: number | null;
  shot: number | null;
  takeId: string | null;
}

const KIND_WORD = /^[a-z][a-z_]{0,30}$/;
const EVENT_WORD = /^[a-z][a-z0-9_.]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILM_WORDS = new Set(["created", "saved", "started", "start_refused", "archived"]);

const recOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const shotOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 99 ? v : null);

/** Clip and extend tags read like the lane's (`clip-03.2`); `.n` only when the scene has more than one shot. */
function takeTag(kind: string | null, scene: number | null, shot: number | null, shots: number | null): { tag: string; family: LogFamily } {
  const sc = scene !== null ? `-${pad2(scene)}` : "";
  if (kind === "keyframe") return { tag: `key${sc}`, family: "key" };
  if (kind === "clip" || kind === "extend") {
    const multi = shots === null || shots > 1;
    return { tag: `clip${sc}${scene !== null && shot !== null && shot > 0 && multi ? `.${shot}` : ""}`, family: "clip" };
  }
  if (kind === "narration") return { tag: "voice", family: "voice" };
  return { tag: kind ?? "take", family: "log" };
}

/**
 * The film's recorded events (FilmReading.rawEvents, film_json's newest 50) as activity lines, oldest first. A take event's tag
 * comes from its row: `detail.kind` and `detail.shot_index` when they are plain values, else the take it names in this reading
 * (take_failed and take_retried carry no shot_index). `activity` is the panel's gathered list: lines it holds that this reading no
 * longer has (older than the newest 50) keep their word and time, tagged from the word alone.
 */
export function logLines(reading: FilmReading, activity?: Activity | null): LogLine[] {
  const scenes = [...reading.film.view.scenes].sort((a, b) => a.position - b.position);
  const sceneNo = new Map(scenes.map((s, i) => [s.id, i + 1]));
  const shotCount = new Map(scenes.map((s) => [s.id, Math.max(1, s.shotCount)]));
  const takes = new Map<string, { take: TakeMedia; sceneId: string | null }>();
  for (const [sceneId, rows] of reading.film.sceneTakes) for (const t of rows) takes.set(t.id, { take: t, sceneId });
  for (const t of reading.film.filmTakes) takes.set(t.id, { take: t, sceneId: null });

  const lines = new Map<string, LogLine>();
  for (const e of reading.rawEvents?.rows ?? []) {
    const rawId = typeof e.id === "number" || typeof e.id === "string" ? String(e.id) : null;
    const word = typeof e.event === "string" && EVENT_WORD.test(e.event) ? e.event : null;
    const at = typeof e.created_at === "string" && Number.isFinite(Date.parse(e.created_at)) ? e.created_at : null;
    if (!rawId || !word || !at) continue;
    const d = recOf(e.detail);
    let sceneId = typeof e.scene_id === "string" && sceneNo.has(e.scene_id) ? e.scene_id : null;
    let line: Omit<LogLine, "id" | "at" | "word">;
    if (word.startsWith("take_")) {
      const named = d && typeof d.take_id === "string" && UUID.test(d.take_id) ? d.take_id : null;
      const known = named ? takes.get(named) : undefined;
      if (!sceneId && known?.sceneId && sceneNo.has(known.sceneId)) sceneId = known.sceneId;
      const kind = d && typeof d.kind === "string" && KIND_WORD.test(d.kind) ? d.kind : (known?.take.kind ?? null);
      const shot = shotOf(d?.shot_index) ?? (known ? shotOf(known.take.shotIndex) : null);
      const scene = sceneId ? (sceneNo.get(sceneId) ?? null) : null;
      const { tag, family } = takeTag(kind, scene, shot, sceneId ? (shotCount.get(sceneId) ?? null) : null);
      const clipShot = kind === "clip" || kind === "extend" ? shot : null;
      line = { tag, family, scene, shot: clipShot, takeId: named };
    } else {
      const scene = sceneId ? (sceneNo.get(sceneId) ?? null) : null;
      const family: LogFamily = word.startsWith("assembly_") ? "asm" : word.startsWith("segment_") ? "seg" : FILM_WORDS.has(word) ? "film" : "log";
      line = { tag: family, family, scene, shot: null, takeId: null };
    }
    lines.set(`f:${rawId}`, { id: `f:${rawId}`, at, word, ...line });
  }
  for (const it of activity?.items ?? []) {
    if (lines.has(it.id) || !it.id.startsWith("f:") || !EVENT_WORD.test(it.word)) continue;
    const family: LogFamily = it.word.startsWith("assembly_") ? "asm" : it.word.startsWith("segment_") ? "seg" : FILM_WORDS.has(it.word) ? "film" : "log";
    const kind = it.word.startsWith("take_") && it.kind && KIND_WORD.test(it.kind) ? it.kind : null;
    const t = kind ? takeTag(kind, it.scene, null, null) : { tag: family, family };
    lines.set(it.id, { id: it.id, at: it.at, word: it.word, tag: t.tag, family: t.family, scene: it.scene, shot: null, takeId: null });
  }
  return [...lines.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}
