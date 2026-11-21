/**
 * "Publish when approved" (migration 0116): what the review panel may say about a video's request.
 *
 * An administrator switches the feature on per channel (default OFF). Approving one exact cut of an uploaded, private video
 * then queues ONE request that a worker carries out: it asks the database again, asks YouTube to make the video public, and
 * READS THE PRIVACY BACK. This file turns that row into a view, and the one rule it exists for is: **"published" is said only
 * for a request the database ended as `applied` with `after_privacy = 'public'`**, which the worker writes only from that
 * read-back. A queued request is "queued", a refused one says why in words, an expired one says it ended. Nothing here claims a
 * publish from the switch, from the button, or from a request that has not been read back.
 *
 * Pure and client-safe, so the panel and the page agree and it is unit-tested directly.
 */

/** The words a request may end with: the same list as `visibility_reason_words()` (migration 0116) and `modules/visibility_publish.py`. */
export const VISIBILITY_REASONS = [
  "video_not_found", "not_uploaded", "gate_blocked", "gate_unknown", "rejected", "already_public", "no_preview",
  "cut_unknown", "cut_changed", "not_approved", "approval_expired",
  "not_enabled", "approval_superseded", "channel_not_connected", "two_person_required",
  "scope_missing", "token_expired", "quota_exceeded", "rate_limited", "video_not_found_on_youtube", "channel_mismatch",
  "still_processing", "rejected_by_youtube", "privacy_changed", "platform_refused", "platform_kept_private",
  "platform_error", "readback_failed", "status_unreadable",
  "interrupted", "worker_error",
] as const;
export type VisibilityReason = (typeof VISIBILITY_REASONS)[number];

export function knownVisibilityReason(raw: unknown): VisibilityReason | null {
  return typeof raw === "string" && (VISIBILITY_REASONS as readonly string[]).includes(raw) ? (raw as VisibilityReason) : null;
}

/** What `retry_video_visibility` answers with besides success (`{ ok: false, error }`), plus the two it raises. */
export const RETRY_ERRORS = [
  "rate_limited", "not_retryable", "approval_expired", "approval_superseded", "not_enabled", "retry_limit", "forbidden", "not_found",
] as const;
export type RetryError = (typeof RETRY_ERRORS)[number];

export function knownRetryError(raw: unknown): RetryError | null {
  return typeof raw === "string" && (RETRY_ERRORS as readonly string[]).includes(raw) ? (raw as RetryError) : null;
}

/** The columns a member may read (the worker's own columns are not granted to them). */
export const VISIBILITY_COLUMNS =
  "id,status,reason,attempts,lifetime_attempts,approved_cut_sha256,decided_at,expires_at,next_attempt_at,before_privacy,after_privacy,finished_at,created_at";

/** The database stops carrying a request out after this many claims over its lifetime (migration 0116). */
export const MAX_LIFETIME_ATTEMPTS = 6;

export const VISIBILITY_STATUSES = ["queued", "applied", "refused", "failed", "expired"] as const;
export type VisibilityStatus = (typeof VISIBILITY_STATUSES)[number];

export interface VisibilityRequestRow {
  id: number | string;
  status: VisibilityStatus;
  reason: VisibilityReason | null;
  attempts: number;
  /** Every claim ever made of this request: "try again" is offered while it is under {@link MAX_LIFETIME_ATTEMPTS}. */
  lifetime_attempts: number;
  approved_cut_sha256: string;
  decided_at: string;
  expires_at: string;
  next_attempt_at: string | null;
  before_privacy: string | null;
  after_privacy: string | null;
  finished_at: string | null;
  created_at: string;
}

/** A row from the database, parsed defensively: anything that is not the closed shape reads as no request. */
export function parseVisibilityRow(raw: unknown): VisibilityRequestRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = r.status;
  if (typeof status !== "string" || !(VISIBILITY_STATUSES as readonly string[]).includes(status)) return null;
  if (typeof r.id !== "number" && typeof r.id !== "string") return null;
  if (typeof r.decided_at !== "string" || typeof r.expires_at !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    id: r.id,
    status: status as VisibilityStatus,
    reason: knownVisibilityReason(r.reason),
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    lifetime_attempts: typeof r.lifetime_attempts === "number" ? r.lifetime_attempts : 0,
    approved_cut_sha256: typeof r.approved_cut_sha256 === "string" ? r.approved_cut_sha256 : "",
    decided_at: r.decided_at,
    expires_at: r.expires_at,
    next_attempt_at: str(r.next_attempt_at),
    before_privacy: str(r.before_privacy),
    after_privacy: str(r.after_privacy),
    finished_at: str(r.finished_at),
    created_at: str(r.created_at) ?? r.decided_at,
  };
}

export type VisibilityView =
  /** No request for the approval on screen (the switch was off when it was given, or nothing has been queued). */
  | { kind: "none" }
  /** Waiting for the worker (or for its next try). `lastReason` is the word of a try that did not finish. */
  | { kind: "queued"; since: string; attempts: number; lastReason: VisibilityReason | null }
  /** YouTube reported the video public on the worker's read-back. The only "published" there is. */
  | { kind: "published"; at: string | null }
  /** A rule said no for this approval. Nothing was sent, or YouTube kept the video as it was. */
  | { kind: "refused"; reason: VisibilityReason }
  /** The environment could not do it; a person may try again while the approval holds. */
  | { kind: "failed"; reason: VisibilityReason; retryable: boolean }
  /** The approval ended before the video was made public. */
  | { kind: "expired" };

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The approval fields of the video row this reads (migration 0112). */
export interface ApprovalOfVideo {
  approved_cut_sha256?: string | null;
  decided_at?: string | null;
  review_state?: string | null;
}

/**
 * What to show for a video's request. `request` is the newest request of this video; it counts for the approval on screen only
 * when it was queued FOR that approval (same decision time and same cut), except that a recorded read-back of `public` is shown as
 * what it is (the video is public, and was reported so at that time).
 */
export function visibilityView(request: VisibilityRequestRow | null, video: ApprovalOfVideo, nowMs: number): VisibilityView {
  if (!request) return { kind: "none" };
  // The truth rule: public is said only for an applied request whose read-back said public.
  if (request.status === "applied") {
    return request.after_privacy === "public" ? { kind: "published", at: request.finished_at } : { kind: "none" };
  }
  const forThisApproval =
    ms(request.decided_at) !== null &&
    ms(request.decided_at) === ms(video.decided_at) &&
    !!request.approved_cut_sha256 &&
    request.approved_cut_sha256 === (video.approved_cut_sha256 ?? "");
  if (!forThisApproval) return { kind: "none" };
  const ended = (ms(request.expires_at) ?? 0) <= nowMs;
  switch (request.status) {
    case "queued":
      return ended
        ? { kind: "expired" }
        : { kind: "queued", since: request.created_at, attempts: request.attempts, lastReason: request.reason };
    case "expired":
      return { kind: "expired" };
    case "refused":
      return request.reason === "approval_expired" ? { kind: "expired" } : { kind: "refused", reason: request.reason ?? "worker_error" };
    case "failed":
      return ended
        ? { kind: "expired" }
        : { kind: "failed", reason: request.reason ?? "worker_error", retryable: request.lifetime_attempts < MAX_LIFETIME_ATTEMPTS };
    default:
      return { kind: "none" };
  }
}
