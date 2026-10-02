/**
 * The comment inbox (migration 0081, modules/comment_replies.py) — the pure,
 * client-safe half: the shapes the page reads, what a comment may be given,
 * the price on the button, and how the database's refusals become route
 * answers and sentences.
 *
 * The inbox shows a channel's YouTube comments, lets a person ask for a drafted
 * reply (one priced, confirmed press), edit or discard it, and approve it. An
 * approval is the ONLY thing that can make a reply go out, and it is the exact
 * text the person is looking at; nothing replies on its own. This file never
 * decides any of that — the database does (approve_reply and the worker's
 * functions) — it only shapes what the screen reads and says.
 *
 * Comment text is audience-controlled: it is only ever rendered as text by
 * React (never as HTML), and every value here is bounded again before display.
 *
 * Unit-tested in tests/comment-inbox.test.ts.
 */

import { fmt, type Dictionary } from "@/lib/i18n";
import { UNIT_JOB_MINIMUM, type PriceMap } from "@/lib/credits";

/** The unit the owner prices (credit_prices.unit); unset = drafting is blocked. */
export const UNIT_REPLY_DRAFT = "reply_draft";

export const INBOX_LIMITS = { replyMax: 500, listMax: 100, bodyMax: 2000, authorMax: 100 } as const;

export const CATEGORIES = ["question", "topic_request", "praise", "criticism", "spam", "off_topic"] as const;
export type CommentCategory = (typeof CATEGORIES)[number];
export type CommentStatus = "open" | "dismissed" | "replied";
export type DraftStatus = "pending" | "drafting" | "ready" | "approved" | "discarded" | "failed";
export type PostStatus = "queued" | "posting" | "posted" | "failed";

/** Why a comment is held back from drafting; null when it can be drafted. */
export type HeldReason = "spam" | "flagged" | "not_classified";

export const POST_FAILURES = [
  "quota_exceeded", "rate_limited", "token_expired", "missing_scope", "comment_gone", "comments_disabled",
  "forbidden", "platform_error", "outcome_unknown", "channel_not_ready", "invalid_reply",
] as const;
export type PostFailure = (typeof POST_FAILURES)[number];

/** The failures a person may re-queue (the database refuses the rest). */
export const RETRYABLE: readonly PostFailure[] = [
  "quota_exceeded", "rate_limited", "token_expired", "missing_scope", "platform_error", "outcome_unknown", "channel_not_ready",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEM = /^[A-Za-z0-9_:.-]{8,128}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}
export function isIdempotencyKey(v: unknown): v is string {
  return typeof v === "string" && IDEM.test(v);
}

/** One key per intended press: a retry of the same press sends the same key and gets the same draft. */
export function newIdempotencyKey(rand: () => string = () => globalThis.crypto.randomUUID()): string {
  return `reply-draft:${rand()}`;
}

/**
 * A reply as the database stores it: control, zero-width and direction-override
 * characters removed, trimmed, at most 500 characters. Empty means "nothing to
 * send". The same rules as inbox_clean_text (the database cleans again).
 */
export function cleanReply(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  return text
    .replace(/\r\n/g, "\n")
    // The same characters the database removes (tests/fixtures/inbox_cleaner_cases.txt).
    .replace(
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0d\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu,
      "",
    )
    .trim()
    .slice(0, INBOX_LIMITS.replyMax);
}

// ── the price ───────────────────────────────────────────────────────────────

const roundUpCents = (v: number) => Math.ceil(Math.round(v * 1e6) / 1e4) / 100;

/**
 * What one reply draft costs, from the price list AS CHARGED (credit_rates(),
 * 0084; never the margin): the `reply_draft` rate, at least the platform's
 * job minimum, rounded up to the cent — the database computes the same number
 * (reply_draft_price) and is the authority. null = no `reply_draft` row = NOT
 * PRICED: drafting is switched off, and it is never shown as free (CLAUDE.md #5).
 * 0 only when an admin priced the unit at 0 ("included").
 */
export function replyDraftPrice(prices: PriceMap): number | null {
  const rate = prices[UNIT_REPLY_DRAFT];
  if (!rate || !Number.isFinite(rate.creditsPerUnit) || rate.creditsPerUnit < 0) return null;
  let price = roundUpCents(rate.creditsPerUnit * (1 + (rate.margin || 0)));
  const min = prices[UNIT_JOB_MINIMUM];
  if (price > 0 && min && Number.isFinite(min.creditsPerUnit)) price = Math.max(price, roundUpCents(min.creditsPerUnit));
  return price;
}

// ── the rows the page reads ─────────────────────────────────────────────────

export const COMMENT_COLUMNS =
  "id,channel_id,video_id,author_name,body,published_at,category,sentiment,flagged_injection,status";
export const DRAFT_COLUMNS = "id,comment_id,status,body,edited,quoted_credits,charged_credits,error_code,created_at";
export const INTENT_COLUMNS = "id,comment_id,body,edited,approved_by_email,approved_at";
export const POST_COLUMNS = "id,comment_id,intent_id,status,error_code,attempts,created_at,finished_at";

export interface InboxComment {
  id: string;
  channelId: string;
  videoId: string;
  author: string | null;
  body: string;
  publishedAt: string | null;
  category: CommentCategory | null;
  flagged: boolean;
  status: CommentStatus;
}

export interface InboxDraft {
  id: string;
  commentId: string;
  status: DraftStatus;
  body: string | null;
  edited: boolean;
  quotedCredits: number | null;
  errorCode: string | null;
  createdAt: string | null;
}

export interface InboxIntent {
  id: string;
  commentId: string;
  body: string;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface InboxPost {
  id: string;
  commentId: string;
  status: PostStatus;
  errorCode: PostFailure | null;
}

export interface InboxItem {
  comment: InboxComment;
  /** The newest draft that is still a draft in flight, ready, or failed (a discarded or approved one is history). */
  draft: InboxDraft | null;
  intent: InboxIntent | null;
  post: InboxPost | null;
  held: HeldReason | null;
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function rows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v.filter((r) => r && typeof r === "object") as Record<string, unknown>[]) : [];
}

export function parseComments(data: unknown): InboxComment[] {
  const out: InboxComment[] = [];
  for (const r of rows(data)) {
    if (!isUuid(r.id) || typeof r.channel_id !== "string" || typeof r.video_id !== "string") continue;
    const status = r.status === "dismissed" || r.status === "replied" ? r.status : "open";
    const category = (CATEGORIES as readonly string[]).includes(r.category as string) ? (r.category as CommentCategory) : null;
    out.push({
      id: r.id,
      channelId: r.channel_id,
      videoId: r.video_id,
      author: str(r.author_name, INBOX_LIMITS.authorMax),
      body: str(r.body, INBOX_LIMITS.bodyMax) ?? "",
      publishedAt: str(r.published_at, 40),
      category,
      flagged: r.flagged_injection === true,
      status,
    });
  }
  return out;
}

const DRAFT_STATUSES: readonly string[] = ["pending", "drafting", "ready", "approved", "discarded", "failed"];

export function parseDrafts(data: unknown): InboxDraft[] {
  const out: InboxDraft[] = [];
  for (const r of rows(data)) {
    if (!isUuid(r.id) || !isUuid(r.comment_id) || !DRAFT_STATUSES.includes(r.status as string)) continue;
    out.push({
      id: r.id,
      commentId: r.comment_id,
      status: r.status as DraftStatus,
      body: str(r.body, INBOX_LIMITS.replyMax),
      edited: r.edited === true,
      quotedCredits: num(r.quoted_credits),
      errorCode: str(r.error_code, 48),
      createdAt: str(r.created_at, 40),
    });
  }
  return out;
}

export function parseIntents(data: unknown): InboxIntent[] {
  const out: InboxIntent[] = [];
  for (const r of rows(data)) {
    if (!isUuid(r.id) || !isUuid(r.comment_id)) continue;
    out.push({
      id: r.id,
      commentId: r.comment_id,
      body: str(r.body, INBOX_LIMITS.replyMax) ?? "",
      approvedBy: str(r.approved_by_email, 320),
      approvedAt: str(r.approved_at, 40),
    });
  }
  return out;
}

export function parsePosts(data: unknown): InboxPost[] {
  const out: InboxPost[] = [];
  for (const r of rows(data)) {
    if (!isUuid(r.id) || !isUuid(r.comment_id)) continue;
    const status = r.status;
    if (status !== "queued" && status !== "posting" && status !== "posted" && status !== "failed") continue;
    const code = (POST_FAILURES as readonly string[]).includes(r.error_code as string) ? (r.error_code as PostFailure) : null;
    out.push({ id: r.id, commentId: r.comment_id, status, errorCode: status === "failed" ? (code ?? "platform_error") : null });
  }
  return out;
}

/** Why the inbox will not draft for this comment (the database refuses the same three). */
export function heldReason(c: Pick<InboxComment, "category" | "flagged">): HeldReason | null {
  if (c.flagged) return "flagged";
  if (c.category === "spam") return "spam";
  if (c.category === null) return "not_classified";
  return null;
}

const LIVE_DRAFT: readonly DraftStatus[] = ["pending", "drafting", "ready", "failed"];

/** Join the four reads into the cards the screen shows, newest comment first. */
export function buildItems(
  comments: readonly InboxComment[],
  drafts: readonly InboxDraft[],
  intents: readonly InboxIntent[],
  posts: readonly InboxPost[],
): InboxItem[] {
  const byComment = <T extends { commentId: string }>(list: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) m.set(x.commentId, [...(m.get(x.commentId) ?? []), x]);
    return m;
  };
  const d = byComment(drafts);
  const i = byComment(intents);
  const p = byComment(posts);
  const items = comments.map((comment): InboxItem => {
    const mine = (d.get(comment.id) ?? []).filter((x) => LIVE_DRAFT.includes(x.status));
    mine.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    return {
      comment,
      draft: mine[0] ?? null,
      intent: i.get(comment.id)?.[0] ?? null,
      post: p.get(comment.id)?.[0] ?? null,
      held: heldReason(comment),
    };
  });
  return items.sort((a, b) => (b.comment.publishedAt ?? "").localeCompare(a.comment.publishedAt ?? ""));
}

// ── what the card is doing ──────────────────────────────────────────────────

export type CardState =
  | "dismissed"
  | "posted"
  | "posting" // approved: queued or being posted
  | "post_failed"
  | "held" // spam / flagged / not classified: no draft
  | "writing" // a draft is being written
  | "ready" // a draft waits for a person
  | "draft_failed"
  | "open"; // nothing yet: a draft may be asked for

export function cardState(item: InboxItem): CardState {
  const { comment, draft, post, intent } = item;
  if (post?.status === "posted" || comment.status === "replied") return "posted";
  // Set aside: only possible with no reply posted or waiting (the database refuses otherwise).
  if (comment.status === "dismissed") return "dismissed";
  if (post?.status === "failed") return "post_failed";
  if (post || intent) return "posting";
  if (item.held) return "held";
  if (draft?.status === "pending" || draft?.status === "drafting") return "writing";
  if (draft?.status === "ready") return "ready";
  if (draft?.status === "failed") return "draft_failed";
  return "open";
}

/** Anything the worker is still doing: the page refreshes itself while this is true. */
export function isActive(items: readonly InboxItem[]): boolean {
  return items.some((it) => {
    const s = cardState(it);
    return s === "writing" || s === "posting";
  });
}

export type Filter = "all" | "todo" | "drafted" | "replied" | "dismissed";
export const FILTERS: readonly Filter[] = ["all", "todo", "drafted", "replied", "dismissed"];

export function matchesFilter(item: InboxItem, f: Filter): boolean {
  const s = cardState(item);
  switch (f) {
    case "all":
      return true;
    case "todo":
      return s === "open" || s === "draft_failed" || s === "held";
    case "drafted":
      return s === "writing" || s === "ready" || s === "posting" || s === "post_failed";
    case "replied":
      return s === "posted";
    case "dismissed":
      return s === "dismissed";
  }
}

export function isFilter(v: unknown): v is Filter {
  return typeof v === "string" && (FILTERS as readonly string[]).includes(v);
}

// ── the quote the draft route answers ───────────────────────────────────────

export type QuoteStatus = "priced" | "included" | "unpriced" | "unavailable";

export interface DraftQuote {
  status: QuoteStatus;
  /** Credits for the press — only when status is "priced". Never 0 for "unknown". */
  credits: number | null;
  reason: string | null;
  exempt: boolean;
  mayStart: boolean;
  /** The channel's connection allows replying (checked again at approval). */
  replyReady: boolean;
}

export function parseQuote(raw: unknown): DraftQuote {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = typeof r.status === "string" ? r.status : "";
  const status: QuoteStatus = (["priced", "included", "unpriced", "unavailable"] as const).includes(s as QuoteStatus)
    ? (s as QuoteStatus)
    : "unavailable";
  const credits = status === "priced" ? num(r.credits) : null;
  if (status === "priced" && (credits === null || credits <= 0)) {
    return { status: "unavailable", credits: null, reason: "unknown", exempt: false, mayStart: false, replyReady: false };
  }
  return {
    status,
    credits,
    reason: typeof r.reason === "string" ? r.reason.slice(0, 40) : null,
    exempt: r.exempt === true,
    mayStart: r.may_start === true,
    replyReady: r.reply_ready === true,
  };
}

// ── the routes' answers ─────────────────────────────────────────────────────

type DbError = { code?: string; message?: string; details?: string | null; hint?: string | null };

function detailNumber(text: string | null | undefined, key: string): number | null {
  const m = new RegExp(`${key}=([0-9.]+)`).exec(text ?? "");
  return m ? Number(m[1]) : null;
}

const CONFLICTS = [
  "idempotency_conflict", "in_progress", "draft_exists", "already_replied", "not_editable", "not_approvable",
  "comment_closed", "channel_not_ready", "not_retryable",
] as const;

/** A quote / press RPC error -> the route's answer. The code is the contract; the body carries only what the person may see. */
export function mapInboxError(error: DbError): { status: number; body: Record<string, unknown> } {
  const code = error.code ?? "";
  const msg = (error.message ?? "").trim();
  // Another organization's id reads exactly like one that does not exist.
  if (code === "P0002") return { status: 404, body: { error: "not_found" } };
  if (code === "42501") return { status: 403, body: { error: "forbidden" } };
  if (code === "NS402")
    return {
      status: 402,
      body: { error: "insufficient_credits", needed: detailNumber(error.details, "needed"), available: detailNumber(error.details, "available") },
    };
  if (code === "NS429" && msg === "daily_limit") return { status: 429, body: { error: "daily_limit" } };
  if (code === "NS429") return { status: 429, body: { error: "run_limit" } };
  if (code === "NS409" && msg === "price_changed")
    return { status: 409, body: { error: "price_changed", credits: detailNumber(error.details, "credits") } };
  if (code === "NS409" && (CONFLICTS as readonly string[]).includes(msg)) return { status: 409, body: { error: msg } };
  if (code === "NS400" && msg === "unpriced") return { status: 409, body: { error: "unpriced" } };
  if (code === "NS400" && msg === "not_draftable") {
    const reason = (error.details ?? "").trim();
    return { status: 409, body: { error: "not_draftable", reason: ["spam", "flagged", "not_classified", "dismissed"].includes(reason) ? reason : "unknown" } };
  }
  if (code === "NS400" && (msg === "invalid_body" || msg === "invalid_idempotency_key")) return { status: 400, body: { error: msg } };
  if (code === "22023" && msg === "price_required")
    return { status: 409, body: { error: "price_required", credits: detailNumber(error.details, "credits") } };
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205" || /does not exist|could not find/i.test(msg))
    return { status: 503, body: { error: "inbox_unavailable" } };
  return { status: 502, body: { error: "inbox_failed" } };
}

// ── what the screen says ────────────────────────────────────────────────────

type T = Dictionary["inbox"];

export function heldText(reason: HeldReason, t: T): string {
  return t.held[reason];
}

/** The sentence for a route's error body. */
export function inboxErrorText(body: Record<string, unknown> | null, t: T): string {
  const error = typeof body?.error === "string" ? body.error : "";
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "?");
  switch (error) {
    case "forbidden":
      return t.errors.forbidden;
    case "not_found":
      return t.errors.notFound;
    case "insufficient_credits":
      return fmt(t.errors.insufficient, { needed: n(body?.needed), available: n(body?.available) });
    case "run_limit":
      return t.errors.runLimit;
    case "daily_limit":
      return t.errors.dailyLimit;
    case "price_changed":
      return fmt(t.errors.priceChanged, { credits: n(body?.credits) });
    case "price_required":
      return t.errors.priceRequired;
    case "unpriced":
      return t.unpriced;
    case "not_draftable":
      return typeof body?.reason === "string" && body.reason in t.held ? t.held[body.reason as HeldReason] : t.errors.notDraftable;
    case "channel_not_ready":
      return t.errors.channelNotReady;
    case "invalid_body":
      return t.errors.invalidBody;
    case "idempotency_conflict":
    case "in_progress":
    case "draft_exists":
    case "already_replied":
    case "not_editable":
    case "not_approvable":
    case "comment_closed":
    case "not_retryable":
      return t.errors.conflict;
    case "inbox_unavailable":
      return t.errors.notInstalled;
    default:
      return t.errors.failed;
  }
}

/** Our sentence for a stored failure reason (the word, never a response body). */
export function failureText(code: string | null, t: T): string {
  return (code && (t.failures as Record<string, string>)[code]) || t.failures.platform_error;
}
