/**
 * Multi-clip repurposing (migration 0080, modules/repurpose.py) — the pure
 * half: which clips of a finished master are worth proposing, the quote the
 * button shows, the rows the video page reads, and how the database's refusals
 * become route answers and sentences.
 *
 * "Repurpose" is ONE priced, confirmed press for up to five vertical clips of a
 * video's master:
 *  - the windows are runs of WHOLE scenes of the video's own Video IR, so a clip
 *    never starts or ends inside a scene (and so never inside a word). The
 *    ranking below only PROPOSES them: the database re-derives every window
 *    from the Video IR and refuses anything else, and the worker checks the
 *    files on disk again;
 *  - with no usable retention curve the proposal says "not measured" and ranks
 *    by scene structure only; it never turns an unknown into a number;
 *  - the price comes from the database (quote_repurpose), never from the
 *    browser, and an unset price is "unpriced", never 0; the press carries the
 *    price it showed (max_credits) and one idempotency key;
 *  - every made clip is its own held, private video. Nothing here uploads,
 *    publishes or changes privacy.
 *
 * The Python twin is modules/repurpose.py; both run samples/repurpose_cases.json
 * (the database's repurpose_plan runs the plan cases too). Client-safe and
 * pure, so it is unit-tested directly (tests/repurpose.test.ts).
 */

import { fmt, type Dictionary } from "@/lib/i18n";
import { mapScenes, videoDuration, type RetentionPointInput, type SceneWindow } from "@/lib/sceneRetention";

// ── limits (migration 0080 and modules/repurpose.py repeat these) ───────────

export const MIN_CLIP_SECONDS = 15;
export const MAX_CLIP_SECONDS = 60;
export const MAX_CLIPS = 5;
export const MAX_CLIP_SCENES = 12;
export const AUDIO_SLACK_S = 0.5;
export const EDGE_SLACK_S = 0.001;

const SCENE_ID = /^s\d{3,4}$/;
/** Held runs are "run-" + 20 hex; uploaded ones a YouTube id. */
const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IDEM = /^[A-Za-z0-9_:.-]{8,128}$/;

export function isSceneId(v: unknown): v is string {
  return typeof v === "string" && SCENE_ID.test(v);
}
export function isVideoId(v: unknown): v is string {
  return typeof v === "string" && VIDEO_ID.test(v);
}
export function isIdempotencyKey(v: unknown): v is string {
  return typeof v === "string" && IDEM.test(v);
}

/** One key per intended press: a retry of the same press (a dropped
 *  connection, a double click) sends the same key and gets the same request. */
export function newIdempotencyKey(rand: () => string = () => globalThis.crypto.randomUUID()): string {
  return `repurpose:${rand()}`;
}

// ── windows ─────────────────────────────────────────────────────────────────

/** A clip as it is named to the database: its first and last scene. */
export interface ClipRef {
  first: string;
  last: string;
}

export interface ClipWindow extends ClipRef {
  position: number;
  sceneIds: string[];
  startS: number;
  endS: number;
  durationS: number;
}

export type PlanReason =
  | "invalid_clips"
  | "no_manifest"
  | "scene_ids_not_unique"
  | "scene_not_found"
  | "invalid_range"
  | "too_many_scenes"
  | "scene_timing_unknown"
  | "clip_too_short"
  | "clip_too_long"
  | "beyond_audio"
  | "clips_overlap";

export type PlanResult =
  | { ok: true; clips: ClipWindow[] }
  | { ok: false; reason: PlanReason; position?: number };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A JSON number (a bool, string or NaN is not a time). */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** round(x, 3) the way the database's numeric does it: half away from zero,
 *  decided on the number's shortest decimal text, not on binary noise. */
export function round3(x: number): number {
  const text = String(x);
  if (/e/i.test(text)) return Math.round(x * 1000) / 1000;
  const neg = x < 0;
  const [int, frac = ""] = text.replace("-", "").split(".");
  if (frac.length <= 3) return x;
  let scaled = BigInt(int + frac.slice(0, 3).padEnd(3, "0"));
  if (frac.charCodeAt(3) >= 53) scaled += BigInt(1); // '5'
  const out = Number(scaled) / 1000;
  return neg ? -out : out;
}

const ms = (x: number) => Math.round(x * 1000);

/** The clips a request names as windows of whole scenes of a Video IR — the
 *  database's repurpose_plan, check for check and reason word for reason word. */
export function planClips(manifest: unknown, clips: unknown): PlanResult {
  if (!Array.isArray(clips) || clips.length < 1 || clips.length > MAX_CLIPS) return { ok: false, reason: "invalid_clips" };
  if (!isObject(manifest) || !Array.isArray(manifest.scenes)) return { ok: false, reason: "no_manifest" };
  const ids: Array<string | null> = [];
  const starts: Array<number | null> = [];
  const ends: Array<number | null> = [];
  for (const sc of manifest.scenes) {
    if (isObject(sc) && typeof sc.id === "string" && SCENE_ID.test(sc.id)) {
      ids.push(sc.id);
      starts.push(num(sc.start_s));
      ends.push(num(sc.end_s));
    } else {
      ids.push(null);
      starts.push(null);
      ends.push(null);
    }
  }
  const named = ids.filter((i): i is string => i !== null);
  if (named.length !== new Set(named).size) return { ok: false, reason: "scene_ids_not_unique" };
  const audio = isObject(manifest.audio) ? num(manifest.audio.duration_s) : null;

  const out: ClipWindow[] = [];
  const ranges: Array<[number, number]> = [];
  for (let p = 0; p < clips.length; p++) {
    const pos = p + 1;
    const c = clips[p];
    if (!isObject(c) || typeof c.first !== "string" || typeof c.last !== "string" || !SCENE_ID.test(c.first) || !SCENE_ID.test(c.last)) {
      return { ok: false, reason: "invalid_clips" };
    }
    const fo = ids.indexOf(c.first);
    const lo = ids.indexOf(c.last);
    if (fo < 0 || lo < 0) return { ok: false, reason: "scene_not_found", position: pos };
    if (fo > lo) return { ok: false, reason: "invalid_range", position: pos };
    if (lo - fo + 1 > MAX_CLIP_SCENES) return { ok: false, reason: "too_many_scenes", position: pos };
    const sceneIds: string[] = [];
    for (let k = fo; k <= lo; k++) {
      const s = starts[k];
      const e = ends[k];
      const prevEnd = k > fo ? ends[k - 1] : null;
      if (ids[k] === null || s === null || e === null || s < 0 || e <= s || (prevEnd !== null && s < prevEnd - EDGE_SLACK_S)) {
        return { ok: false, reason: "scene_timing_unknown", position: pos };
      }
      sceneIds.push(ids[k] as string);
    }
    const wStart = round3(starts[fo] as number);
    const wEnd = round3(ends[lo] as number);
    const durMs = ms(wEnd) - ms(wStart);
    if (durMs < MIN_CLIP_SECONDS * 1000) return { ok: false, reason: "clip_too_short", position: pos };
    if (durMs > MAX_CLIP_SECONDS * 1000) return { ok: false, reason: "clip_too_long", position: pos };
    if (audio !== null && wEnd > audio + AUDIO_SLACK_S) return { ok: false, reason: "beyond_audio", position: pos };
    if (ranges.some(([a, b]) => !(lo < a || fo > b))) return { ok: false, reason: "clips_overlap", position: pos };
    ranges.push([fo, lo]);
    out.push({ position: pos, first: c.first, last: c.last, sceneIds, startS: wStart, endS: wEnd, durationS: durMs / 1000 });
  }
  return { ok: true, clips: out };
}

// ── proposals (advisory) ────────────────────────────────────────────────────

export interface ClipProposal extends ClipRef {
  /** 1 = the strongest. */
  rank: number;
  sceneIds: string[];
  startS: number;
  endS: number;
  durationS: number;
  /** Minus the audience's drop per minute across the window (higher = they stayed
   *  longer), or null when retention was not measured at its edges. */
  score: number | null;
  measured: boolean;
}

export interface Proposals {
  /** "measured": a usable curve scored at least one window. "not_measured": scene structure only. */
  retention: "measured" | "not_measured";
  clips: ClipProposal[];
}

interface Candidate extends ClipRef {
  sceneIds: string[];
  startS: number;
  endS: number;
  durationS: number;
}

/** Every allowed window: runs of consecutive scenes with real times, 15..60 s,
 *  at most 12 scenes, inside the audio — exactly those planClips accepts as one clip. */
export function candidateWindows(manifest: unknown): Candidate[] {
  const scenes = isObject(manifest) && Array.isArray(manifest.scenes) ? manifest.scenes : null;
  if (!scenes) return [];
  const found: Candidate[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const first = isObject(scenes[i]) ? (scenes[i] as Record<string, unknown>).id : null;
    if (typeof first !== "string") continue;
    for (let j = i; j < Math.min(scenes.length, i + MAX_CLIP_SCENES); j++) {
      const last = isObject(scenes[j]) ? (scenes[j] as Record<string, unknown>).id : null;
      if (typeof last !== "string") break;
      const plan = planClips(manifest, [{ first, last }]);
      if (plan.ok) {
        const c = plan.clips[0];
        found.push({ first, last, sceneIds: c.sceneIds, startS: c.startS, endS: c.endS, durationS: c.durationS });
        continue;
      }
      if (plan.reason !== "clip_too_short") break; // a longer run only gets longer, later, or is broken
    }
  }
  return found;
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** Minus the drop in the share still watching, per minute, across each window;
 *  null where an edge lies off the measured curve (never extrapolated). */
function windowScores(manifest: unknown, points: readonly RetentionPointInput[] | null | undefined, windows: readonly Candidate[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const key = (w: ClipRef) => `${w.first}:${w.last}`;
  if (!isObject(manifest) || !Array.isArray(manifest.scenes)) {
    windows.forEach((w) => out.set(key(w), null));
    return out;
  }
  // Only scenes that carry their own id (see modules/repurpose.py).
  const scenes = manifest.scenes.filter(
    (sc): sc is Record<string, unknown> => isObject(sc) && typeof sc.id === "string" && SCENE_ID.test(sc.id),
  ) as SceneWindow[];
  const rows = mapScenes(scenes, points, videoDuration(manifest, scenes));
  const byId = new Map(rows.map((r) => [r.sceneId, r]));
  for (const w of windows) {
    const a = byId.get(w.first);
    const b = byId.get(w.last);
    const start = a?.retentionStart ?? null;
    const end = b?.retentionEnd ?? null;
    out.set(key(w), start === null || end === null || w.durationS <= 0 ? null : round4(-((start - end) / (w.durationS / 60))));
  }
  return out;
}

/**
 * The best non-overlapping windows of a master, best first. The same greedy
 * pick as modules/remix_segments.select_segments: measured before unmeasured,
 * higher score, longer, earlier — an unmeasured window never outranks a
 * measured one, and is never read as a measured zero.
 */
export function proposeClips(
  manifest: unknown,
  points: readonly RetentionPointInput[] | null | undefined,
  maxClips: number = MAX_CLIPS,
): Proposals {
  const cap = Math.max(0, Math.min(Math.trunc(maxClips), MAX_CLIPS));
  const windows = candidateWindows(manifest);
  const scores = windowScores(manifest, points, windows);
  const key = (w: ClipRef) => `${w.first}:${w.last}`;
  const measured = [...scores.values()].some((v) => v !== null);
  const ranked = windows
    .map((w, i) => ({ w, i, score: scores.get(key(w)) ?? null }))
    .sort((a, b) => {
      const am = a.score !== null;
      const bm = b.score !== null;
      if (am !== bm) return am ? -1 : 1;
      const as = a.score ?? 0;
      const bs = b.score ?? 0;
      if (as !== bs) return bs - as;
      if (a.w.durationS !== b.w.durationS) return b.w.durationS - a.w.durationS;
      if (a.w.startS !== b.w.startS) return a.w.startS - b.w.startS;
      return a.i - b.i;
    });
  const chosen: typeof ranked = [];
  if (cap > 0) {
    for (const r of ranked) {
      if (chosen.some((c) => r.w.startS < c.w.endS && c.w.startS < r.w.endS)) continue;
      chosen.push(r);
      if (chosen.length >= cap) break;
    }
  }
  return {
    retention: measured ? "measured" : "not_measured",
    clips: chosen.map((c, i) => ({
      rank: i + 1,
      first: c.w.first,
      last: c.w.last,
      sceneIds: c.w.sceneIds,
      startS: c.w.startS,
      endS: c.w.endS,
      durationS: c.w.durationS,
      score: c.score,
      measured: c.score !== null,
    })),
  };
}

/** Two picked clips share a scene (the database refuses it; the screen says so first). */
export function pickedOverlap(picked: readonly ClipProposal[]): boolean {
  for (let i = 0; i < picked.length; i++) {
    for (let j = i + 1; j < picked.length; j++) {
      if (picked[i].startS < picked[j].endS && picked[j].startS < picked[i].endS) return true;
    }
  }
  return false;
}

/** `s000-s002,s004-s004` — the picked clips in a query string, in the order picked. */
export function encodeClips(clips: readonly ClipRef[]): string {
  return clips.map((c) => `${c.first}-${c.last}`).join(",");
}

/** The inverse, or null when it is not at most five well-formed pairs. */
export function decodeClips(raw: string | null | undefined): ClipRef[] | null {
  if (typeof raw !== "string" || raw === "") return null;
  const parts = raw.split(",");
  if (parts.length < 1 || parts.length > MAX_CLIPS) return null;
  const out: ClipRef[] = [];
  for (const part of parts) {
    const m = /^(s\d{3,4})-(s\d{3,4})$/.exec(part);
    if (!m) return null;
    out.push({ first: m[1], last: m[2] });
  }
  return out;
}

/** The body of a press: clips as `{first, last}` pairs only. */
export function clipRefs(raw: unknown): ClipRef[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_CLIPS) return null;
  const out: ClipRef[] = [];
  for (const c of raw) {
    if (!isObject(c) || !isSceneId(c.first) || !isSceneId(c.last)) return null;
    out.push({ first: c.first, last: c.last });
  }
  return out;
}

// ── the quote ───────────────────────────────────────────────────────────────

export type QuoteStatus = "priced" | "included" | "unpriced" | "unavailable";

/** Why clips cannot be made, as quote_repurpose says it. */
export type UnavailableReason =
  | PlanReason
  | "is_a_clip"
  | "gate_blocked"
  | "rejected"
  | "no_run"
  | "no_master"
  | "master_too_small"
  | "in_progress"
  | "unknown";

const REASONS: readonly string[] = [
  "invalid_clips", "no_manifest", "scene_ids_not_unique", "scene_not_found", "invalid_range", "too_many_scenes",
  "scene_timing_unknown", "clip_too_short", "clip_too_long", "beyond_audio", "clips_overlap", "is_a_clip",
  "gate_blocked", "rejected", "no_run", "no_master", "master_too_small", "in_progress",
];

export interface RepurposeQuote {
  status: QuoteStatus;
  /** Credits for the whole press — only when status is "priced". */
  credits: number | null;
  /** What one clip costs, as charged. */
  clipCredits: number | null;
  reason: UnavailableReason | null;
  /** The clip a window reason is about (1-based), when it names one. */
  position: number | null;
  /** May this person press (an admin of the channel's organization)? */
  mayStart: boolean;
  clips: ClipWindow[];
}

function numish(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function parseWindows(raw: unknown): ClipWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: ClipWindow[] = [];
  for (const c of raw) {
    if (!isObject(c) || !isSceneId(c.first) || !isSceneId(c.last)) continue;
    const startS = numish(c.start_s);
    const endS = numish(c.end_s);
    const durationS = numish(c.duration_s);
    const position = numish(c.position);
    if (startS === null || endS === null || durationS === null || position === null) continue;
    out.push({
      position, first: c.first, last: c.last, startS, endS, durationS,
      sceneIds: Array.isArray(c.scene_ids) ? c.scene_ids.filter((x): x is string => typeof x === "string") : [],
    });
  }
  return out;
}

/** The database's quote jsonb → what the button needs. Anything unexpected
 *  reads as unavailable, never as a price. */
export function parseQuote(raw: unknown): RepurposeQuote {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const statusRaw = typeof r.status === "string" ? r.status : "";
  const status: QuoteStatus = (["priced", "included", "unpriced", "unavailable"] as const).includes(statusRaw as QuoteStatus)
    ? (statusRaw as QuoteStatus)
    : "unavailable";
  const credits = status === "priced" ? numish(r.credits) : null;
  const clipCredits = status === "priced" ? numish(r.clip_credits) : null;
  const reasonRaw = typeof r.reason === "string" ? r.reason : null;
  const out: RepurposeQuote = {
    status,
    credits: credits !== null && credits > 0 ? credits : null,
    clipCredits: clipCredits !== null && clipCredits > 0 ? clipCredits : null,
    reason: status === "unavailable" ? ((reasonRaw && REASONS.includes(reasonRaw) ? reasonRaw : "unknown") as UnavailableReason) : null,
    position: status === "unavailable" ? numish(r.position) : null,
    mayStart: r.may_start === true,
    clips: parseWindows(r.clips),
  };
  // A "priced" quote without a positive number is not a price.
  if (status === "priced" && out.credits === null) return { ...out, status: "unavailable", reason: "unknown" };
  return out;
}

/** May the button be pressed for this quote? */
export function canPress(q: RepurposeQuote | null): boolean {
  return !!q && q.mayStart && (q.status === "priced" || q.status === "included") && q.clips.length > 0;
}

// ── the rows the page reads ─────────────────────────────────────────────────

export type RequestStatus = "queued" | "running" | "succeeded" | "partial" | "failed";
export type ClipStatus = "queued" | "rendered" | "failed";

export const REQUEST_COLUMNS =
  "id,status,clip_count,quoted_credits,charged_credits,error_code,created_at,finished_at";
export const CLIP_COLUMNS =
  "request_id,ordinal,first_scene,last_scene,start_s,end_s,duration_s,status,clip_video_id,error_code,captions";

export interface ClipRow {
  requestId: string;
  ordinal: number;
  first: string;
  last: string;
  startS: number;
  endS: number;
  durationS: number;
  status: ClipStatus;
  clipVideoId: string | null;
  errorCode: string | null;
  captions: { youtube?: string; instagram?: string; tiktok?: string } | null;
}

export interface RequestRow {
  id: string;
  status: RequestStatus;
  clipCount: number;
  quotedCredits: number | null;
  chargedCredits: number | null;
  errorCode: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  clips: ClipRow[];
}

function captionText(raw: unknown): ClipRow["captions"] {
  if (!isObject(raw)) return null;
  const yt = isObject(raw.youtube) && typeof raw.youtube.title === "string" ? raw.youtube.title : undefined;
  const ig = typeof raw.instagram === "string" ? raw.instagram : undefined;
  const tt = typeof raw.tiktok === "string" ? raw.tiktok : undefined;
  return yt || ig || tt ? { youtube: yt, instagram: ig, tiktok: tt } : null;
}

export function parseClipRows(rows: unknown): ClipRow[] {
  if (!Array.isArray(rows)) return [];
  const out: ClipRow[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!isObject(r) || typeof r.request_id !== "string" || !isSceneId(r.first_scene) || !isSceneId(r.last_scene)) continue;
    const status = r.status;
    if (status !== "queued" && status !== "rendered" && status !== "failed") continue;
    const ordinal = numish(r.ordinal);
    const startS = numish(r.start_s);
    const endS = numish(r.end_s);
    const durationS = numish(r.duration_s);
    if (ordinal === null || startS === null || endS === null || durationS === null) continue;
    out.push({
      requestId: r.request_id, ordinal, first: r.first_scene, last: r.last_scene, startS, endS, durationS, status,
      clipVideoId: typeof r.clip_video_id === "string" && isVideoId(r.clip_video_id) ? r.clip_video_id : null,
      errorCode: typeof r.error_code === "string" ? r.error_code : null,
      captions: captionText(r.captions),
    });
  }
  return out;
}

/** The video's requests, newest first, each with its clips in order. */
export function parseRequestRows(rows: unknown, clips: readonly ClipRow[] = []): RequestRow[] {
  if (!Array.isArray(rows)) return [];
  const out: RequestRow[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!isObject(r) || typeof r.id !== "string") continue;
    const status = r.status;
    if (status !== "queued" && status !== "running" && status !== "succeeded" && status !== "partial" && status !== "failed") continue;
    const count = numish(r.clip_count);
    if (count === null) continue;
    out.push({
      id: r.id, status, clipCount: count, quotedCredits: numish(r.quoted_credits), chargedCredits: numish(r.charged_credits),
      errorCode: typeof r.error_code === "string" ? r.error_code : null,
      createdAt: typeof r.created_at === "string" ? r.created_at : null,
      finishedAt: typeof r.finished_at === "string" ? r.finished_at : null,
      clips: clips.filter((c) => c.requestId === r.id).sort((a, b) => a.ordinal - b.ordinal),
    });
  }
  return out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** Is this video itself a repurposed clip (it is never repurposed again)? */
export function isRepurposedClip(v: { hold_detail?: unknown } | null | undefined): boolean {
  const d = v?.hold_detail;
  return isObject(d) && d.reason === "repurposed_clip";
}

/** The master a clip was cut from (hold_detail.master_video_id), or null. */
export function clipMasterId(v: { hold_detail?: unknown } | null | undefined): string | null {
  const d = v?.hold_detail;
  return isObject(d) && typeof d.master_video_id === "string" && isVideoId(d.master_video_id) ? d.master_video_id : null;
}

// ── the route's answers ─────────────────────────────────────────────────────

type DbError = { code?: string; message?: string; details?: string | null; hint?: string | null };

function detailNumber(text: string | null | undefined, key: string): number | null {
  const m = new RegExp(`${key}=([0-9.]+)`).exec(text ?? "");
  return m ? Number(m[1]) : null;
}

/** A quote / press RPC error → the route's answer. The code is the contract;
 *  the body carries only what the person may see (their own price, balance). */
export function mapRepurposeError(error: DbError): { status: number; body: Record<string, unknown> } {
  const code = error.code ?? "";
  const msg = (error.message ?? "").trim();
  if (code === "42501") return { status: 403, body: { error: "forbidden" } };
  if (code === "NS402")
    return {
      status: 402,
      body: {
        error: "insufficient_credits",
        needed: detailNumber(error.details, "needed"),
        available: detailNumber(error.details, "available"),
      },
    };
  if (code === "NS429") return { status: 429, body: { error: "run_limit" } };
  if (code === "NS409" && msg === "price_changed")
    return { status: 409, body: { error: "price_changed", credits: detailNumber(error.details, "credits") } };
  if (code === "NS409" && ["in_progress", "idempotency_conflict"].includes(msg)) return { status: 409, body: { error: msg } };
  if (code === "NS400" && msg === "unpriced") return { status: 409, body: { error: "unpriced" } };
  if (code === "NS400" && msg === "clips_unavailable") {
    const reason = (error.details ?? "").trim();
    return { status: 409, body: { error: "clips_unavailable", reason: REASONS.includes(reason) ? reason : "unknown" } };
  }
  if (code === "22023" && msg === "price_required")
    return { status: 409, body: { error: "price_required", credits: detailNumber(error.details, "credits") } };
  if (code === "22023" && ["invalid_clips", "invalid_idempotency_key"].includes(msg)) return { status: 400, body: { error: msg } };
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205" || /does not exist|could not find/i.test(msg))
    return { status: 503, body: { error: "repurpose_unavailable" } };
  return { status: 502, body: { error: "repurpose_failed" } };
}

// ── what the screen says ────────────────────────────────────────────────────

type T = Dictionary["repurpose"];

export function reasonText(reason: UnavailableReason | string | null, t: T): string {
  const r = (reason ?? "unknown") as keyof T["reasons"];
  return t.reasons[r] ?? t.reasons.unknown;
}

/** The sentence for a route's error body. */
export function repurposeErrorText(body: Record<string, unknown> | null, t: T): string {
  const error = typeof body?.error === "string" ? body.error : "";
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "?");
  switch (error) {
    case "forbidden":
      return t.errors.forbidden;
    case "insufficient_credits":
      return fmt(t.errors.insufficient, { needed: n(body?.needed), available: n(body?.available) });
    case "run_limit":
      return t.errors.runLimit;
    case "price_changed":
      return fmt(t.errors.priceChanged, { credits: n(body?.credits) });
    case "price_required":
      return t.errors.priceRequired;
    case "in_progress":
      return t.reasons.in_progress;
    case "idempotency_conflict":
      return t.errors.conflict;
    case "unpriced":
      return t.unpriced;
    case "clips_unavailable":
      return reasonText(typeof body?.reason === "string" ? body.reason : null, t);
    case "queue_required":
      return t.errors.queueRequired;
    case "invalid_clips":
      return t.errors.invalidClips;
    case "repurpose_unavailable":
      return t.errors.notInstalled;
    default:
      return t.errors.failed;
  }
}

/** mm:ss for a position in the master. */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The line under a proposal: what retention says about it, or that it was not measured. */
export function scoreText(p: Pick<ClipProposal, "score" | "measured">, t: T): string {
  if (!p.measured || p.score === null) return t.scoreNotMeasured;
  // The score is minus the drop per minute, in share-of-audience points.
  const points = Math.round(Math.abs(p.score) * 1000) / 10;
  return p.score > 0
    ? fmt(t.scoreGained, { n: String(points) })
    : p.score === 0
      ? t.scoreHeld
      : fmt(t.scoreLost, { n: String(points) });
}

/** A request's headline: what is happening or what happened, and what it cost. */
export function requestText(r: RequestRow, t: T): string {
  const made = r.clips.filter((c) => c.status === "rendered").length;
  switch (r.status) {
    case "queued":
      return t.status.queued;
    case "running":
      return fmt(t.status.running, { done: String(made), n: String(r.clipCount) });
    case "succeeded":
      return r.chargedCredits !== null
        ? fmt(t.status.succeeded, { n: String(made), credits: String(r.chargedCredits) })
        : fmt(t.status.succeededIncluded, { n: String(made) });
    case "partial":
      return fmt(t.status.partial, { made: String(made), n: String(r.clipCount), credits: String(r.chargedCredits ?? 0) });
    default:
      return `${t.status.failed} ${failureText(r.errorCode, t)}`;
  }
}

export function failureText(code: string | null, t: T): string {
  return (code && (t.failures as Record<string, string>)[code]) || t.failures.failed;
}
