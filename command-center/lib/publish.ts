/**
 * "Making this for:" and "Publish to platforms" (migration 0029) — the pure half.
 *
 * Client-safe. Nothing here publishes: the Create page's hint is recorded on
 * the render job, and "Send" inserts publish_requests rows that the queue
 * worker carries out after checking the publish gate and approvals again.
 */

import type { SocialPlatform } from "@/lib/social-accounts";

export type HintPlatform = "youtube" | "instagram" | "tiktok";

const HINT_RE = /^(youtube|instagram|tiktok):[A-Za-z0-9._-]{1,128}$/;

/** "tiktok:<uuid>" — the render_jobs params.publish_hint value. */
export function formatPublishHint(platform: HintPlatform, id: string): string {
  return `${platform}:${id}`;
}

/** A valid hint, or null (migration 0029 and modules/run_request.py check the same). */
export function parsePublishHint(raw: unknown): { platform: HintPlatform; id: string } | null {
  if (typeof raw !== "string" || !HINT_RE.test(raw)) return null;
  const i = raw.indexOf(":");
  return { platform: raw.slice(0, i) as HintPlatform, id: raw.slice(i + 1) };
}

/** Only a hint naming one of the caller's own accounts is kept. */
export function acceptedHint(
  raw: unknown,
  accounts: readonly { platform: HintPlatform; id: string }[],
): string | null {
  const hint = parsePublishHint(raw);
  if (!hint) return null;
  return accounts.some((a) => a.platform === hint.platform && a.id === hint.id)
    ? formatPublishHint(hint.platform, hint.id)
    : null;
}

export type PublishStatus = "queued" | "uploading" | "processing" | "published" | "failed" | "refused";

/** One publish_requests row as the panel reads it. */
export interface PublishRequestRow {
  id: number;
  video_id: string;
  account_id: string;
  platform: SocialPlatform;
  status: PublishStatus;
  reason: string | null;
  error: string | null;
  result_id: string | null;
  result_url: string | null;
  privacy: string | null;
  created_at: string | null;
  finished_at: string | null;
}

export const PUBLISH_REQUEST_COLUMNS =
  "id, video_id, account_id, platform, status, reason, error, result_id, result_url, privacy, created_at, finished_at";

const STATUSES: PublishStatus[] = ["queued", "uploading", "processing", "published", "failed", "refused"];

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function coercePublishRequests(data: unknown): PublishRequestRow[] {
  if (!Array.isArray(data)) return [];
  const out: PublishRequestRow[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "number" || !str(r.video_id) || !str(r.account_id)) continue;
    if (r.platform !== "instagram" && r.platform !== "tiktok") continue;
    const url = str(r.result_url);
    out.push({
      id: r.id,
      video_id: r.video_id as string,
      account_id: r.account_id as string,
      platform: r.platform,
      status: STATUSES.includes(r.status as PublishStatus) ? (r.status as PublishStatus) : "failed",
      reason: str(r.reason),
      error: str(r.error),
      result_id: str(r.result_id),
      result_url: url && url.startsWith("https://") ? url : null,
      privacy: str(r.privacy),
      created_at: str(r.created_at),
      finished_at: str(r.finished_at),
    });
  }
  return out;
}

/** The newest request per account (rows arrive newest first). */
export function latestByAccount(rows: readonly PublishRequestRow[]): Map<string, PublishRequestRow> {
  const out = new Map<string, PublishRequestRow>();
  for (const r of rows) if (!out.has(r.account_id)) out.set(r.account_id, r);
  return out;
}

export function isLive(status: PublishStatus): boolean {
  return status === "queued" || status === "uploading" || status === "processing";
}

/**
 * What the panel can say BEFORE Send, from the row the page already has. The
 * database decides (publish_request_refusal) and the worker checks again; this
 * only saves a click that would come back refused.
 */
export function publishBlocker(video: {
  published_at: string | null;
  publish_state?: string | null;
  review_state: string;
}): "not_uploaded" | "not_approved" | "rejected" | null {
  if (!video.published_at || (video.publish_state && video.publish_state !== "uploaded")) return "not_uploaded";
  if (video.review_state === "rejected") return "rejected";
  if (video.review_state !== "approved") return "not_approved";
  return null;
}

/** Reason words the database and worker write; anything else shows as "failed". */
export const PUBLISH_REASONS = [
  "video_not_found",
  "not_uploaded",
  "gate_blocked",
  "not_approved",
  "rejected",
  "awaiting_two_person",
  "account_not_connected",
  "master_not_available",
  "unknown_duration",
  "too_long",
  "too_short",
  "too_large",
  "bad_aspect",
  "privacy_unavailable",
  "token_expired",
  "rate_limited",
  "staging_failed",
  "upload_failed",
  "processing_failed",
  "platform_error",
  "timeout",
  "interrupted",
  "worker_error",
  "unknown_platform",
] as const;
export type PublishReason = (typeof PUBLISH_REASONS)[number];

export function knownReason(raw: string | null): PublishReason | null {
  return raw && (PUBLISH_REASONS as readonly string[]).includes(raw) ? (raw as PublishReason) : null;
}

/** A download file name from the video's title: letters, digits, dashes. */
export function downloadName(title: string | null, videoId: string): string {
  const base = (title ?? "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return `${base || videoId}.mp4`;
}
