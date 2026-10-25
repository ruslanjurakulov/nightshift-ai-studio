/**
 * The results dashboard's arithmetic: pure functions over rows that were already read under the member's own session.
 * Nothing here reads a database, calls a platform or knows who is asking, so every rule below is unit-tested directly
 * (tests/results-dashboard-aggregate.test.ts).
 *
 * What a number in this file means, because the whole page rests on it:
 *
 * - A `metrics_snapshots` row is YouTube's figure for a TWO-DAY window ("yesterday through today") that the daily poll
 *   (modules/intelligence_poller.py, poll_own_channel_metrics) read for a recently published video. It is not a lifetime
 *   total, and consecutive daily readings overlap by one day, so readings of one video can NOT be added together.
 * - So the dashboard never adds readings of the same video. Per video it takes the LATEST reading and says when it was
 *   taken and how many days after publishing; a KPI adds those latest readings across videos and says how many videos
 *   it could be measured for.
 * - A figure that is null stays null (CLAUDE.md #5): a video without a reading is "not measured", never 0 views; an
 *   average is taken over the videos that have both of its parts; a sum over zero known values is null, not 0.
 * - What does NOT count as a reading (the poller stores `int(metrics.get("views", 0) or 0)`, so when YouTube has no row yet it
 *   stores a full row of zeros, and a zero here is then "no data came back", not "measured zero"):
 *     1. a snapshot whose views, likes, comments, watch minutes and average duration are ALL exactly 0 is skipped as empty;
 *        the video falls back to its newest non-empty reading, or is "not measured" (flagged `noData`) when it has none;
 *     2. a duration of exactly 0 next to views > 0 is an unknown duration (null), so it cannot pull the weighted average down;
 *     3. a snapshot dated before the video's publish day cannot be a reading of that video and is skipped.
 *   The proper fix (the poller storing NULL for empty metrics) is a worker/database change and is not part of this page.
 * - Subscribers gained / lost exist in YouTube's response but are not stored by the poll, so there is no source to show.
 *   The dashboard says "not collected", it does not derive a delta from anything else.
 */

import { parseStoredTime } from "@/lib/format";

export const RANGE_DAYS = [7, 28, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];
export const DEFAULT_RANGE: RangeDays = 28;

/** A dashboard whose newest reading is older than this says so. The poll runs once a day; three days is "missed two". */
export const STALE_AFTER_DAYS = 3;

/** How many rows each list returns at most, so a huge account cannot make a page of unbounded size. */
export const MAX_VIDEOS = 200;
export const MAX_HISTORY = 100;
/** Video ids per metrics_snapshots query, and the row count at which a response is assumed cut (PostgREST's default max is 1000). */
export const SNAPSHOT_CHUNK = 25;
export const SNAPSHOT_CAP = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseRange(raw: unknown): RangeDays | null {
  const n = typeof raw === "string" && /^\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : typeof raw === "number" ? raw : NaN;
  return (RANGE_DAYS as readonly number[]).includes(n) ? (n as RangeDays) : null;
}

// --- coercion: rows arrive as `unknown` from the database; anything off-shape becomes null, never a guess ---------------

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** A finite, non-negative number, or null. A negative or non-finite count is a bad row, not a measurement. */
export function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export function timeMs(v: unknown): number | null {
  const d = parseStoredTime(typeof v === "string" ? v : null);
  return d ? d.getTime() : null;
}

export interface VideoInput {
  videoId: string;
  channelId: string;
  title: string | null;
  publishedAt: string | null;
  privacy: string | null;
  format: "long" | "short" | null;
}

export interface SnapshotInput {
  videoId: string;
  snapshotDate: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  watchMinutes: number | null;
  avgViewSeconds: number | null;
  impressions: number | null;
}

export function coerceVideos(data: unknown): VideoInput[] {
  if (!Array.isArray(data)) return [];
  const out: VideoInput[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const videoId = str(r.video_id);
    const channelId = str(r.channel_id);
    if (!videoId || !channelId) continue;
    out.push({
      videoId,
      channelId,
      title: str(r.title) ?? str(r.topic),
      publishedAt: str(r.published_at),
      privacy: str(r.privacy),
      format: r.video_format === "short" ? "short" : r.video_format === "long" ? "long" : null,
    });
  }
  return out;
}

export function coerceSnapshots(data: unknown): SnapshotInput[] {
  if (!Array.isArray(data)) return [];
  const out: SnapshotInput[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const videoId = str(r.video_id);
    const snapshotDate = str(r.snapshot_date);
    if (!videoId || !snapshotDate || timeMs(snapshotDate) === null) continue;
    out.push({
      videoId,
      snapshotDate,
      views: count(r.views),
      likes: count(r.likes),
      comments: count(r.comment_count),
      watchMinutes: count(r.watch_time_minutes),
      avgViewSeconds: count(r.average_view_duration_seconds),
      impressions: count(r.impressions),
    });
  }
  return out;
}

// --- per-video results ---------------------------------------------------------------------------------------------------

export interface Reading {
  /** The day the poll took it (YYYY-MM-DD). */
  date: string;
  /** UTC calendar days between publishing and the reading (0 = the day it was published). Never negative: an earlier-dated snapshot is not a reading. */
  daysAfterPublish: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  watchMinutes: number | null;
  avgViewSeconds: number | null;
  impressions: number | null;
}

export interface VideoResult {
  videoId: string;
  channelId: string;
  title: string | null;
  publishedAt: string;
  privacy: string | null;
  format: "long" | "short" | null;
  /** The newest usable reading, or null when there is none: "not measured", never zero. */
  reading: Reading | null;
  /** True when snapshots exist but every one of them was empty (all zeros: nothing came back), so there is no reading. */
  noData: boolean;
}

/** A snapshot with every figure exactly 0: the poller's row for "YouTube returned nothing yet", not a measurement of zero. */
export function isEmptyReading(s: SnapshotInput): boolean {
  return s.views === 0 && s.likes === 0 && s.comments === 0 && s.watchMinutes === 0 && s.avgViewSeconds === 0;
}

/** The first moment of the window, in ms: now minus `days` whole days. */
export function windowStart(nowMs: number, days: RangeDays): number {
  return nowMs - days * DAY_MS;
}

/**
 * The videos published inside the window, each with its newest usable reading.
 *
 * Only a video that has a publish time is a published video (a held run has none, lib/heldVideos.ts). A publish time in
 * the future is not "published yet" and is left out. A snapshot is skipped when it is empty (all zeros), or dated before the
 * video's publish day (see the header). Newest reading wins by date; for equal dates the later row wins, because the poll
 * overwrites a day's row when it re-reads it.
 */
export function buildVideoResults(
  videos: readonly VideoInput[],
  snapshots: readonly SnapshotInput[],
  nowMs: number,
  days: RangeDays,
): VideoResult[] {
  const start = windowStart(nowMs, days);
  const byVideo = new Map<string, { snap: SnapshotInput; ms: number }[]>();
  for (const snap of snapshots) {
    const ms = timeMs(snap.snapshotDate);
    if (ms === null) continue;
    const list = byVideo.get(snap.videoId);
    if (list) list.push({ snap, ms });
    else byVideo.set(snap.videoId, [{ snap, ms }]);
  }
  const out: VideoResult[] = [];
  for (const v of videos) {
    const pub = timeMs(v.publishedAt);
    if (pub === null || pub < start || pub > nowMs || !v.publishedAt) continue;
    // Calendar days (UTC), the way a reading is dated: a reading dated the day of the upload is day 0, whatever the hour.
    const pubDay = Math.floor(pub / DAY_MS);
    let best: { snap: SnapshotInput; ms: number } | null = null;
    let sawEmpty = false;
    for (const cand of byVideo.get(v.videoId) ?? []) {
      if (Math.floor(cand.ms / DAY_MS) < pubDay) continue;
      if (isEmptyReading(cand.snap)) {
        sawEmpty = true;
        continue;
      }
      if (!best || cand.ms >= best.ms) best = cand;
    }
    let reading: Reading | null = null;
    if (best) {
      const sn = best.snap;
      reading = {
        date: sn.snapshotDate,
        daysAfterPublish: Math.floor(best.ms / DAY_MS) - pubDay,
        views: sn.views,
        likes: sn.likes,
        comments: sn.comments,
        watchMinutes: sn.watchMinutes,
        // A duration of exactly 0 with views is the poller's default for "no duration returned": unknown, not 0 seconds.
        avgViewSeconds: sn.avgViewSeconds === 0 && sn.views !== null && sn.views > 0 ? null : sn.avgViewSeconds,
        impressions: sn.impressions,
      };
    }
    out.push({
      videoId: v.videoId,
      channelId: v.channelId,
      title: v.title,
      publishedAt: v.publishedAt,
      privacy: v.privacy,
      format: v.format,
      reading,
      noData: reading === null && sawEmpty,
    });
  }
  // Newest first; a stable, total order so two renders of the same rows agree.
  out.sort((a, b) => (timeMs(b.publishedAt) ?? 0) - (timeMs(a.publishedAt) ?? 0) || a.videoId.localeCompare(b.videoId));
  return out;
}

// --- KPIs --------------------------------------------------------------------------------------------------------------

/** A figure and how much of the set it covers. `value` null means no video had it: the page says "not measured". */
export interface Figure {
  value: number | null;
  /** How many videos contributed. */
  known: number;
  /** How many videos were in the set. */
  of: number;
}

export interface Kpis {
  videos: number;
  measured: number;
  /** Videos whose stored readings were all empty (all zeros): counted as not measured, said so on the page. */
  noData: number;
  views: Figure;
  watchHours: Figure;
  likes: Figure;
  comments: Figure;
  avgViewSeconds: Figure;
}

function sumFigure(rows: readonly VideoResult[], pick: (r: Reading) => number | null, scale = 1): Figure {
  let total = 0;
  let known = 0;
  for (const row of rows) {
    const v = row.reading ? pick(row.reading) : null;
    if (v === null) continue;
    total += v;
    known += 1;
  }
  return { value: known === 0 ? null : total / scale, known, of: rows.length };
}

/**
 * Average view duration, weighted by views: a 2-view video must not pull the average of a 2,000-view one around. Only the
 * videos that report BOTH a duration and a view count take part; when their views add up to nothing there is no weight,
 * and the answer is null, not 0.
 */
function weightedDuration(rows: readonly VideoResult[]): Figure {
  let weighted = 0;
  let weight = 0;
  let known = 0;
  for (const row of rows) {
    const r = row.reading;
    if (!r || r.avgViewSeconds === null || r.views === null) continue;
    known += 1;
    weighted += r.avgViewSeconds * r.views;
    weight += r.views;
  }
  return { value: weight > 0 ? weighted / weight : null, known, of: rows.length };
}

export function computeKpis(rows: readonly VideoResult[]): Kpis {
  return {
    videos: rows.length,
    measured: rows.filter((r) => r.reading !== null).length,
    noData: rows.filter((r) => r.noData).length,
    views: sumFigure(rows, (r) => r.views),
    watchHours: sumFigure(rows, (r) => r.watchMinutes, 60),
    likes: sumFigure(rows, (r) => r.likes),
    comments: sumFigure(rows, (r) => r.comments),
    avgViewSeconds: weightedDuration(rows),
  };
}

/** The videos with the most views in their latest reading. A video without a views figure is not ranked, and no tie is invented. */
export function topByViews(rows: readonly VideoResult[], n: number): VideoResult[] {
  return rows
    .filter((r) => r.reading !== null && r.reading.views !== null)
    .sort((a, b) => (b.reading!.views as number) - (a.reading!.views as number) || a.videoId.localeCompare(b.videoId))
    .slice(0, Math.max(0, n));
}

// --- freshness ---------------------------------------------------------------------------------------------------------

export interface Freshness {
  /** The newest reading's day (YYYY-MM-DD), or null when there is no reading at all. */
  asOf: string | null;
  /** Whole days between that day and now (never negative), or null when asOf is null. */
  ageDays: number | null;
  stale: boolean;
}

export function freshness(readingDates: readonly (string | null | undefined)[], nowMs: number): Freshness {
  let best: { date: string; ms: number } | null = null;
  for (const d of readingDates) {
    if (!d) continue;
    const ms = timeMs(d);
    if (ms === null) continue;
    if (!best || ms > best.ms) best = { date: d, ms };
  }
  if (!best) return { asOf: null, ageDays: null, stale: false };
  const ageDays = Math.max(0, Math.floor((nowMs - best.ms) / DAY_MS));
  return { asOf: best.date, ageDays, stale: ageDays > STALE_AFTER_DAYS };
}

// --- publish history ---------------------------------------------------------------------------------------------------

export type HistoryStatus = "uploaded" | "queued" | "uploading" | "processing" | "failed" | "refused";
const HISTORY_STATUSES: readonly HistoryStatus[] = ["uploaded", "queued", "uploading", "processing", "failed", "refused"];

export interface HistoryEntry {
  /** Unique within the list: `up:<video id>` for the pipeline's own upload, `rq:<request id>` for a cross-post. */
  key: string;
  kind: "upload" | "request";
  platform: "youtube" | "instagram" | "tiktok";
  /** The channel or account it went to, by name; null when the name is unknown (the page then says so). */
  target: string | null;
  videoId: string;
  videoTitle: string | null;
  /** ISO time the entry is dated by: the upload time, or the time the request was made (publish_requests.created_at, the same date the window filters by). */
  at: string;
  status: HistoryStatus;
  /** The privacy the record states ("private", "unlisted", "public", "SELF_ONLY"...), or null when it states none. */
  privacy: string | null;
  /** A reason word for a refusal or failure (publish_requests.reason), or null. */
  reason: string | null;
  /** The platform's own https link, when the worker recorded one. */
  url: string | null;
}

export interface RequestInput {
  id: number;
  videoId: string;
  platform: "youtube" | "instagram" | "tiktok";
  /** publish_requests.status, as stored. */
  status: string;
  reason: string | null;
  privacy: string | null;
  resultUrl: string | null;
  createdAt: string | null;
  /** The name of the target, resolved by the caller from rows it read in the SAME organization; null if unknown. */
  target: string | null;
}

/** publish_requests.status "published" means the upload finished; whether it is public is a separate fact (`privacy`). */
export function historyStatus(raw: string): HistoryStatus {
  if (raw === "published") return "uploaded";
  return (HISTORY_STATUSES as readonly string[]).includes(raw) ? (raw as HistoryStatus) : "failed";
}

/**
 * What was put where, and when, newest first, inside the window.
 *
 * The pipeline's own upload of each video (the `videos` row) and every cross-post request, as one list. Nothing is
 * inferred: an entry says what the record says, a privacy the record does not state stays null (the page prints
 * "not recorded", it does not call the video public or private).
 */
export function buildHistory(
  videos: readonly (VideoInput & { channelName?: string | null })[],
  requests: readonly RequestInput[],
  titleOf: ReadonlyMap<string, string | null>,
  nowMs: number,
  days: RangeDays,
  limit: number = MAX_HISTORY,
): HistoryEntry[] {
  const start = windowStart(nowMs, days);
  const out: HistoryEntry[] = [];
  for (const v of videos) {
    const ms = timeMs(v.publishedAt);
    if (ms === null || ms < start || ms > nowMs || !v.publishedAt) continue;
    out.push({
      key: `up:${v.videoId}`,
      kind: "upload",
      platform: "youtube",
      target: v.channelName ?? null,
      videoId: v.videoId,
      videoTitle: v.title,
      at: v.publishedAt,
      status: "uploaded",
      privacy: v.privacy,
      reason: null,
      url: null,
    });
  }
  for (const r of requests) {
    const at = r.createdAt;
    const ms = timeMs(at);
    if (ms === null || ms < start || ms > nowMs || !at) continue;
    out.push({
      key: `rq:${r.id}`,
      kind: "request",
      platform: r.platform,
      target: r.target,
      videoId: r.videoId,
      videoTitle: titleOf.get(r.videoId) ?? null,
      at,
      status: historyStatus(r.status),
      privacy: r.privacy,
      reason: r.reason,
      url: r.resultUrl && r.resultUrl.startsWith("https://") ? r.resultUrl : null,
    });
  }
  out.sort((a, b) => (timeMs(b.at) ?? 0) - (timeMs(a.at) ?? 0) || a.key.localeCompare(b.key));
  return out.slice(0, Math.max(0, limit));
}
