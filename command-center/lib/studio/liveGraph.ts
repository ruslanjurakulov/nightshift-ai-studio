/**
 * The Studio's live view of one plan as a graph of steps (item 5): a short film (0166/0171) or a long channel video (the bot's Run
 * now pipeline). Pure: the reading in, the nodes and their lamps out. Every status comes from a row the database (or the pipeline's
 * own event log) wrote; a step with no row says so. A missing reading is "unknown", never "done" (CLAUDE.md rule 5), and nothing
 * here ever starts, retries or prices anything (rule 3): the view only reads.
 */
import { chosenClip, chosenKeyframe, chosenShots, coerceTimelineFilm, narrationTake, type TakeMedia, type TimelineFilm } from "@/lib/studio/timeline";
import { coerceMasterSound, type MasterSound } from "@/lib/studio/masterSound";

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const oneOf = <T extends string>(v: unknown, xs: readonly T[]): T | null => (typeof v === "string" && (xs as readonly string[]).includes(v) ? (v as T) : null);

/**
 * - waiting: in the plan, not started yet (a planned or queued row, or no row while the project has not reached it)
 * - working: a row says it is running now
 * - done / failed / skipped: a row says so
 * - stopped: it was running when the whole run ended without finishing it
 * - unknown: what it is cannot be read (a missing table, an unreadable answer, a run whose events are not here)
 * - none: not part of this plan (no music chosen, no voice asked for)
 * - draft: planned in the conversation, before Create: nothing runs, no lamp (the brief, not the database)
 */
export type LiveStatus = "draft" | "waiting" | "working" | "done" | "failed" | "skipped" | "stopped" | "unknown" | "none";

export type FilmNodeKind = "idea" | "script" | "keyframe" | "clip" | "voice" | "music" | "assembly" | "final" | "character" | "location" | "prop";
export type RunNodeKind = "topic" | "research" | "script" | "voice" | "visuals" | "render" | "gate" | "upload";
export type LiveNodeKind = FilmNodeKind | RunNodeKind;

/** Credits a step held and was charged, as stored: null is "not recorded", never 0. */
export interface LiveCredits {
  held: number | null;
  charged: number | null;
}

export interface LiveNode {
  id: string;
  kind: LiveNodeKind;
  status: LiveStatus;
  /** 1-based scene number for keyframe and clip nodes. */
  scene?: number;
  sceneTitle?: string;
  /** The file this step made (a picture, a clip, the narration, the final video). */
  assetId?: string | null;
  /** Words this step stands for (the idea, a scene's narration). */
  text?: string | null;
  credits?: LiveCredits | null;
  /** The stored error word (film_takes.error_code, an assembly or run error), mapped to a reason by the UI. */
  error?: string | null;
  /** upload: the privacy the uploader recorded (video.published metadata), or null when it was not recorded. */
  privacy?: string | null;
  /** final: what the finished file records about its sound (lib/studio/masterSound.ts); unknown when not recorded. */
  sound?: MasterSound;
  /** Draft nodes: the price the backend already gave for this step, or null (no number is guessed). */
  price?: number | null;
  /** Draft reference nodes: the generated reference picture, once there is one. */
  /** When the step's last event was recorded (runs only). */
  at?: string | null;
  /** Column and row on the board. */
  col: number;
  row: number;
}

export interface LiveEdge {
  from: string;
  to: string;
}

export interface LiveGraph {
  nodes: LiveNode[];
  edges: LiveEdge[];
  /** What happened, in order: the plan's own event log (film_events, or the run's system_events). Undefined = not read. */
  activity?: Activity | null;
  /** A run's own failure code (render_jobs.error's code), shown for the whole run: many failures belong to no stage (Lens M4). */
  runError?: string | null;
  /** Every step is done, failed, skipped, stopped or not in the plan: polling can stop. */
  settled: boolean;
  /** A channel run's live facts next to its (possibly lagging) stages: undefined = not asked, null = asked and not known. */
  workflow?: WorkflowStatus | null;
  hold?: HoldStatus | null;
  /** The video this run made (lib/server/run-video.ts): its page holds "Publish to platforms". null = none readable yet. */
  video?: RunVideoRef | null;
}

export type RunVideoRef = { id: string; state: "held" | "uploaded" };

/** GitHub's status of a dispatched Run now's job (lib/server/github-runs.ts), as the route answers it. */
export type WorkflowStatus =
  | { state: "not_seen" | "queued" | "in_progress" }
  | { state: "completed"; conclusion: "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "other" };
/** The run's credit hold (lib/server/run-hold.ts). */
export type HoldStatus = { state: "open" | "captured" | "released"; amount: number | null; captured: number | null };

const TERMINAL: ReadonlySet<LiveStatus> = new Set(["done", "failed", "skipped", "stopped", "none"]);

/* ------------------------------------------------------------------ films ----------------------------------------------------- */

/** One funding segment's assembly as film_segments (0171) stores it. */
export interface LiveSegment {
  id: string;
  status: string;
  assemblyStatus: string | null;
  assemblyAssetId: string | null;
  confirmedCredits: number | null;
  chargedCredits: number | null;
  assemblyConfirmedCredits: number | null;
  assemblyChargedCredits: number | null;
  createdAt: string | null;
}

/** Per take id, the money columns 0171 added to film_takes. */
export type TakeMoney = ReadonlyMap<string, LiveCredits>;

/** Per take id, its stored error word. */
export type TakeErrors = ReadonlyMap<string, string>;

export interface FilmReading {
  film: TimelineFilm;
  /** Null: film_segments could not be read (0171 not applied, or the read failed), so the assembly is unknown. */
  segments: LiveSegment[] | null;
  money: TakeMoney;
  errors: TakeErrors;
  /** films.pause_reason: where the worker records why a segment's assembly failed (S6's contract). */
  pauseReason?: string | null;
  /** The newest master's sound record (the live route's `master`), for the final node. Undefined or null: unknown. */
  master?: { assetId: string; sound: MasterSound } | null;
  /** film_json's events (0166 film_events, the newest 50) as raw rows: filmGraph numbers their scenes. */
  rawEvents?: { rows: Record<string, unknown>[]; total: number | null } | null;
}

/* ------------------------------------------------------------------ activity --------------------------------------------------- */

/**
 * One line of the Activity panel: an event word the plan's own log recorded, when, and for which scene. `detail` is never shown as
 * text (film_json sends it, with credits and a basis, and the panel never renders it): only a take's kind is kept, when it is a
 * plain word. An event the view has no sentence for is shown as its code, never re-worded.
 */
export interface ActivityItem {
  id: string;
  at: string;
  word: string;
  scene: number | null;
  /** keyframe | clip | narration | ... (film takes), or null. */
  kind: string | null;
}
export interface Activity {
  /** Oldest first. */
  items: ActivityItem[];
  /** How many events the log holds in all, when it says (film_json's events_total); null = not said. */
  total: number | null;
  /** The reader stopped at its limit, so the newest events of a run may be missing (the run routes' events_cut). */
  cut?: boolean;
}

const KIND_WORD = /^[a-z][a-z_]{0,30}$/;

function filmActivity(raw: { rows: Record<string, unknown>[]; total: number | null }, sceneNo: Map<string, number>): Activity {
  const items: ActivityItem[] = [];
  for (const e of raw.rows) {
    const id = typeof e.id === "number" || typeof e.id === "string" ? String(e.id) : null;
    const word = str(e.event);
    const at = str(e.created_at);
    if (!id || !word || !at || !Number.isFinite(Date.parse(at))) continue;
    const d = rec(e.detail);
    const kind = d && typeof d.kind === "string" && KIND_WORD.test(d.kind) ? d.kind : null;
    const sceneId = str(e.scene_id);
    items.push({ id: `f:${id}`, at, word, scene: sceneId ? sceneNo.get(sceneId) ?? null : null, kind });
  }
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  return { items, total: raw.total };
}

/**
 * A run's events as Activity lines. system_events carry no id, so a line's key is its time, word and agent, with a count only among
 * identical ones: an event that syncs late with an earlier time must not shift every later key (Lens). The run routes answer the
 * whole window each time, so a run's lines are replaced, not gathered.
 */
export function runActivity(events: RunEvent[] | null, cut = false): Activity | null {
  if (events === null) return null;
  const seen = new Map<string, number>();
  const items = [...events]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map((e) => {
      const base = `${e.ts}|${e.event}|${e.agent ?? ""}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { id: `r:${base}|${n}`, at: e.ts, word: e.event, scene: null, kind: null };
    });
  return { items, total: null, cut };
}

/**
 * GET /api/films/[id]/live's answer as the graph reads it, or null when the film itself is not a film_json (the caller says so).
 * `segments` or `takes` null in the answer stay "not known": null segments, and no money or error words.
 */
export function coerceFilmLive(raw: unknown): FilmReading | null {
  const r = rec(raw);
  if (!r) return null;
  const film = coerceTimelineFilm(r.film);
  if (!film) return null;
  const segments = Array.isArray(r.segments)
    ? r.segments
        .map(rec)
        .filter((s): s is Record<string, unknown> => !!s && !!str(s.id))
        .map((s) => ({
          id: str(s.id)!,
          status: str(s.status) ?? "unknown",
          assemblyStatus: str(s.assembly_status),
          assemblyAssetId: str(s.assembly_asset_id),
          confirmedCredits: num(s.confirmed_credits),
          chargedCredits: num(s.captured_credits),
          assemblyConfirmedCredits: num(s.assembly_confirmed_credits),
          assemblyChargedCredits: num(s.assembly_charged_credits),
          createdAt: str(s.created_at),
        }))
    : null;
  const money = new Map<string, LiveCredits>();
  const errors = new Map<string, string>();
  for (const t of Array.isArray(r.takes) ? r.takes : []) {
    const o = rec(t);
    const id = o && str(o.id);
    if (!o || !id) continue;
    const err = str(o.error_code);
    if (err) errors.set(id, err);
    if ("confirmed_credits" in o || "charged_credits" in o) money.set(id, { held: num(o.confirmed_credits), charged: num(o.charged_credits) });
  }
  const filmRow = rec(rec(r.film)?.film);
  const fj = rec(r.film);
  const rows = fj && Array.isArray(fj.events) ? (fj.events.map(rec).filter(Boolean) as Record<string, unknown>[]) : null;
  const total = fj ? num(fj.events_total) : null;
  return {
    film,
    segments,
    money,
    errors,
    pauseReason: filmRow ? str(filmRow.pause_reason) : null,
    master: (() => {
      const m = rec(r.master);
      const assetId = m ? str(m.asset_id) : null;
      return m && assetId ? { assetId, sound: coerceMasterSound(m.mix_format, m.sound) } : null;
    })(),
    rawEvents: rows ? { rows, total } : null,
  };
}

const BEFORE_WORK = new Set(["draft", "planning", "planned", "queued"]);

function takeStatus(status: string): LiveStatus {
  switch (status) {
    case "planned":
    case "queued":
      return "waiting";
    case "running":
      return "working";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

/** The take a step stands for: the current version's newest attempt of that kind and shot (superseded rows are history). */
function latestTake(takes: readonly TakeMedia[], kind: string, shotIndex: number, version: number | null): TakeMedia | null {
  const rows = takes
    .filter((t) => t.kind === kind && t.shotIndex === shotIndex && t.status !== "superseded" && (version === null || t.version === version))
    .sort((a, b) => b.version - a.version || b.attempt - a.attempt);
  return rows[0] ?? null;
}

/** A step with no row yet: waiting while the project has not got there, unknown once it should have one. */
function noRow(filmStatus: string): LiveStatus {
  if (BEFORE_WORK.has(filmStatus) || filmStatus === "running" || filmStatus === "draining" || filmStatus === "paused") return "waiting";
  if (filmStatus === "cancelled" || filmStatus === "failed") return "stopped";
  return "unknown";
}

function sumCredits(list: readonly (LiveCredits | undefined)[]): LiveCredits | null {
  const rows = list.filter((c): c is LiveCredits => !!c);
  if (rows.length === 0) return null;
  const add = (k: keyof LiveCredits) => {
    const vals = rows.map((r) => r[k]).filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return { held: add("held"), charged: add("charged") };
}

/** Several takes as one step (a scene's shots): failed if any failed, working if any runs, done only when every shot is done. */
function combine(statuses: readonly LiveStatus[]): LiveStatus {
  if (statuses.length === 0) return "unknown";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("working")) return "working";
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.every((s) => s === "done")) return "done";
  if (statuses.every((s) => s === "skipped")) return "skipped";
  if (statuses.includes("stopped")) return "stopped";
  return "waiting";
}

function assemblyStatus(s: string | null): LiveStatus {
  switch (s) {
    case "planned":
      return "waiting";
    case "running":
      return "working";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

export function filmGraph(r: FilmReading): LiveGraph {
  const { view } = r.film;
  const fs = view.film.status;
  const nodes: LiveNode[] = [];
  const edges: LiveEdge[] = [];
  const scenes = [...view.scenes].sort((a, b) => a.position - b.position);

  const ideaText = view.film.sourceText.trim();
  nodes.push({ id: "idea", kind: "idea", status: ideaText ? "done" : "unknown", text: ideaText || null, col: 0, row: 0 });

  // The script is the scene list: written once there are scenes, being written while the film is planning.
  const script: LiveStatus = scenes.length > 0 ? "done" : fs === "planning" ? "working" : fs === "draft" ? "waiting" : "unknown";
  nodes.push({ id: "script", kind: "script", status: script, text: scenes.map((s) => s.narration).filter(Boolean).join("\n\n") || null, col: 1, row: 0 });
  edges.push({ from: "idea", to: "script" });

  const sceneEnds: string[] = [];
  scenes.forEach((scene, i) => {
    const takes = r.film.sceneTakes.get(scene.id) ?? [];
    const version = scene.currentVersion;
    const kf = latestTake(takes, "keyframe", 0, version);
    // Only a `keyframe` scene generates its first picture. `asset` starts from the person's own file (there, or gone from the
    // library); `previous` starts from the scene before's last frame, so no step runs for it.
    const kfStatus: LiveStatus =
      scene.firstFrame === "keyframe"
        ? kf
          ? takeStatus(kf.status)
          : noRow(fs)
        : scene.firstFrame === "asset"
          ? scene.firstFrameMissing
            ? "failed"
            : scene.firstFrameAssetId
              ? "done"
              : "unknown"
          : "none";
    const kfDone = scene.firstFrame === "asset" ? null : chosenKeyframe(scene, takes);
    const kfId = `scene:${scene.id}:keyframe`;
    nodes.push({
      id: kfId,
      kind: "keyframe",
      status: kfStatus,
      scene: i + 1,
      sceneTitle: scene.title,
      assetId: scene.firstFrame === "asset" ? (scene.firstFrameMissing ? null : scene.firstFrameAssetId) : (kfDone?.resultAssetId ?? kf?.resultAssetId ?? null),
      text: scene.visualPrompt || null,
      credits: kf && scene.firstFrame === "keyframe" ? (r.money.get(kf.id) ?? null) : null,
      error: scene.firstFrame === "asset" && scene.firstFrameMissing ? "first_frame_missing" : kf ? (r.errors.get(kf.id) ?? null) : null,
      col: 2,
      row: i,
    });
    edges.push({ from: "script", to: kfId });

    const shots: TakeMedia[] = [];
    for (let idx = 1; idx <= Math.max(1, scene.shotCount); idx++) {
      const t = latestTake(takes, idx === 1 ? "clip" : "extend", idx, version);
      if (t) shots.push(t);
    }
    const shotStatuses = Array.from({ length: Math.max(1, scene.shotCount) }, (_, k) => {
      const t = shots.find((s) => s.shotIndex === k + 1);
      return t ? takeStatus(t.status) : noRow(fs);
    });
    const clipStatus = chosenShots(scene, takes) ? "done" : combine(shotStatuses);
    const failedShot = shots.find((s) => s.status === "failed");
    const clipId = `scene:${scene.id}:clip`;
    nodes.push({
      id: clipId,
      kind: "clip",
      status: clipStatus,
      scene: i + 1,
      sceneTitle: scene.title,
      // film_scenes.current_version is never written by any migration yet (Lens M2): without it, the newest finished first shot.
      assetId: chosenClip(scene, takes)?.resultAssetId ?? shots.find((t) => t.shotIndex === 1 && t.status === "completed")?.resultAssetId ?? null,
      text: scene.narration || null,
      credits: sumCredits(shots.map((s) => r.money.get(s.id))),
      error: failedShot ? (r.errors.get(failedShot.id) ?? null) : null,
      col: 3,
      row: i,
    });
    edges.push({ from: kfId, to: clipId });
    sceneEnds.push(clipId);
  });

  const rows = Math.max(1, scenes.length);
  const mid = Math.floor((rows - 1) / 2);

  // Narration is one film-level take; a film with no voice take at all, once work has started, did not ask for one.
  const narrationRows = r.film.filmTakes.filter((t) => t.kind === "narration" && t.status !== "superseded");
  narrationRows.sort((a, b) => b.version - a.version || b.attempt - a.attempt);
  const voiceRow = narrationRows[0] ?? null;
  const voiceStatus: LiveStatus = voiceRow ? takeStatus(voiceRow.status) : BEFORE_WORK.has(fs) ? "waiting" : fs === "running" ? "waiting" : "none";
  nodes.push({
    id: "voice",
    kind: "voice",
    status: voiceStatus,
    assetId: narrationTake(r.film)?.resultAssetId ?? null,
    credits: voiceRow ? (r.money.get(voiceRow.id) ?? null) : null,
    error: voiceRow ? (r.errors.get(voiceRow.id) ?? null) : null,
    col: 4,
    // Voice and music get their own lanes above and below the scenes: on a scene row, the clips' wires into the assembly read as
    // running through them (Pixel M4).
    row: -1,
  });
  edges.push({ from: "script", to: "voice" });

  // Music is a library file the person chose, not a step that runs: there, gone from the library, or not chosen.
  const music: LiveStatus = r.film.musicMissing ? "failed" : r.film.musicAssetId ? "done" : "none";
  nodes.push({ id: "music", kind: "music", status: music, assetId: r.film.musicMissing ? null : r.film.musicAssetId, error: r.film.musicMissing ? "music_missing" : null, col: 4, row: rows });

  const seg = r.segments === null ? null : ([...r.segments].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0] ?? null);
  const asm: LiveStatus = r.segments === null ? "unknown" : seg ? assemblyStatus(seg.assemblyStatus) : noRow(fs);
  nodes.push({
    id: "assembly",
    kind: "assembly",
    status: asm,
    credits: seg ? { held: seg.assemblyConfirmedCredits, charged: seg.assemblyChargedCredits } : null,
    error: asm === "failed" ? (r.pauseReason ?? "assembly_failed") : null,
    col: 5,
    row: mid,
  });
  for (const end of sceneEnds) edges.push({ from: end, to: "assembly" });
  edges.push({ from: "voice", to: "assembly" });
  if (music !== "none") edges.push({ from: "music", to: "assembly" });

  // The final video is the assembly's file: there only when the segment recorded one.
  const finalAsset = seg?.assemblyAssetId ?? null;
  const final: LiveStatus = r.segments === null ? "unknown" : finalAsset ? "done" : asm === "failed" || asm === "stopped" ? "stopped" : asm === "done" ? "unknown" : "waiting";
  // The route answers null for `master` when the read failed: a file is there and what it records could not be read (Pixel M2).
  const sound: MasterSound | undefined = finalAsset
    ? r.master && r.master.assetId === finalAsset
      ? r.master.sound
      : { state: "unknown", cause: "read_failed" }
    : undefined;
  nodes.push({ id: "final", kind: "final", status: final, assetId: finalAsset, ...(sound ? { sound } : {}), col: 6, row: mid });
  edges.push({ from: "assembly", to: "final" });

  const settled = ["ready", "failed", "cancelled", "archived"].includes(fs) && nodes.every((n) => TERMINAL.has(n.status) || n.status === "unknown");
  const sceneNo = new Map(scenes.map((s, i) => [s.id, i + 1]));
  return { nodes, edges, settled, activity: r.rawEvents ? filmActivity(r.rawEvents, sceneNo) : r.rawEvents === null ? null : undefined };
}

/* ------------------------------------------------------------------ runs ------------------------------------------------------ */

export interface RunEvent {
  ts: string;
  event: string;
  status: string | null;
  agent: string | null;
  /** Only the keys the view needs (privacy, url), never the whole metadata. */
  privacy?: string | null;
}

export interface RunJob {
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface RunReading {
  /** Null: the run's row could not be read (another backend, or not this person's channel): the stages are unknown. */
  job: RunJob | null;
  /**
   * The Actions backend has no row: the run is the channel's events since the moment it was dispatched (`since`), read at `now`.
   * Set instead of `job`; it ends at its upload, at a failed stage, or once the workflow's own time limit has passed with neither.
   */
  window?: { since: string; now: string } | null;
  /** Null: the events could not be read, so no stage is claimed either way. */
  events: RunEvent[] | null;
  workflow?: WorkflowStatus | null;
  hold?: HoldStatus | null;
  video?: RunVideoRef | null;
  /** The route stopped at its event limit (newest events may be missing). */
  eventsCut?: boolean;
}

function coerceVideo(v: unknown): RunVideoRef | null {
  const r = rec(v);
  const id = r ? str(r.id) : null;
  const state = r ? oneOf(r.state, ["held", "uploaded"] as const) : null;
  return id && id.length <= 128 && state ? { id, state } : null;
}

function coerceWorkflow(v: unknown): WorkflowStatus | null {
  const w = rec(v);
  if (!w) return null;
  if (w.state === "not_seen" || w.state === "queued" || w.state === "in_progress") return { state: w.state };
  if (w.state !== "completed") return null;
  const c = oneOf(w.conclusion, ["success", "failure", "cancelled", "timed_out", "skipped", "other"] as const);
  return { state: "completed", conclusion: c ?? "other" };
}

function coerceHold(v: unknown): HoldStatus | null {
  const h = rec(v);
  const state = h ? oneOf(h.state, ["open", "captured", "released"] as const) : null;
  return h && state ? { state, amount: num(h.amount), captured: num(h.captured) } : null;
}

/** GET /api/agent/runs/[id]'s answer as runGraph reads it. A missing or malformed job is null: every stage then reads unknown. */
export function coerceRunLive(raw: unknown): RunReading {
  const r = rec(raw);
  const j = r ? rec(r.job) : null;
  const w = r ? rec(r.window) : null;
  const window = w && str(w.since) && str(w.now) ? { since: str(w.since)!, now: str(w.now)! } : null;
  const job: RunJob | null = j && str(j.status) ? { status: str(j.status)!, startedAt: str(j.startedAt), finishedAt: str(j.finishedAt), error: str(j.error) } : null;
  const events = r && Array.isArray(r.events)
    ? r.events
        .map(rec)
        .filter((e): e is Record<string, unknown> => !!e && !!str(e.ts) && !!str(e.event))
        .map((e) => ({ ts: str(e.ts)!, event: str(e.event)!, status: str(e.status), agent: str(e.agent), privacy: str(e.privacy) }))
    : null;
  // Absent from the answer: not asked (an older route); present and unreadable: asked and not known.
  const workflow = r && "workflow" in r ? coerceWorkflow(r.workflow) : undefined;
  const hold = r && "hold" in r ? coerceHold(r.hold) : undefined;
  const video = r && "video" in r ? coerceVideo(r.video) : undefined;
  return { job, events, window, workflow, hold, video, ...(r?.events_cut === true ? { eventsCut: true } : {}) };
}

/** daily_video.yml's video job stops at 60 minutes; a dispatch can wait for a runner before that. Past this, a run with no last event ended. */
export const RUN_WINDOW_LIMIT_MS = 90 * 60 * 1000;

/** Which events speak for which stage, in pipeline order (main.py and modules/event_log.py name them). */
const RUN_STAGES: { kind: RunNodeKind; start: string[]; done: string[]; failAgents: string[]; failEvents: string[] }[] = [
  { kind: "topic", start: [], done: ["topic.selected"], failAgents: ["topic_manager"], failEvents: ["topic.rejected"] },
  { kind: "research", start: ["research.started"], done: ["research.completed"], failAgents: ["research_engine"], failEvents: [] },
  { kind: "script", start: ["script.started"], done: ["script.completed"], failAgents: ["script_engine", "storyboard"], failEvents: [] },
  { kind: "voice", start: ["voice.started"], done: ["voice.completed"], failAgents: ["voice_gate", "audio_mixer"], failEvents: [] },
  { kind: "visuals", start: ["media.started"], done: ["media.completed"], failAgents: ["media_fetcher", "image_providers", "minimax_broll", "media_preflight"], failEvents: [] },
  { kind: "render", start: ["render.started"], done: ["render.completed"], failAgents: ["compositor"], failEvents: ["render.failed"] },
  // The publish gate's verdict on the finished cut (main.py emits it after the render). It is the gate's, not only the fact-check's:
  // the view names it "Publish gate" and never claims a fact-check ran from it (Lens H1).
  { kind: "gate", start: [], done: ["publish.allowed"], failAgents: [], failEvents: ["publish.blocked"] },
  { kind: "upload", start: ["upload.started"], done: ["upload.completed", "video.published"], failAgents: ["youtube_uploader"], failEvents: ["upload.failed"] },
];

const JOB_TERMINAL = new Set(["completed", "failed", "cancelled", "canceled", "succeeded"]);

export function runGraph(r: RunReading): LiveGraph {
  const events = [...(r.events ?? [])].sort((a, b) => a.ts.localeCompare(b.ts));
  const win = !r.job && r.window ? r.window : null;
  const readable = (r.job !== null || win !== null) && r.events !== null;
  const stageFailed = events.some((e) => RUN_STAGES.some((st) => st.failEvents.includes(e.event) || (e.event === "agent.failed" && !!e.agent && st.failAgents.includes(e.agent))));
  const uploaded = events.some((e) => e.event === "video.published" || e.event === "upload.completed" || e.event === "publish.held");
  const timedOut = win ? Date.parse(win.now) - Date.parse(win.since) > RUN_WINDOW_LIMIT_MS : false;
  // GitHub saying the channel's job finished does NOT end the run here: its events can still be on their way (Lens). It only stops
  // the view from claiming a stage is waiting or working: such a stage is not known. The view keeps reading until an event ends
  // the run or the time limit passes.
  const wfDone = !!win && r.workflow?.state === "completed";
  const ended = r.job ? JOB_TERMINAL.has(r.job.status) : win ? stageFailed || uploaded || timedOut : false;
  const jobStatus = r.job ? r.job.status : win ? (stageFailed || timedOut ? (uploaded && !stageFailed ? "completed" : "failed") : uploaded ? "completed" : "running") : null;
  let reachedLater = false;
  const statuses: { kind: RunNodeKind; status: LiveStatus; at: string | null; privacy: string | null }[] = [];
  for (let i = RUN_STAGES.length - 1; i >= 0; i--) {
    const st = RUN_STAGES[i];
    const mine = events.filter(
      (e) => st.start.includes(e.event) || st.done.includes(e.event) || st.failEvents.includes(e.event) || (e.event === "agent.failed" && !!e.agent && st.failAgents.includes(e.agent)),
    );
    const last = mine[mine.length - 1];
    let status: LiveStatus;
    if (!readable || !jobStatus) status = "unknown";
    // Ended with no event at all: the events have not reached us (the pipeline's mirror runs later), so nothing is claimed (Lens B1).
    else if (ended && events.length === 0) status = "unknown";
    // A run that timed out with no last event did not tell us what happened after: the steps it never reached are not known.
    else if (!last) status = reachedLater || (wfDone && !ended) ? "unknown" : ended ? (jobStatus === "completed" || jobStatus === "succeeded" || (timedOut && !stageFailed) ? "unknown" : "skipped") : "waiting";
    else if (st.failEvents.includes(last.event) || last.event === "agent.failed") status = "failed";
    else if (st.done.includes(last.event)) status = "done";
    // A later stage has begun, so this one is past its start, but its end event may not be here yet: the events that prove a slot
    // was worked (render.completed, upload.completed, ...) reach Supabase only with the mirror, never live (modules/event_log.py).
    // Not known, never "working" or a guessed "done".
    else status = ended ? "stopped" : wfDone || reachedLater ? "unknown" : "working";
    if (last) reachedLater = true;
    const published = mine.filter((e) => e.event === "video.published").pop();
    statuses.unshift({ kind: st.kind, status, at: last?.ts ?? null, privacy: published?.privacy ?? null });
  }
  // A stage nobody reached before a failure did not run: "skipped" above reads as "not reached" in the UI.
  const nodes: LiveNode[] = statuses.map((s, i) => ({
    id: s.kind,
    kind: s.kind,
    status: s.status,
    at: s.at,
    privacy: s.kind === "upload" ? s.privacy : undefined,
    error: s.status === "failed" ? (r.job?.error ?? null) : null,
    col: i,
    row: 0,
  }));
  const edges: LiveEdge[] = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
  const runError = r.job && (jobStatus === "failed" || jobStatus === "cancelled") ? (r.job.error ?? null) : null;
  return {
    nodes,
    edges,
    runError,
    settled: ended && nodes.every((n) => TERMINAL.has(n.status) || n.status === "unknown"),
    ...(r.workflow !== undefined ? { workflow: r.workflow } : {}),
    ...(r.hold !== undefined ? { hold: r.hold } : {}),
    ...(r.video !== undefined ? { video: r.video } : {}),
    activity: runActivity(r.events, r.eventsCut === true),
  };
}

/* ------------------------------------------------------------------ the brief (before Create) ---------------------------------- */

/**
 * The plan as Nightshift AI's conversation has it so far: S5's BRIEF v1 (docs/studio/NIGHTSHIFT_AI.md), read from
 * GET /api/brain/session/<id>. Every field may still be missing: the graph draws what the person has answered and nothing more.
 * Only the fields the canvas draws are kept; anything else in the answer is ignored.
 */
export interface BriefRef {
  id: string;
  name: string;
  assetId: string | null;
}
export interface BriefScene {
  id: string;
  n: number;
  title: string | null;
  visualPrompt: string | null;
  characterIds: string[];
  locationId: string | null;
  propIds: string[];
}
export type BriefHandoff =
  | { kind: "film"; filmId: string }
  | { kind: "run"; channelId: string; dispatchedAt: string; creditRef?: string | null }
  | { kind: "run"; channelId: string; jobId: string };
export interface Brief {
  status: "drafting" | "ready" | "created" | null;
  kind: "long" | "short" | null;
  title: string | null;
  idea: string | null;
  logline: string | null;
  chapters: string[];
  characters: BriefRef[];
  locations: BriefRef[];
  props: BriefRef[];
  scenes: BriefScene[];
  voice: "off" | "clip_audio" | "pipeline" | null;
  music: "off" | "library" | null;
  /** brief.price.nodes, only when the server says the brief is priced: a number on a node is the backend's, never the model's. */
  prices: ReadonlyMap<string, number>;
  handoff: BriefHandoff | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

/** The handoff as a live target: where Create's result is read from. A malformed handoff is no handoff (the view stays a draft). */
function coerceHandoff(v: unknown): BriefHandoff | null {
  const h = rec(v);
  if (!h) return null;
  if (h.kind === "film") {
    const id = str(h.film_id);
    return id && UUID.test(id) ? { kind: "film", filmId: id } : null;
  }
  if (h.kind !== "run") return null;
  const channel = str(h.channel_id);
  // channels.channel_id is a slug (0001), not a uuid.
  if (!channel || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(channel)) return null;
  const job = typeof h.job_id === "number" ? String(h.job_id) : str(h.job_id);
  if (job && /^[1-9][0-9]{0,14}$/.test(job)) return { kind: "run", channelId: channel, jobId: job };
  const at = str(h.dispatched_at);
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  // The hold /api/agent/run answered (credit_ref): optional, and only in credit_reservations.job_id's own shape (0020).
  const ref = str(h.credit_ref);
  return { kind: "run", channelId: channel, dispatchedAt: at, ...(ref && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(ref) ? { creditRef: ref } : {}) };
}

/** GET /api/brain/session/<id>'s brief, or null when it is not a brief at all (an answer that cannot be drawn is not drawn). */
export function coerceBrief(raw: unknown): Brief | null {
  const b = rec(raw);
  if (!b) return null;
  const refList = (v: unknown, withAsset: boolean): BriefRef[] =>
    (Array.isArray(v) ? v : [])
      .map(rec)
      .filter((r): r is Record<string, unknown> => !!r && !!str(r.id))
      .map((r) => ({ id: str(r.id) as string, name: str(r.name) ?? "", assetId: withAsset && str(r.asset_id) && UUID.test(str(r.asset_id) as string) ? (str(r.asset_id) as string) : null }));
  const scenes: BriefScene[] = (Array.isArray(b.scenes) ? b.scenes : [])
    .map(rec)
    .filter((r): r is Record<string, unknown> => !!r && !!str(r.id))
    .map((r, i) => ({
      id: str(r.id) as string,
      n: num(r.n) ?? i + 1,
      title: str(r.title),
      visualPrompt: str(r.visual_prompt),
      characterIds: strs(r.character_ids),
      locationId: str(r.location_id),
      propIds: strs(r.prop_ids),
    }));
  const price = rec(b.price);
  const prices = new Map<string, number>();
  if (price?.state === "priced")
    for (const [k, v] of Object.entries(rec(price.nodes) ?? {})) {
      const n = num(v);
      if (n !== null && n >= 0) prices.set(k, n);
    }
  const story = rec(b.story);
  return {
    status: oneOf(b.status, ["drafting", "ready", "created"] as const),
    kind: oneOf(b.kind, ["long", "short"] as const),
    title: str(b.title),
    idea: str(b.idea),
    logline: story ? str(story.logline) : null,
    chapters: (Array.isArray(b.chapters) ? b.chapters : []).map(rec).map((c) => (c ? str(c.title) : null)).filter((x): x is string => !!x),
    characters: refList(b.characters, true),
    locations: refList(b.locations, true),
    props: refList(b.props, false),
    scenes,
    voice: oneOf(rec(b.voice)?.mode, ["off", "clip_audio", "pipeline"] as const),
    music: oneOf(rec(b.music)?.mode, ["off", "library"] as const),
    prices,
    handoff: b.status === "created" ? coerceHandoff(b.handoff) : null,
  };
}

/**
 * The brief as a graph of DRAFT steps, in the same places the live graph will use. A long video is drawn as the channel run's own
 * stages (Create hands it to Run now); a short one, or one whose kind is not chosen yet, as a film.
 */
export function briefGraph(b: Brief): LiveGraph {
  const nodes: LiveNode[] = [];
  const edges: LiveEdge[] = [];
  const price = (id: string): number | null => b.prices.get(id) ?? null;
  const outline = [b.logline, ...b.chapters].filter(Boolean).join("\n") || null;

  if (b.kind === "long") {
    // Run now cuts its own scenes and picks its own topic from this brief: the stages are the pipeline's, nothing per scene.
    const kinds: RunNodeKind[] = ["topic", "research", "script", "voice", "visuals", "render", "gate", "upload"];
    kinds.forEach((kind, i) => {
      const text = kind === "topic" ? b.idea ?? b.title : kind === "script" ? outline : null;
      nodes.push({ id: kind, kind, status: "draft", text, price: price(kind), col: i, row: 0 });
      if (i > 0) edges.push({ from: kinds[i - 1], to: kind });
    });
    return { nodes, edges, settled: false };
  }

  nodes.push({ id: "idea", kind: "idea", status: "draft", text: b.idea ?? b.title, col: 0, row: 0 });
  nodes.push({ id: "script", kind: "script", status: "draft", text: outline, col: 1, row: 0 });
  edges.push({ from: "idea", to: "script" });
  const refs: { list: BriefRef[]; kind: "character" | "location" | "prop" }[] = [
    { list: b.characters, kind: "character" },
    { list: b.locations, kind: "location" },
    { list: b.props, kind: "prop" },
  ];
  let refRow = 0;
  const refIds = new Set<string>();
  for (const { list, kind } of refs) {
    for (const r of list) {
      const id = `ref:${r.id}`;
      refIds.add(r.id);
      // A reference picture that exists already (uploaded, or from the library) is real; one still to be made is a sketch.
      nodes.push({ id, kind, status: r.assetId ? "done" : "draft", sceneTitle: r.name || undefined, assetId: r.assetId, col: 1, row: ++refRow });
      edges.push({ from: "script", to: id });
    }
  }
  b.scenes.forEach((s, i) => {
    const kf = `scene:${s.id}:keyframe`;
    const clip = `scene:${s.id}:clip`;
    nodes.push({ id: kf, kind: "keyframe", status: "draft", scene: s.n, sceneTitle: s.title ?? undefined, text: s.visualPrompt, col: 2, row: i });
    // brief.price.nodes is per scene: the scene's number sits on its clip, the step that costs it.
    nodes.push({ id: clip, kind: "clip", status: "draft", scene: s.n, sceneTitle: s.title ?? undefined, text: s.visualPrompt, price: price(s.id), col: 3, row: i });
    edges.push({ from: "script", to: kf }, { from: kf, to: clip });
    // A character, place or prop made once and reused in every shot that names it: how the scenes stay consistent.
    for (const r of [...s.characterIds, ...(s.locationId ? [s.locationId] : []), ...s.propIds]) if (refIds.has(r)) edges.push({ from: `ref:${r}`, to: kf });
  });
  const rows = Math.max(1, b.scenes.length);
  const mid = Math.floor((rows - 1) / 2);
  // "off" and "clip_audio" are films with no narration take (with clip_audio the video model speaks the lines inside each clip):
  // the live graph draws the voice step "none", so the draft does too (Lens). Not asked yet is still a planned step.
  const voiced = b.voice !== "off" && b.voice !== "clip_audio";
  nodes.push({ id: "voice", kind: "voice", status: voiced ? "draft" : "none", price: price("voice"), col: 4, row: -1 });
  edges.push({ from: "script", to: "voice" });
  const music = b.music === "library";
  nodes.push({ id: "music", kind: "music", status: music ? "draft" : "none", price: price("music"), col: 4, row: rows });
  nodes.push({ id: "assembly", kind: "assembly", status: "draft", price: price("assembly"), col: 5, row: mid });
  for (const s of b.scenes) edges.push({ from: `scene:${s.id}:clip`, to: "assembly" });
  if (voiced) edges.push({ from: "voice", to: "assembly" });
  if (music) edges.push({ from: "music", to: "assembly" });
  nodes.push({ id: "final", kind: "final", status: "draft", col: 6, row: mid });
  edges.push({ from: "assembly", to: "final" });
  return { nodes, edges, settled: false };
}

/** Where the live view reads a handed-off brief: the same URLs the Studio opens after Create (docs/studio/NIGHTSHIFT_AI.md, Handoff). */
export function handoffHref(h: BriefHandoff): string {
  if (h.kind === "film") return `?view=live&film=${encodeURIComponent(h.filmId)}`;
  if ("jobId" in h) return `?view=live&channel=${encodeURIComponent(h.channelId)}&run=${encodeURIComponent(h.jobId)}`;
  const hold = h.creditRef ? `&hold=${encodeURIComponent(h.creditRef)}` : "";
  return `?view=live&channel=${encodeURIComponent(h.channelId)}&since=${encodeURIComponent(h.dispatchedAt)}${hold}`;
}
