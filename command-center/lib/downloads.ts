/**
 * Paid 720p / 1080p downloads (migration 0030) — the pure half.
 *
 * Client-safe and unit-tested (tests/downloads.test.ts). The database decides
 * and charges (request_download: editor+, priced from the worker-probed master
 * length and credit_prices, debited through the ledger, idempotent per
 * organization + video + quality); this file only mirrors the price so the
 * confirm dialog can show the exact number, and shapes the rows the panel
 * reads. Keep `downloadCharge` in step with request_download's formula:
 *
 *   charge = max(ceil(minutes × credits_per_unit × (1 + margin)), ceil(download_minimum))
 */

import type { PriceMap } from "@/lib/credits";

export type HdQuality = "720p" | "1080p";
export type DownloadQuality = "480p" | HdQuality;
export const HD_QUALITIES: readonly HdQuality[] = ["720p", "1080p"];

/** The frame's short side a quality needs (landscape height, portrait width). */
export const QUALITY_SIDE: Record<HdQuality, number> = { "720p": 720, "1080p": 1080 };

export const UNIT_DOWNLOAD_MINIMUM = "download_minimum";
export function downloadUnit(q: HdQuality): string {
  return `download_${q}_minute`;
}

/** A paid download makes the same quality of the same video free for this long. */
export const REDOWNLOAD_DAYS = 7;

export type DownloadStatus = "queued" | "processing" | "ready" | "failed" | "expired";
const STATUSES: DownloadStatus[] = ["queued", "processing", "ready", "failed", "expired"];

export interface DownloadRequestRow {
  id: number;
  video_id: string;
  quality: HdQuality;
  status: DownloadStatus;
  charged: number;
  free_reason: "exempt" | "redownload" | null;
  paid_until: string | null;
  reason: string | null;
  error: string | null;
  bytes: number | null;
  expires_at: string | null;
  created_at: string | null;
  refunded: boolean;
}

export const DOWNLOAD_REQUEST_COLUMNS =
  "id, video_id, quality, status, charged, free_reason, paid_until, reason, error, bytes, expires_at, created_at, refund_txn";

export interface DownloadMaster {
  width: number;
  height: number;
  durationSeconds: number;
  bytes: number;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function coerceMaster(row: unknown): DownloadMaster | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const width = num(r.width);
  const height = num(r.height);
  const durationSeconds = num(r.duration_seconds);
  const bytes = num(r.bytes);
  if (!width || !height || !durationSeconds || durationSeconds <= 0) return null;
  return { width, height, durationSeconds, bytes: bytes ?? 0 };
}

export function coerceDownloadRequests(data: unknown): DownloadRequestRow[] {
  if (!Array.isArray(data)) return [];
  const out: DownloadRequestRow[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = num(r.id);
    if (id === null || !Number.isInteger(id) || id <= 0 || !str(r.video_id)) continue;
    if (r.quality !== "720p" && r.quality !== "1080p") continue;
    out.push({
      id,
      video_id: r.video_id as string,
      quality: r.quality,
      status: STATUSES.includes(r.status as DownloadStatus) ? (r.status as DownloadStatus) : "failed",
      charged: num(r.charged) ?? 0,
      free_reason: r.free_reason === "exempt" || r.free_reason === "redownload" ? r.free_reason : null,
      paid_until: str(r.paid_until),
      reason: str(r.reason),
      error: str(r.error),
      bytes: num(r.bytes),
      expires_at: str(r.expires_at),
      created_at: str(r.created_at),
      refunded: r.refund_txn !== null && r.refund_txn !== undefined,
    });
  }
  return out;
}

/** Which qualities the master can give (never more than it has). */
export function availableQualities(master: DownloadMaster | null): HdQuality[] {
  if (!master) return [];
  const side = Math.min(master.width, master.height);
  return HD_QUALITIES.filter((q) => side >= QUALITY_SIDE[q]);
}

/** Whole credits for one download, or null when the quality is unpriced (never free by omission). */
export function downloadCharge(durationSeconds: number, quality: HdQuality, prices: PriceMap): number | null {
  const p = prices[downloadUnit(quality)];
  if (!p || !(durationSeconds > 0)) return null;
  const raw = (durationSeconds / 60) * p.creditsPerUnit * (1 + p.margin);
  // Float noise (2.0000000001) must not add a whole credit the database would not charge.
  const perMinute = Math.ceil(Math.round(raw * 1e6) / 1e6);
  const floor = prices[UNIT_DOWNLOAD_MINIMUM];
  const min = floor ? Math.ceil(Math.round(floor.creditsPerUnit * 1e6) / 1e6) : 0;
  return Math.max(perMinute, min);
}

/** The newest row per quality (rows arrive newest first). */
export function latestByQuality(rows: readonly DownloadRequestRow[]): Partial<Record<HdQuality, DownloadRequestRow>> {
  const out: Partial<Record<HdQuality, DownloadRequestRow>> = {};
  for (const r of rows) if (!out[r.quality]) out[r.quality] = r;
  return out;
}

/** A still-downloadable file for this quality, if any. */
export function readyRow(r: DownloadRequestRow | undefined, now: number = Date.now()): boolean {
  return Boolean(r && r.status === "ready" && r.expires_at && Date.parse(r.expires_at) > now);
}

export function isPreparing(r: DownloadRequestRow | undefined): boolean {
  return Boolean(r && (r.status === "queued" || r.status === "processing"));
}

/** A paid download of this quality inside the re-download window (the database's rule). */
export function freeRedownload(rows: readonly DownloadRequestRow[], quality: HdQuality, now: number = Date.now()): boolean {
  return rows.some(
    (r) => r.quality === quality && r.status !== "failed" && r.paid_until !== null && Date.parse(r.paid_until) > now,
  );
}

/** What the next click on a quality would cost: 0 when free, null when unpriced. */
export function nextCharge(opts: {
  quality: HdQuality;
  master: DownloadMaster | null;
  prices: PriceMap;
  rows: readonly DownloadRequestRow[];
  exempt: boolean;
  now?: number;
}): number | null {
  if (!opts.master) return null;
  if (opts.exempt || freeRedownload(opts.rows, opts.quality, opts.now)) return 0;
  return downloadCharge(opts.master.durationSeconds, opts.quality, opts.prices);
}

// ── the server route's pure checks ─────────────────────────────────────────

/** A download request id from the URL: a positive integer, nothing else. */
export function parseDownloadId(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,17}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The file for a request: `<dir>/<id>.mp4`, built from the numeric id only —
 * never from a path the caller or the database supplied. Null when the
 * directory is not an absolute, plain path or the id is not a positive integer.
 */
export function downloadFilePath(dir: string | null | undefined, id: unknown): string | null {
  if (!dir || !dir.startsWith("/") || dir.includes("\0") || /(^|\/)\.\.(\/|$)/.test(dir)) return null;
  const n = typeof id === "number" ? (Number.isSafeInteger(id) && id > 0 ? id : null) : parseDownloadId(id);
  if (n === null) return null;
  return `${dir.replace(/\/+$/, "") || ""}/${n}.mp4`;
}

/** Content-Disposition for a download: an ASCII fallback plus the UTF-8 name (RFC 6266 / 5987). */
export function contentDisposition(title: string | null, videoId: string, quality: HdQuality): string {
  const base = (title ?? "").replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const safeId = videoId.replace(/[^A-Za-z0-9._-]/g, "") || "video";
  const name = `${base || safeId} (${quality}).mp4`;
  const asciiBase = base
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\%;]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const ascii = `${asciiBase || safeId} (${quality}).mp4`;
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export type DownloadError =
  | "insufficient_credits"
  | "master_not_available"
  | "unpriced"
  | "price_changed"
  | "forbidden"
  | "not_found"
  | "not_available"
  | "failed";

/** request_download's SQLSTATE -> a word and an HTTP status. */
export function mapDownloadError(error: { code?: string; message?: string } | null | undefined): {
  error: DownloadError;
  status: number;
} {
  switch (error?.code) {
    case "NS402":
      return { error: "insufficient_credits", status: 402 };
    case "NS404":
      return { error: "master_not_available", status: 409 };
    case "NS400":
      return { error: "unpriced", status: 409 };
    case "NS409":
      return { error: "price_changed", status: 409 };
    case "42501":
      return { error: "forbidden", status: 403 };
    case "P0002":
      return { error: "not_found", status: 404 };
    case "PGRST202":
    case "42883":
    case "42P01":
      return { error: "not_available", status: 503 };
  }
  if (/could not find the function|does not exist/i.test(error?.message ?? "")) return { error: "not_available", status: 503 };
  return { error: "failed", status: 502 };
}

/** Reason words the worker and database write; anything else reads as a plain failure. */
export const DOWNLOAD_REASONS = [
  "video_not_found",
  "master_not_available",
  "master_too_small",
  "probe_failed",
  "ffmpeg_missing",
  "transcode_failed",
  "timeout",
  "interrupted",
  "not_picked_up",
  "worker_error",
  "unknown_quality",
] as const;
export type DownloadReason = (typeof DOWNLOAD_REASONS)[number];

export function knownDownloadReason(raw: string | null): DownloadReason | null {
  return raw && (DOWNLOAD_REASONS as readonly string[]).includes(raw) ? (raw as DownloadReason) : null;
}

/** "212 MB" — for the ready line. */
export function formatBytes(n: number | null): string {
  if (!n || n <= 0) return "";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
}
