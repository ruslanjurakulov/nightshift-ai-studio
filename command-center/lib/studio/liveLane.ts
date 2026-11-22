/**
 * The live lane under the Studio's canvas, as data (docs/studio/S3_GAPS.md, G2-G4). Pure: a FilmReading (lib/studio/liveGraph.ts)
 * in, the pieces of the lane, the landings between two readings and the activity lines out. No UI, no fetch, no write.
 *
 * Rule 5 runs through every field. A piece is `landed` only when a completed take recorded its file. A length says its basis: the
 * library's recorded duration (`measured`), the length a take REQUESTED (film_takes.duration_s), or the plan's share; a start says
 * whether it is where the worker will cut it (`startKnown`) or where the plan puts it. A master whose table cannot be read is
 * `unknown`, never `pending`.
 */
import { compareEventIds, type Activity, type FilmReading } from "@/lib/studio/liveGraph";
import { sceneWindow, type AssetDurations, type TakeMedia } from "@/lib/studio/timeline";

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

/** Where a length comes from: the file as the library measured it, the take's request, the plan's share, or nothing. */
export type LengthBasis = "measured" | "requested" | "planned" | null;

interface PieceBase {
  /** Stable per SLOT across readings (not per take), so a retry or a refresh is compared with the same piece. */
  id: string;
  /** The take that drives the slot now (the newest attempt), or null when there is no row. */
  takeId: string | null;
  tag: string;
  state: PieceState;
  /** Seconds from the start of the film, or null once an earlier scene has no planned seconds. */
  start: number | null;
  /** True only when `start` is where the worker cuts it (every shot of the scene measured); false is the plan's position. */
  startKnown: boolean;
  /** Seconds on the lane. A video piece is its SLOT (the worker cuts every scene to its planned seconds), not its file. */
  length: number | null;
  lengthBasis: LengthBasis;
  /** The piece's own file length, only as the library recorded it; null is "not measured", never 0. */
  fileS: number | null;
  assetId: string | null;
  /** The stored error word (film_takes.error_code, or the master's reason), for the UI to map to a remedy. */
  error: string | null;
}

export interface VideoPiece extends PieceBase {
  track: "video";
  sceneId: string;
  /** 1-based, in scene position order. */
  scene: number;
  /** 1-based shot within the scene (film_takes.shot_index of a clip or extend). */
  shot: number;
}
export interface AudioPiece extends PieceBase {
  track: "audio";
  sceneId: null;
  scene: null;
  shot: null;
}
export interface MasterPiece extends PieceBase {
  track: "master";
  takeId: null;
  sceneId: null;
  scene: null;
  shot: null;
}
export type LanePiece = VideoPiece | AudioPiece | MasterPiece;

export interface LiveLane {
  /** The film this lane is of: landedSince never compares the lanes of two films. */
  film: string;
  video: VideoPiece[];
  audio: AudioPiece[];
  master: MasterPiece | null;
  /** The film's planned seconds, or null once any scene has no positive planned seconds (the same rule as the start clock). */
  planned: number | null;
  /** How many pieces (video, audio and master) are landed. */
  landed: number;
  total: number;
}

/**
 * The assembled master as the lane reads it. Stream S4 will publish its own read model; until then `masterFromSegments` builds one
 * from film_segments. `not_assembled` is "not assembled yet", `skipped` is "the run ended without one", `unknown` is "cannot be read".
 */
export type MasterReading =
  | { state: "ready"; assetId: string; reason: null }
  | { state: "failed"; assetId: null; reason: string }
  | { state: "not_assembled" | "assembling" | "skipped" | "unknown"; assetId: null; reason: null };

const BEFORE_WORK = new Set(["draft", "planning", "planned", "queued"]);
const IN_FLIGHT = new Set(["running", "draining", "paused"]);
/** 0166 checks `shot_count between 1 and 3`; a larger stored count must not draw slots no worker will make. */
const MAX_SHOTS = 3;

const pad2 = (n: number) => String(n).padStart(2, "0");
const positive = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const shotsOf = (shotCount: number) => Math.min(MAX_SHOTS, Math.max(1, shotCount));

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
 * One slot's rows (one kind and shot) read as a piece's take and state, picked exactly as filmGraph's `latestTake` picks a node's:
 * the newest non-superseded row of the scene's current version, or of any version while current_version is null (no migration
 * writes it yet). Superseded rows are history, except that while the attempt+1 sibling still waits the slot says `retried` (and
 * why). That reading assumes 0171's only superseding today, `charge_basis = retried_not_charged`; P7's re-shoot may supersede with
 * another basis, and then this needs the basis column.
 */
function slot(all: readonly TakeMedia[], version: number | null, errors: ReadonlyMap<string, string>, filmStatus: string): Slot {
  const rows = version === null ? all : all.filter((t) => t.version === version);
  const newestFirst = (a: TakeMedia, b: TakeMedia) => b.version - a.version || b.attempt - a.attempt;
  const take = rows.filter((t) => t.status !== "superseded").sort(newestFirst)[0] ?? null;
  if (!take) {
    if (rows.length === 0) return { take: null, state: noRow(filmStatus), error: null };
    // Superseded with no sibling: a row this build cannot place, not a state to guess.
    const newest = [...rows].sort(newestFirst)[0];
    return { take: newest, state: "unknown", error: errors.get(newest.id) ?? null };
  }
  const state = takeState(take);
  const before = rows.find((t) => t.status === "superseded" && t.version === take.version && t.attempt === take.attempt - 1);
  if (before && state === "pending") return { take, state: "retried", error: errors.get(before.id) ?? null };
  return { take, state, error: state === "failed" ? (errors.get(take.id) ?? null) : null };
}

const createdMs = (s: { createdAt: string | null }) => {
  const t = s.createdAt ? Date.parse(s.createdAt) : NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
};

/** The newest film_segments row's assembly, as a MasterReading, under today's contract (docs/studio/NIGHTSHIFT_AI.md, P3). */
export function masterFromSegments(reading: FilmReading): MasterReading | null {
  const fs = reading.film.view.film.status;
  if (reading.segments === null) return { state: "unknown", assetId: null, reason: null };
  const seg = [...reading.segments].sort((a, b) => createdMs(b) - createdMs(a))[0] ?? null;
  if (!seg) {
    if (fs === "draft") return null;
    return { state: BEFORE_WORK.has(fs) || IN_FLIGHT.has(fs) ? "not_assembled" : "unknown", assetId: null, reason: null };
  }
  switch (seg.assemblyStatus) {
    case "planned":
      return { state: "not_assembled", assetId: null, reason: null };
    // The segment settled without an assembly (filmGraph's `skipped`): not "not assembled yet", the run is over.
    case "skipped":
      return { state: "skipped", assetId: null, reason: null };
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
  skipped: "skipped",
  unknown: "unknown",
};

const fileOf = (assetId: string | null, durations: AssetDurations): number | null => {
  const d = assetId ? durations.get(assetId) : undefined;
  return positive(d) ? d : null;
};

/** An audio or master piece's length: its file's recorded length, else the request, else the plan, each saying which it is. */
function lengthOf(fileS: number | null, requested: number | null, planned: number | null): { length: number | null; lengthBasis: LengthBasis } {
  if (fileS !== null) return { length: fileS, lengthBasis: "measured" };
  if (positive(requested)) return { length: requested, lengthBasis: "requested" };
  if (positive(planned)) return { length: planned, lengthBasis: "planned" };
  return { length: null, lengthBasis: null };
}

type Place = Pick<PieceBase, "start" | "startKnown" | "length" | "lengthBasis">;

/**
 * The lane of one reading: every clip shot slot of the chosen version in scene position order, the film's narration, and the
 * master. `master` overrides film_segments (S4's read model); omitted, it is built from the segments; null, there is none.
 */
export function liveLane(reading: FilmReading, durations: AssetDurations, master?: MasterReading | null): LiveLane {
  const fs = reading.film.view.film.status;
  const scenes = [...reading.film.view.scenes].sort((a, b) => a.position - b.position);
  const video: VideoPiece[] = [];
  // A scene with no planned seconds leaves every later start, and the film's total, unknown: a position after a guessed gap is a
  // guess too.
  let clock: number | null = 0;

  scenes.forEach((scene, i) => {
    const n = shotsOf(scene.shotCount);
    const sceneSeconds = positive(scene.plannedSeconds) ? scene.plannedSeconds : null;
    const share = sceneSeconds !== null ? sceneSeconds / n : null;
    const takes = reading.film.sceneTakes.get(scene.id) ?? [];
    const slots = Array.from({ length: n }, (_, k) =>
      slot(
        takes.filter((t) => t.kind === (k === 0 ? "clip" : "extend") && t.shotIndex === k + 1),
        scene.currentVersion,
        reading.errors,
        fs,
      ),
    );
    // Every shot landed and measured: the pieces are where the worker will cut them (the Timeline's own sceneWindow), not the plan.
    // Anything short of "ok" (a shot not measured, footage too short or too long to trim) leaves the plan's positions.
    const shot = slots.every((s) => s.state === "landed") ? slots.map((s) => s.take as TakeMedia) : null;
    const win = shot && clock !== null && sceneSeconds !== null ? sceneWindow(scenes, i, shot, durations, reading.film, clock) : null;
    let cursor = clock;
    slots.forEach((s, k) => {
      const assetId = s.state === "landed" ? (s.take?.resultAssetId ?? null) : null;
      let place: Place;
      if (win?.state === "ok") {
        const cut = win.segments.find((g) => g.assetId === assetId);
        // A shot the cut keeps no footage of sits, with no length, where the previous one ends.
        place = cut ? { start: cut.start, startKnown: true, length: cut.length, lengthBasis: "measured" } : { start: cursor, startKnown: true, length: 0, lengthBasis: "measured" };
        if (cut) cursor = cut.start + cut.length;
      } else {
        const start = clock !== null && share !== null ? clock + k * share : null;
        const requested = s.take?.requestedS ?? null;
        place =
          share !== null
            ? { start, startKnown: false, length: share, lengthBasis: "planned" }
            : positive(requested)
              ? { start, startKnown: false, length: requested, lengthBasis: "requested" }
              : { start, startKnown: false, length: null, lengthBasis: null };
      }
      video.push({
        id: `v:${scene.id}:${k + 1}`,
        track: "video",
        takeId: s.take?.id ?? null,
        sceneId: scene.id,
        scene: i + 1,
        shot: k + 1,
        tag: `clip-${pad2(i + 1)}${n > 1 ? `.${k + 1}` : ""}`,
        state: s.state,
        ...place,
        fileS: fileOf(assetId, durations),
        assetId,
        error: s.error,
      });
    });
    clock = clock !== null && sceneSeconds !== null ? clock + sceneSeconds : null;
  });
  const planned = clock;

  const audio: AudioPiece[] = [];
  const narration = reading.film.filmTakes.filter((t) => t.kind === "narration" && t.shotIndex === 0);
  // The same presence rule as filmGraph's voice node: once work started, a film with no narration row did not ask for one, so it
  // has no audio piece rather than a pending one that will never come.
  if (narration.length > 0 || BEFORE_WORK.has(fs) || fs === "running") {
    const s = slot(narration, null, reading.errors, fs);
    const assetId = s.state === "landed" ? (s.take?.resultAssetId ?? null) : null;
    const fileS = fileOf(assetId, durations);
    audio.push({
      id: "a:narration",
      track: "audio",
      takeId: s.take?.id ?? null,
      sceneId: null,
      scene: null,
      shot: null,
      tag: "voice",
      state: s.state,
      // The narration runs on the film's clock from 0 (P3's contract), so its start is not a guess.
      start: 0,
      startKnown: true,
      ...lengthOf(fileS, s.take?.requestedS ?? null, planned),
      fileS,
      assetId,
      error: s.error,
    });
  }

  const m = master === undefined ? masterFromSegments(reading) : master;
  let masterPiece: MasterPiece | null = null;
  if (m) {
    const assetId = m.state === "ready" ? m.assetId : null;
    const fileS = fileOf(assetId, durations);
    masterPiece = {
      id: "m:master",
      track: "master",
      takeId: null,
      sceneId: null,
      scene: null,
      shot: null,
      tag: "master",
      state: MASTER_STATE[m.state],
      start: 0,
      startKnown: true,
      ...lengthOf(fileS, null, planned),
      fileS,
      assetId,
      error: m.state === "failed" ? m.reason : null,
    };
  }

  const all: LanePiece[] = [...video, ...audio, ...(masterPiece ? [masterPiece] : [])];
  return {
    film: reading.film.view.film.id,
    video,
    audio,
    master: masterPiece,
    planned,
    landed: all.filter((p) => p.state === "landed").length,
    total: all.length,
  };
}

/** A previous state a landing can follow. `unknown` is no information (a failed read), so a landing after it is not news. */
const BEFORE_LANDING: ReadonlySet<PieceState> = new Set(["pending", "working", "retried", "failed"]);

const piecesOf = (l: LiveLane): LanePiece[] => [...l.video, ...l.audio, ...(l.master ? [l.master] : [])];

/**
 * The pieces that landed between two readings: the tags to fly. With no previous reading (the first read after mount, or a
 * refresh) nothing flies: a restore must never replay every landing. A piece flies only out of a state a landing follows, or when
 * it is new in this reading. A lane of another film is no previous reading at all, so a caller that switches films need not reset.
 */
export function landedSince(prev: LiveLane | null, next: LiveLane): LanePiece[] {
  if (prev === null || prev.film !== next.film) return [];
  const before = new Map(piecesOf(prev).map((p) => [p.id, p.state]));
  return piecesOf(next).filter((p) => {
    if (p.state !== "landed") return false;
    const was = before.get(p.id);
    return was === undefined || BEFORE_LANDING.has(was);
  });
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
const familyOf = (word: string): LogFamily =>
  word.startsWith("assembly_") ? "asm" : word.startsWith("segment_") ? "seg" : FILM_WORDS.has(word) ? "film" : "log";

/** Clip and extend tags read like the lane's (`clip-03.2`); `.n` only when the scene has more than one shot. */
function takeTag(kind: string | null, scene: number | null, shot: number | null, shots: number | null): { tag: string; family: LogFamily } {
  const sc = scene !== null ? `-${pad2(scene)}` : "";
  if (kind === "keyframe") return { tag: `key${sc}`, family: "key" };
  if (kind === "clip" || kind === "extend") {
    const multi = shots === null || shots > 1;
    return { tag: `clip${sc}${scene !== null && shot !== null && multi ? `.${shot}` : ""}`, family: "clip" };
  }
  if (kind === "narration") return { tag: "voice", family: "voice" };
  return { tag: kind ?? "take", family: "log" };
}

/**
 * The film's recorded events (FilmReading.rawEvents, film_json's newest 50) as activity lines, oldest first. A take event's tag
 * comes from its rows: the take it names in this reading when there is one (its own kind and shot), else `detail.kind` and
 * `detail.shot_index` when they are plain values. 0198 writes `kind` on take_failed and take_retried too, but never `shot_index`:
 * a failure that will be retried writes ONLY take_retried ({take_id: the superseded take, retry_take_id, kind}), no take_failed,
 * so the shot of either is known only from the take row it names.
 *
 * `activity` is the panel's gathered list: lines it holds that this reading no longer has (older than the newest 50) keep their
 * word and time. `previous` is the caller's last answer from this function: a gathered line it already built from its row keeps
 * that line (its `clip-02.2`), so a line never changes its tag when its row falls out of the window. The reading's own rows always
 * win over `previous`, and `previous` only ever stands in for an id the gathered list still holds.
 */
export function logLines(reading: FilmReading, activity?: Activity | null, previous?: readonly LogLine[] | null): LogLine[] {
  const scenes = [...reading.film.view.scenes].sort((a, b) => a.position - b.position);
  const sceneNo = new Map(scenes.map((s, i) => [s.id, i + 1]));
  const shotCount = new Map(scenes.map((s) => [s.id, shotsOf(s.shotCount)]));
  const takes = new Map<string, { take: TakeMedia; sceneId: string | null }>();
  for (const [sceneId, rows] of reading.film.sceneTakes) for (const t of rows) takes.set(t.id.toLowerCase(), { take: t, sceneId });
  for (const t of reading.film.filmTakes) takes.set(t.id.toLowerCase(), { take: t, sceneId: null });

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
      const named = d && typeof d.take_id === "string" && UUID.test(d.take_id) ? d.take_id.toLowerCase() : null;
      const known = named ? takes.get(named) : undefined;
      if (!sceneId && known?.sceneId && sceneNo.has(known.sceneId)) sceneId = known.sceneId;
      // The named take's own row outranks the event's detail: the row is what the lane shows.
      const kind = known && KIND_WORD.test(known.take.kind) ? known.take.kind : d && typeof d.kind === "string" && KIND_WORD.test(d.kind) ? d.kind : null;
      const shot = known ? shotOf(known.take.shotIndex) : shotOf(d?.shot_index);
      const scene = sceneId ? (sceneNo.get(sceneId) ?? null) : null;
      // A clip or extend is shot 1..3; anything below 1 is not a shot to name.
      const clipShot = (kind === "clip" || kind === "extend") && shot !== null && shot >= 1 ? shot : null;
      const { tag, family } = takeTag(kind, scene, clipShot, sceneId ? (shotCount.get(sceneId) ?? null) : null);
      line = { tag, family, scene, shot: clipShot, takeId: named };
    } else {
      const family = familyOf(word);
      line = { tag: family, family, scene: sceneId ? (sceneNo.get(sceneId) ?? null) : null, shot: null, takeId: null };
    }
    lines.set(`f:${rawId}`, { id: `f:${rawId}`, at, word, ...line });
  }
  const before = new Map((previous ?? []).map((l) => [l.id, l]));
  for (const it of activity?.items ?? []) {
    // A line with no readable time would make the sort inconsistent; it is not placed at all.
    if (lines.has(it.id) || !it.id.startsWith("f:") || !EVENT_WORD.test(it.word) || !Number.isFinite(Date.parse(it.at))) continue;
    const kept = before.get(it.id);
    // Only a line of the same event and time: an id reused under another word is not the line it was.
    if (kept && kept.word === it.word && kept.at === it.at) {
      lines.set(it.id, kept);
      continue;
    }
    const scene = typeof it.scene === "number" && Number.isInteger(it.scene) && it.scene >= 1 ? it.scene : null;
    const kind = it.word.startsWith("take_") && it.kind && KIND_WORD.test(it.kind) ? it.kind : null;
    // Never built from its row in this session (gathered before `previous` held it): an ActivityItem kept no shot, so its clip tag
    // has no `.n` (`clip-03`, not `clip-03.2`).
    const t = kind ? takeTag(kind, scene, null, null) : { tag: familyOf(it.word), family: familyOf(it.word) };
    lines.set(it.id, { id: it.id, at: it.at, word: it.word, tag: t.tag, family: t.family, scene, shot: null, takeId: null });
  }
  return [...lines.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || compareEventIds(a.id, b.id));
}
