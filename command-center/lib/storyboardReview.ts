/**
 * Storyboard review (migration 0057, modules/storyboard_review.py) — the pure
 * half: the row shapes the screen reads, and how the database's refusals
 * become answers the route sends and sentences the screen says.
 *
 * A channel with review on stops its runs after the script and scene plan,
 * before anything is spent on the narration, footage or render. A person reads
 * the scene cards here and either approves the render at one price — which is
 * when its credit hold is placed — or discards it. Publishing still goes
 * through review and approvals afterwards.
 *
 * Client-safe and pure, so it is unit-tested directly
 * (tests/storyboard-review.test.ts). The bounds mirror 0057's CHECKs and the
 * pipeline's (modules/storyboard_review.py); keep the three in step.
 */

import { fmt } from "@/lib/i18n/core";
import type { Dictionary } from "@/lib/i18n";
import { extraOffFields } from "@/lib/credits";

export const MAX_SCENES = 60;
export const MAX_NARRATION = 4000;
export const MAX_VISUAL = 1000;
export const MIN_DURATION_S = 30;
export const MAX_DURATION_S = 3600;

export const STORYBOARD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type StoryboardStatus = "ready" | "approved" | "rendered" | "discarded" | "unknown";
const STATUSES: readonly string[] = ["ready", "approved", "rendered", "discarded"];

/** The columns the screen reads — never `script` (the worker's, not the page's). */
export const STORYBOARD_COLUMNS =
  "id,channel_id,slug,topic,title,scenes,duration_s,status,created_at,decided_at,credits_held,render_job_id";
/** The same, plus what editing needs (migration 0058). A database without
 *  0058 refuses these columns; the reader then falls back and the screen is
 *  read-only, as before. */
export const STORYBOARD_EDIT_COLUMNS = `${STORYBOARD_COLUMNS},revision,opening_edited,reopened_at`;

export interface StoryboardScene {
  n: number;
  name: string;
  type: string;
  narration: string;
  visual: string;
  durationS: number;
}

export interface StoryboardView {
  id: string;
  channelId: string;
  slug: string;
  topic: string;
  title: string | null;
  scenes: StoryboardScene[];
  /** The length the render is priced for and frozen at (0057: 30..3600). */
  durationS: number;
  status: StoryboardStatus;
  createdAt: string | null;
  decidedAt: string | null;
  creditsHeld: number | null;
  renderJobId: number | null;
  /** The edit counter (0058). Null when 0058 is not applied: nothing on the
   *  screen can be edited, and approving does not name a revision. */
  revision?: number | null;
}

export function isStoryboardId(v: unknown): v is string {
  return typeof v === "string" && STORYBOARD_ID_RE.test(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function intIn(v: unknown, lo: number, hi: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n !== Math.trunc(n) || n < lo || n > hi) return null;
  return n;
}

/** Scene cards from the stored jsonb. A card that does not have the shape
 *  0057 guarantees is dropped, never repaired into something it did not say. */
export function toScenes(raw: unknown): StoryboardScene[] {
  if (!Array.isArray(raw)) return [];
  const out: StoryboardScene[] = [];
  for (const item of raw.slice(0, MAX_SCENES)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const n = intIn(r.n, 1, MAX_SCENES);
    const durationS = intIn(r.duration_s, 1, 600);
    if (n === null || durationS === null || typeof r.narration !== "string") continue;
    out.push({
      n,
      name: str(r.name).slice(0, 120),
      type: str(r.type).slice(0, 40),
      narration: r.narration.slice(0, MAX_NARRATION),
      visual: str(r.visual).slice(0, MAX_VISUAL),
      durationS,
    });
  }
  return out;
}

export function toStoryboard(row: unknown): StoryboardView | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (!isStoryboardId(r.id) || typeof r.channel_id !== "string" || !r.channel_id) return null;
  const durationS = intIn(r.duration_s, MIN_DURATION_S, MAX_DURATION_S);
  if (durationS === null) return null;
  const held = typeof r.credits_held === "number" ? r.credits_held : r.credits_held != null ? Number(r.credits_held) : NaN;
  const job = typeof r.render_job_id === "number" ? r.render_job_id : r.render_job_id != null ? Number(r.render_job_id) : NaN;
  return {
    id: r.id,
    channelId: r.channel_id,
    slug: str(r.slug),
    topic: str(r.topic),
    title: str(r.title) || null,
    scenes: toScenes(r.scenes),
    durationS,
    status: (STATUSES.includes(str(r.status)) ? r.status : "unknown") as StoryboardStatus,
    createdAt: str(r.created_at) || null,
    decidedAt: str(r.decided_at) || null,
    creditsHeld: Number.isFinite(held) ? held : null,
    renderJobId: Number.isFinite(job) ? job : null,
    revision: intIn(r.revision, 0, 100_000),
  };
}

/** "about 4.5 min" — the storyboard's own length, the one the price is for. */
export function minutesLabel(seconds: number): string {
  const m = seconds / 60;
  return m >= 10 ? String(Math.round(m)) : (Math.round(m * 10) / 10).toString();
}

// ── editing (migration 0058) ───────────────────────────────────────────────
// The database is the judge of every rule below (save_storyboard_edits); the
// screen checks the same ones only to say what is wrong before a round trip.

/** One scene of an edit, as save_storyboard_edits takes it: which scene of
 *  the saved revision it is (`src`, 1-based) or null for a new one, and its
 *  text. No length — the database measures an edited scene — and no ids. */
export interface SceneEdit {
  src: number | null;
  narration: string;
  visual: string;
}

export const MAX_TOTAL_TEXT = 120_000;
export const MAX_VISUAL_TERMS = 8;
export const MAX_VISUAL_TERM = 120;

const CONTROL_RE = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DIRECTION_RE = /[\u202a-\u202e\u2066-\u2069]/;
const CUE_RE = /\[\s*(sfx|music|pause|voice)\s*:/i;

/** Whitespace collapsed, as the database stores a scene's text. */
export function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export type SceneProblem = "empty" | "too_long" | "markup" | "characters" | "terms";

/** What is wrong with one scene's text, or null. */
export function sceneProblem(e: Pick<SceneEdit, "narration" | "visual">): SceneProblem | null {
  for (const raw of [e.narration, e.visual]) {
    if (CONTROL_RE.test(raw) || DIRECTION_RE.test(raw)) return "characters";
    if (CUE_RE.test(raw)) return "markup";
  }
  const n = squash(e.narration);
  const v = squash(e.visual);
  if (!n) return "empty";
  if (n.length > MAX_NARRATION || v.length > MAX_VISUAL) return "too_long";
  const terms = v.split(",").map((t) => t.trim()).filter(Boolean);
  if (terms.length > MAX_VISUAL_TERMS || terms.some((t) => t.length > MAX_VISUAL_TERM)) return "terms";
  return null;
}

/** The scenes of an edit, checked as a whole. Null when it may be sent. */
export function editProblem(scenes: SceneEdit[]): "count" | "total" | "duplicate" | "scene" | null {
  if (scenes.length < 1 || scenes.length > MAX_SCENES) return "count";
  const srcs = scenes.flatMap((s) => (s.src === null ? [] : [s.src]));
  if (new Set(srcs).size !== srcs.length) return "duplicate";
  if (scenes.some((s) => sceneProblem(s) !== null)) return "scene";
  const total = scenes.reduce((a, s) => a + squash(s.narration).length + squash(s.visual).length, 0);
  if (total > MAX_TOTAL_TEXT) return "total";
  return null;
}

/** An edit body from the route's JSON, or null when it is not one. Strict:
 *  only `src`, `narration` and `visual` on each scene — no ids of any kind
 *  pass through to the database (which refuses them too). */
export function toSceneEdits(raw: unknown): SceneEdit[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SCENES) return null;
  const out: SceneEdit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const r = item as Record<string, unknown>;
    if (Object.keys(r).some((k) => k !== "src" && k !== "narration" && k !== "visual")) return null;
    const src = r.src ?? null;
    if (src !== null && intIn(src, 1, MAX_SCENES) === null) return null;
    if (typeof src === "string") return null;
    if (typeof r.narration !== "string") return null;
    if (r.visual != null && typeof r.visual !== "string") return null;
    out.push({ src: src as number | null, narration: r.narration, visual: (r.visual as string | undefined) ?? "" });
  }
  return out;
}

/** Why a failed render's storyboard can or cannot be re-opened (0058). */
export type ReopenState = { reopenable: boolean; reason: string | null };

// ── the price on the button ────────────────────────────────────────────────

/** What the server knows about the render's price. `credits` is a number
 *  only when the backend computed one; nothing on the screen guesses it. */
export type StoryboardQuote =
  | { kind: "paid"; credits: number }
  | { kind: "included" }
  | { kind: "unavailable"; reason: "no_prices" | "no_length" | "no_history" | "unpriced_history" | "read_failed" | "not_enforced" };

// ── the database's answers ─────────────────────────────────────────────────

export type StoryboardErrorCode =
  | "forbidden"
  | "storyboard_not_ready"
  | "insufficient_credits"
  | "run_limit"
  | "price_required"
  | "below_floor"
  | "price_changed"
  | "invalid_backend"
  | "storyboard_unavailable"
  | "credit_estimate_unavailable"
  | "credits_not_enforced"
  | "dispatch_failed"
  | "stale_revision"
  | "scenes_invalid"
  | "storyboard_too_long"
  | "storyboard_not_editable"
  | "render_in_progress"
  | "render_finished"
  | "hold_not_released"
  | "render_unverifiable"
  | "approve_failed";

type DbError = { code?: string; message?: string; details?: string | null; hint?: string | null };

function detailNumber(text: string | null | undefined, key: string): number | null {
  const m = new RegExp(`${key}=([0-9.]+)`).exec(text ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * An approve / discard RPC error → the route's answer. Never a 500 with the
 * database's text: the code is the contract, the body carries only numbers
 * the person may see (their own balance and the price).
 */
export function mapStoryboardError(error: DbError): { status: number; body: Record<string, unknown> } {
  const code = error.code ?? "";
  const msg = (error.message ?? "").trim();
  if (code === "42501") return { status: 403, body: { error: "forbidden" } };
  if (code === "NS409") return { status: 409, body: { error: "storyboard_not_ready" } };
  if (code === "NS402")
    return {
      status: 402,
      body: {
        error: "insufficient_credits",
        needed: detailNumber(error.details, "needed"),
        available: detailNumber(error.details, "available"),
        ...extraOffFields(error.details),
      },
    };
  if (code === "NS429") return { status: 429, body: { error: "run_limit" } };
  // 0058: an edit or an approval made on a revision that is no longer the
  // latest — never merged, the person reloads.
  if (code === "NS412") return { status: 409, body: { error: "stale_revision", revision: detailNumber(error.details, "revision") } };
  if (code === "NS423" && ["render_in_progress", "render_finished", "hold_not_released", "render_unverifiable"].includes(msg))
    return { status: 409, body: { error: msg } };
  if (code === "22023" && ["price_required", "below_floor", "invalid_backend"].includes(msg))
    return { status: msg === "invalid_backend" ? 400 : 409, body: { error: msg } };
  if (code === "22023" && (msg === "scenes_invalid" || msg === "storyboard_too_long"))
    return { status: 400, body: { error: msg } };
  if (code === "22023" && msg === "storyboard_not_editable") return { status: 409, body: { error: msg } };
  if (code === "23514") return { status: 400, body: { error: "scenes_invalid" } };
  if (
    code === "42P01" ||
    code === "42883" ||
    code === "PGRST202" ||
    code === "PGRST205" ||
    /does not exist|could not find/i.test(msg)
  )
    return { status: 503, body: { error: "storyboard_unavailable" } };
  return { status: 502, body: { error: "approve_failed" } };
}

/** The sentence the screen says for a route's error body. */
export function storyboardErrorText(body: Record<string, unknown> | null, t: Dictionary["storyboardReview"]): string {
  const error = typeof body?.error === "string" ? body.error : "";
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "?");
  switch (error) {
    case "insufficient_credits":
      return fmt(t.errInsufficient, { needed: num(body?.needed), available: num(body?.available) });
    case "price_changed":
      return fmt(t.errPriceChanged, { credits: num(body?.credits) });
    case "storyboard_not_ready":
      return t.errNotReady;
    case "run_limit":
      return t.errRunLimit;
    case "forbidden":
    case "not_found":
    case "channel_not_found":
      return t.notAllowed;
    case "storyboard_unavailable":
      return t.errUnavailable;
    case "credit_estimate_unavailable":
    case "credits_unavailable":
    case "credits_read_failed":
    case "credits_not_enforced":
    case "below_floor":
    case "price_required":
      return t.noPrice;
    case "dispatch_failed":
      return t.errDispatch;
    case "stale_revision":
      return t.errStale;
    case "scenes_invalid":
    case "bad_request":
      return t.errScenes;
    case "storyboard_too_long":
      return t.errTooLong;
    case "storyboard_not_editable":
    case "editing_unavailable":
      return t.errNotEditable;
    case "unsaved_changes":
      return t.saveFirst;
    case "render_in_progress":
    case "hold_not_released":
    case "render_unverifiable":
      return t.errReopenBusy;
    case "render_finished":
      return t.errReopenFinished;
    default:
      return t.errGeneric;
  }
}
