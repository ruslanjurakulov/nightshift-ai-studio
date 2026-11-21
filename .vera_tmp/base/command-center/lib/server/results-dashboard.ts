import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_HISTORY,
  MAX_VIDEOS,
  SNAPSHOT_CAP,
  SNAPSHOT_CHUNK,
  buildHistory,
  buildVideoResults,
  coerceSnapshots,
  coerceVideos,
  computeKpis,
  freshness,
  str,
  windowStart,
  type RangeDays,
  type RequestInput,
  type VideoInput,
} from "@/lib/resultsDashboard/aggregate";
import { platformCards, type PlatformId } from "@/lib/resultsDashboard/platforms";
import type { ChannelSummary, ResultsError, ResultsPayload, SourceState } from "@/lib/resultsDashboard/payload";

/**
 * The results dashboard's reads, all under the SIGNED-IN MEMBER'S own client (anon key + their session: RLS decides what
 * a row may be read at all). No service key, no platform call, nothing written: a page render never reaches YouTube, it
 * reads what the daily poll and the publish worker already stored.
 *
 * Isolation is two locks, not one. RLS is the first (migration 0018 scopes videos, metrics_snapshots and publish_requests
 * to the member's organizations). The second is here: a platform operator can read every tenant through RLS, so every
 * query also names this organization's channels or `org_id` explicitly, and every row that comes back is checked against
 * the organization's channel set again before it is used. A channel id from the request that is not one of this
 * organization's channels is "not found", exactly like a channel that does not exist.
 */

export interface OwnChannel {
  id: string;
  name: string;
  connected: boolean;
  /** The organization that owns it (channels.org_id). A channel without one is never this organization's. */
  orgId: string | null;
}

export interface LoadInput {
  supabase: SupabaseClient;
  orgId: string;
  channels: readonly OwnChannel[];
  /** null for all channels, or one channel id. */
  selected: string | null;
  days: RangeDays;
  nowMs: number;
  /** Rows at which a metrics_snapshots response is taken as cut. PostgREST's default max is 1000; tests lower it. */
  snapshotCap?: number;
}

const CHUNK = 100;
const VIDEO_COLUMNS = "video_id, channel_id, title, topic, published_at, privacy, video_format";
const SNAPSHOT_COLUMNS = "video_id, snapshot_date, views, likes, comment_count, watch_time_minutes, average_view_duration_seconds, impressions";
const REQUEST_COLUMNS = "id, org_id, channel_id, video_id, account_id, target_channel_id, platform, status, reason, privacy, result_url, created_at";

type Failure = { code?: string; message?: string } | null;

/** A table or function this build reads that the database does not have yet (a migration not applied). */
export function isMissingTable(error: Failure): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(error.message ?? "");
}

/** How many metrics_snapshots reads may be in flight at once for one page. */
export const SNAPSHOT_CONCURRENCY = 4;

/**
 * Runs tasks at most `max` at a time, in the order they were asked for. A finishing task hands its slot straight to the next
 * waiting one (the count does not dip), so a task started in between cannot take a fifth place. A task that throws or rejects
 * still frees its slot.
 */
export function createLimiter(maxInFlight: number) {
  const max = Math.max(1, maxInFlight); // 0 (or less) would make every call wait for ever
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => PromiseLike<T>): Promise<T> {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface SnapshotSink {
  rows: unknown[];
  /** A response for ONE video still came back at the cap: some of its readings may be missing. */
  partial: boolean;
}

/**
 * Reads the readings of some videos, newest first. PostgREST silently cuts a response at its max rows (1000 by default), so a
 * response at the cap is never trusted: the ids are split in halves and read again until each answer is under the cap. A single
 * video that alone fills the cap is kept as read and flagged `partial`, so the page can say readings may be missing instead of
 * showing "Not measured" for a video that was measured. Returns false when a read fails.
 */
async function readSnapshots(
  supabase: SupabaseClient,
  ids: readonly string[],
  startDay: string,
  cap: number,
  sink: SnapshotSink,
  limit: ReturnType<typeof createLimiter>,
): Promise<boolean> {
  // Only the query holds a place; the halves below are asked for after it has let go, so a split can never wait on itself.
  const res = await limit(() =>
    supabase
      .from("metrics_snapshots")
      .select(SNAPSHOT_COLUMNS)
      .in("video_id", [...ids])
      .gte("snapshot_date", startDay)
      .order("snapshot_date", { ascending: false })
      .limit(cap),
  );
  if (res.error) return false;
  const rows = Array.isArray(res.data) ? res.data : [];
  if (rows.length >= cap && ids.length > 1) {
    const mid = Math.ceil(ids.length / 2);
    const [a, b] = await Promise.all([readSnapshots(supabase, ids.slice(0, mid), startDay, cap, sink, limit), readSnapshots(supabase, ids.slice(mid), startDay, cap, sink, limit)]);
    return a && b;
  }
  if (rows.length >= cap) sink.partial = true;
  sink.rows.push(...rows);
  return true;
}

export type LoadResult = { ok: true; payload: ResultsPayload } | { ok: false; error: Extract<ResultsError, "not_found" | "failed"> };

export async function loadResults(input: LoadInput): Promise<LoadResult> {
  const { supabase, orgId, days, nowMs } = input;
  // Lock two: only channels that name THIS organization as their owner.
  const own = input.channels.filter((c) => c.orgId === orgId);
  const ownIds = new Set(own.map((c) => c.id));
  if (input.selected !== null && !ownIds.has(input.selected)) return { ok: false, error: "not_found" };
  const scope = input.selected === null ? own : own.filter((c) => c.id === input.selected);
  const scopeIds = scope.map((c) => c.id);
  const summaries: ChannelSummary[] = own.map((c) => ({ id: c.id, name: c.name, connected: c.connected }));
  const names = new Map(own.map((c) => [c.id, c.name]));

  const startMs = windowStart(nowMs, days);
  const startIso = new Date(startMs).toISOString().slice(0, 19);
  const startDay = startIso.slice(0, 10);

  // --- the core reads: a failure here is an error, never an empty dashboard -----------------------------------------
  let videoRows: VideoInput[] = [];
  let truncatedVideos = false;
  if (scopeIds.length > 0) {
    const res = await supabase
      .from("videos")
      .select(VIDEO_COLUMNS)
      .in("channel_id", scopeIds)
      .not("published_at", "is", null)
      .gte("published_at", startIso)
      .order("published_at", { ascending: false })
      .limit(MAX_VIDEOS + 1);
    if (res.error) return { ok: false, error: "failed" };
    const all = coerceVideos(res.data).filter((v) => ownIds.has(v.channelId) && scopeIds.includes(v.channelId));
    truncatedVideos = all.length > MAX_VIDEOS;
    videoRows = all.slice(0, MAX_VIDEOS);
  }

  let snapshots: ReturnType<typeof coerceSnapshots> = [];
  let snapshotsPartial = false;
  if (videoRows.length > 0) {
    const sink: SnapshotSink = { rows: [], partial: false };
    const cap = input.snapshotCap ?? SNAPSHOT_CAP;
    const ids = videoRows.map((v) => v.videoId);
    // 200 videos are 8 chunks, and every chunk that reaches the cap splits into two more: without a bound one page view
    // opens a burst of queries on the member's own session.
    const limit = createLimiter(SNAPSHOT_CONCURRENCY);
    const done = await Promise.all(chunks(ids, SNAPSHOT_CHUNK).map((part) => readSnapshots(supabase, part, startDay, cap, sink, limit)));
    if (done.some((ok) => !ok)) return { ok: false, error: "failed" };
    // buildVideoResults joins readings to the videos above by id, so a row of another video is never used.
    snapshots = coerceSnapshots(sink.rows);
    snapshotsPartial = sink.partial;
  }

  const results = buildVideoResults(videoRows, snapshots, nowMs, days);
  const kpis = computeKpis(results);

  // --- secondary reads: a gap is named, the rest of the page still stands ---------------------------------------------
  let accountsState: SourceState = "ok";
  const accountName = new Map<string, string | null>();
  const connectedByPlatform: Partial<Record<PlatformId, number | null>> = {
    youtube: own.filter((c) => c.connected).length,
  };
  {
    const res = await supabase.from("social_accounts").select("id, org_id, platform, username, display_name, status").eq("org_id", orgId);
    if (res.error) {
      accountsState = isMissingTable(res.error) ? "unavailable" : "failed";
      connectedByPlatform.instagram = null;
      connectedByPlatform.tiktok = null;
    } else {
      let ig = 0;
      let tt = 0;
      for (const row of Array.isArray(res.data) ? res.data : []) {
        const r = row as Record<string, unknown>;
        // Lock two for accounts as well: a row that does not name this organization is not read, whatever the query returned.
        if (r.org_id !== orgId) continue;
        const id = str(r.id);
        if (id) accountName.set(id, str(r.display_name) ?? (str(r.username) ? `@${str(r.username)}` : null));
        if (r.status !== "connected") continue;
        if (r.platform === "instagram") ig += 1;
        else if (r.platform === "tiktok") tt += 1;
      }
      connectedByPlatform.instagram = ig;
      connectedByPlatform.tiktok = tt;
    }
  }

  let requestsState: SourceState = "ok";
  const requests: RequestInput[] = [];
  const titleOf = new Map<string, string | null>(videoRows.map((v) => [v.videoId, v.title]));
  if (scopeIds.length > 0) {
    const res = await supabase
      .from("publish_requests")
      .select(REQUEST_COLUMNS)
      .eq("org_id", orgId)
      .in("channel_id", scopeIds)
      .gte("created_at", startIso)
      .order("created_at", { ascending: false })
      .limit(MAX_HISTORY + 1);
    if (res.error) {
      requestsState = isMissingTable(res.error) ? "unavailable" : "failed";
    } else {
      for (const row of Array.isArray(res.data) ? res.data : []) {
        const r = row as Record<string, unknown>;
        // Lock two for requests: a row that does not name this organization is not used, whatever the query returned.
        if (r.org_id !== orgId) continue;
        const channelId = str(r.channel_id);
        const videoId = str(r.video_id);
        const platform = r.platform;
        const id = typeof r.id === "number" ? r.id : null;
        if (!channelId || !ownIds.has(channelId) || !scopeIds.includes(channelId) || !videoId || id === null) continue;
        if (platform !== "youtube" && platform !== "instagram" && platform !== "tiktok") continue;
        const targetChannel = str(r.target_channel_id);
        const account = str(r.account_id);
        // A target is named only from rows read in this same organization; anything else is "unknown", never a guess.
        const target = platform === "youtube" ? (targetChannel ? (names.get(targetChannel) ?? null) : null) : account ? (accountName.get(account) ?? null) : null;
        const url = str(r.result_url);
        requests.push({
          id,
          videoId,
          platform,
          status: str(r.status) ?? "failed",
          reason: str(r.reason),
          privacy: str(r.privacy),
          resultUrl: url && url.startsWith("https://") ? url : null,
          createdAt: str(r.created_at),
          target,
        });
      }
      // Titles of videos named by a request but older than the window: one more read, still this organization's channels.
      const missing = [...new Set(requests.map((r) => r.videoId))].filter((id) => !titleOf.has(id));
      if (missing.length > 0) {
        const parts = await Promise.all(
          chunks(missing, CHUNK).map((ids) => supabase.from("videos").select("video_id, channel_id, title, topic").in("channel_id", scopeIds).in("video_id", ids)),
        );
        for (const part of parts) {
          if (part.error) continue; // a title is decoration: the entry stays, untitled
          for (const v of coerceVideos(part.data)) if (ownIds.has(v.channelId)) titleOf.set(v.videoId, v.title);
        }
      }
    }
  }

  // One more than shown, so "there is more" is a fact and not a guess.
  const merged = buildHistory(
    videoRows.map((v) => ({ ...v, channelName: names.get(v.channelId) ?? null })),
    requests,
    titleOf,
    nowMs,
    days,
    MAX_HISTORY + 1,
  );
  const historyTruncated = merged.length > MAX_HISTORY;
  const history = merged.slice(0, MAX_HISTORY);

  const payload: ResultsPayload = {
    generatedAt: new Date(nowMs).toISOString(),
    rangeDays: days,
    selected: input.selected,
    channels: summaries,
    platforms: platformCards(connectedByPlatform),
    kpis,
    videos: results,
    history,
    freshness: freshness(results.map((r) => r.reading?.date), nowMs),
    subscribers: "not_collected",
    truncated: { videos: truncatedVideos, history: historyTruncated, snapshots: snapshotsPartial },
    sources: { requests: requestsState, accounts: accountsState },
  };
  return { ok: true, payload };
}
