/**
 * The Studio's live view of one plan as a graph of steps (item 5): a short film (0166/0171) or a long channel video (the bot's Run
 * now pipeline). Pure: the reading in, the nodes and their lamps out. Every status comes from a row the database (or the pipeline's
 * own event log) wrote; a step with no row says so. A missing reading is "unknown", never "done" (CLAUDE.md rule 5), and nothing
 * here ever starts, retries or prices anything (rule 3): the view only reads.
 */
import { chosenClip, chosenKeyframe, chosenShots, coerceTimelineFilm, narrationTake, type TakeMedia, type TimelineFilm } from "@/lib/studio/timeline";

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * - waiting: in the plan, not started yet (a planned or queued row, or no row while the project has not reached it)
 * - working: a row says it is running now
 * - done / failed / skipped: a row says so
 * - stopped: it was running when the whole run ended without finishing it
 * - unknown: what it is cannot be read (a missing table, an unreadable answer, a run whose events are not here)
 * - none: not part of this plan (no music chosen, no voice asked for)
 */
export type LiveStatus = "waiting" | "working" | "done" | "failed" | "skipped" | "stopped" | "unknown" | "none";

export type FilmNodeKind = "idea" | "script" | "keyframe" | "clip" | "voice" | "music" | "assembly" | "final";
export type RunNodeKind = "topic" | "research" | "script" | "factcheck" | "voice" | "visuals" | "render" | "upload";
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
  /** Every step is done, failed, skipped, stopped or not in the plan: polling can stop. */
  settled: boolean;
}

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
  return { film, segments, money, errors };
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
      assetId: chosenClip(scene, takes)?.resultAssetId ?? null,
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
    row: Math.max(0, mid - 1),
  });
  edges.push({ from: "script", to: "voice" });

  // Music is a library file the person chose, not a step that runs: there, gone from the library, or not chosen.
  const music: LiveStatus = r.film.musicMissing ? "failed" : r.film.musicAssetId ? "done" : "none";
  nodes.push({ id: "music", kind: "music", status: music, assetId: r.film.musicMissing ? null : r.film.musicAssetId, error: r.film.musicMissing ? "music_missing" : null, col: 4, row: mid + 1 });

  const seg = r.segments === null ? null : ([...r.segments].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0] ?? null);
  const asm: LiveStatus = r.segments === null ? "unknown" : seg ? assemblyStatus(seg.assemblyStatus) : noRow(fs);
  nodes.push({
    id: "assembly",
    kind: "assembly",
    status: asm,
    credits: seg ? { held: seg.assemblyConfirmedCredits, charged: seg.assemblyChargedCredits } : null,
    error: asm === "failed" ? "assembly_failed" : null,
    col: 5,
    row: mid,
  });
  for (const end of sceneEnds) edges.push({ from: end, to: "assembly" });
  edges.push({ from: "voice", to: "assembly" });
  if (music !== "none") edges.push({ from: "music", to: "assembly" });

  // The final video is the assembly's file: there only when the segment recorded one.
  const finalAsset = seg?.assemblyAssetId ?? null;
  const final: LiveStatus = r.segments === null ? "unknown" : finalAsset ? "done" : asm === "failed" || asm === "stopped" ? "stopped" : asm === "done" ? "unknown" : "waiting";
  nodes.push({ id: "final", kind: "final", status: final, assetId: finalAsset, col: 6, row: mid });
  edges.push({ from: "assembly", to: "final" });

  const settled = ["ready", "failed", "cancelled", "archived"].includes(fs) && nodes.every((n) => TERMINAL.has(n.status) || n.status === "unknown");
  return { nodes, edges, settled };
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
  return { job, events, window };
}

/** daily_video.yml's video job stops at 60 minutes; a dispatch can wait for a runner before that. Past this, a run with no last event ended. */
export const RUN_WINDOW_LIMIT_MS = 90 * 60 * 1000;

/** Which events speak for which stage, in pipeline order (main.py and modules/event_log.py name them). */
const RUN_STAGES: { kind: RunNodeKind; start: string[]; done: string[]; failAgents: string[]; failEvents: string[] }[] = [
  { kind: "topic", start: [], done: ["topic.selected"], failAgents: ["topic_manager"], failEvents: ["topic.rejected"] },
  { kind: "research", start: ["research.started"], done: ["research.completed"], failAgents: ["research_engine"], failEvents: [] },
  { kind: "script", start: ["script.started"], done: ["script.completed"], failAgents: ["script_engine", "storyboard"], failEvents: [] },
  // The fact-check has no event of its own: the publish gate's verdict is it. Without one the stage is "not recorded".
  { kind: "factcheck", start: [], done: ["publish.allowed"], failAgents: [], failEvents: ["publish.blocked"] },
  { kind: "voice", start: ["voice.started"], done: ["voice.completed"], failAgents: ["voice_gate", "audio_mixer"], failEvents: [] },
  { kind: "visuals", start: ["media.started"], done: ["media.completed"], failAgents: ["media_fetcher", "image_providers", "minimax_broll", "media_preflight"], failEvents: [] },
  { kind: "render", start: ["render.started"], done: ["render.completed"], failAgents: ["compositor"], failEvents: ["render.failed"] },
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
    // A run that timed out with no last event did not tell us what happened after: the steps it never reached are not known.
    else if (!last) status = reachedLater ? "unknown" : ended ? (jobStatus === "completed" || jobStatus === "succeeded" || (timedOut && !stageFailed) ? "unknown" : "skipped") : "waiting";
    else if (st.failEvents.includes(last.event) || last.event === "agent.failed") status = "failed";
    else if (st.done.includes(last.event)) status = "done";
    else status = ended ? "stopped" : "working";
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
  return { nodes, edges, settled: ended && nodes.every((n) => TERMINAL.has(n.status) || n.status === "unknown") };
}
