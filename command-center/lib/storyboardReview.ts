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

import { fmt, type Dictionary } from "@/lib/i18n";

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
  };
}

/** "about 4.5 min" — the storyboard's own length, the one the price is for. */
export function minutesLabel(seconds: number): string {
  const m = seconds / 60;
  return m >= 10 ? String(Math.round(m)) : (Math.round(m * 10) / 10).toString();
}

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
      },
    };
  if (code === "NS429") return { status: 429, body: { error: "run_limit" } };
  if (code === "22023" && ["price_required", "below_floor", "invalid_backend"].includes(msg))
    return { status: msg === "invalid_backend" ? 400 : 409, body: { error: msg } };
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
    default:
      return t.errGeneric;
  }
}
