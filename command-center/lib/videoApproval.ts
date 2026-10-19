import { isHeldVideo } from "@/lib/heldVideos";

/**
 * "Approve" on the review panel (migration 0112, approve_video_publish).
 *
 * Approving RECORDS a decision: which person looked at which exact cut (its sha256), until when (24 hours), with the rights
 * and AI-label acknowledgement in the audit trail. It does not make anything public. Every video is uploaded as private and
 * stays private until someone makes it public on YouTube, unless the channel's auto-publish switch is on (Phase 1b, a worker that does it for an approved video, is not
 * built). The database decides everything below; this file only saves a press that would come back refused, and says why.
 *
 * Pure and client-safe, so it is unit-tested directly and the panel and the page agree.
 */

/** How long an approval holds. The database stores the expiry it computed; this is the sentence's number only. */
export const APPROVAL_TTL_HOURS = 24;

/** The reason words approve_video_publish answers with (`{ ok: false, error }`), plus the two it raises. */
export const APPROVE_REASONS = [
  "rate_limited",
  "bad_hash",
  "ack_required",
  "already_approved",
  "video_not_found",
  "not_uploaded",
  "gate_blocked",
  "gate_unknown",
  "rejected",
  "already_public",
  "no_preview",
  "cut_unknown",
  "cut_changed",
  "forbidden",
  "not_found",
] as const;
export type ApproveReason = (typeof APPROVE_REASONS)[number];

export function knownApproveReason(raw: unknown): ApproveReason | null {
  return typeof raw === "string" && (APPROVE_REASONS as readonly string[]).includes(raw) ? (raw as ApproveReason) : null;
}

/** The columns of `videos` this reads (migration 0112); all optional so an older row or a fixture simply omits them. */
export interface ApprovalFields {
  review_state: string;
  published_at?: string | null;
  privacy?: string | null;
  publish_state?: string | null;
  preview_path?: string | null;
  cut_sha256?: string | null;
  gate_verdict?: unknown;
  approved_cut_sha256?: string | null;
  decided_by_email?: string | null;
  decided_at?: string | null;
  approval_expires_at?: string | null;
}

export type ApprovalBlocker =
  | "held"
  | "rejected"
  | "already_public"
  | "gate_blocked"
  | "gate_unknown"
  | "no_preview"
  | "cut_unknown"
  | "not_admin"
  | "not_member";

/** Who may press: the word video_approve_access answers with (see accessFromWord). */
export type ApproveAccess = "ok" | "not_admin" | "not_member";

export type ApprovalView =
  /** The channel publishes on its own (or the video was approved with nobody behind it): nothing to approve. */
  | { kind: "auto" }
  /** A person approved THIS cut and the approval has not run out. */
  | { kind: "approved"; by: string | null; at: string | null; expiresAt: string | null }
  /** A person approved this cut, and it ran out. Approving again renews it. */
  | { kind: "expired"; by: string | null; at: string | null; expiresAt: string | null }
  /** Nobody has approved this cut. */
  | { kind: "open" };

export interface ApprovalState {
  view: ApprovalView;
  /** Why the Approve key is disabled, or null when it may be pressed. */
  blocker: ApprovalBlocker | null;
}

/** The gate's verdict as the database stored it for the cut (videos.gate_verdict), parsed defensively; null = unknown. */
export function storedGate(
  v: { gate_verdict?: unknown } | null | undefined,
): { allowed: boolean; blocks: string[]; warnings: string[] } | null {
  const g = v?.gate_verdict as { allowed?: unknown; blocks?: unknown; warnings?: unknown } | null | undefined;
  if (!g || typeof g !== "object" || typeof g.allowed !== "boolean") return null;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  return { allowed: g.allowed, blocks: strings(g.blocks), warnings: strings(g.warnings) };
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** The first 10 characters of a cut's hash: enough to tell two cuts apart on a sheet, not a thing to type. */
export function shortHash(hash: string | null | undefined): string {
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash.slice(0, 10) : "";
}

/**
 * What the panel offers for this video right now. The order is the order the database refuses in
 * (video_approve_refusal), then the person's own standing.
 */
export function approvalState(
  video: ApprovalFields,
  opts: { autoPublish: boolean; access: ApproveAccess; nowMs: number },
): ApprovalState {
  const approvedBy = video.decided_by_email ?? null;
  const cut = video.cut_sha256 ?? null;
  const approvedCut = video.approved_cut_sha256 ?? null;
  const expiresMs = ms(video.approval_expires_at);

  let view: ApprovalView;
  if (opts.autoPublish || (video.review_state === "approved" && !approvedCut)) {
    view = { kind: "auto" };
  } else if (video.review_state === "approved" && approvedCut && cut && approvedCut === cut) {
    const live = expiresMs !== null && expiresMs > opts.nowMs;
    view = {
      kind: live ? "approved" : "expired",
      by: approvedBy,
      at: video.decided_at ?? null,
      expiresAt: video.approval_expires_at ?? null,
    };
  } else {
    // pending, or approved for a cut that is no longer this one: the approval does not count
    view = { kind: "open" };
  }

  let blocker: ApprovalBlocker | null = null;
  const gate = storedGate(video);
  if (isHeldVideo(video)) blocker = "held";
  else if (video.review_state === "rejected") blocker = "rejected";
  else if (video.privacy === "public") blocker = "already_public";
  else if (gate && (!gate.allowed || gate.blocks.length > 0)) blocker = "gate_blocked";
  else if (!gate) blocker = "gate_unknown";
  else if (!video.preview_path) blocker = "no_preview";
  else if (!cut) blocker = "cut_unknown";
  else if (opts.access === "not_member") blocker = "not_member";
  else if (opts.access === "not_admin") blocker = "not_admin";
  return { view, blocker };
}

/** Is the Approve key live? */
export function canPressApprove(s: ApprovalState): boolean {
  return s.blocker === null && (s.view.kind === "open" || s.view.kind === "expired");
}

/**
 * The database's word for "may this person approve this video" (video_approve_access, migration 0112) as the panel uses it.
 * ok: an administrator of the channel's organization (a real member of it, for a customer's); not_admin: a member who is
 * not; not_member: a platform owner/admin on a customer's channel; anything else (not found, an error, no such function
 * yet) reads as not_admin, so a key is never offered on a guess. Presentation only: approve_video_publish asks again.
 */
export function accessFromWord(word: unknown): ApproveAccess {
  return word === "ok" || word === "not_member" ? word : "not_admin";
}

/** The YouTube Studio page of a video, where a person makes it public today; null when the id is not a YouTube id. */
export function studioUrl(videoId: string | null | undefined): string | null {
  return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? `https://studio.youtube.com/video/${videoId}/edit` : null;
}
