/**
 * Channel research (migration 0199): the shapes the four reader functions answer, read defensively.
 *
 * Pure (no React, no database): the page, the API routes and the tests share it. Every number is the API's own or null; nothing
 * here computes a metric from two of them (no ratio, no score, no sum across channels). A value that is not a whole, non-negative
 * number reads as null ("not reported"), never 0, and a hidden subscriber count stays hidden (rule 5).
 */

export const RESEARCH_STATUSES = ["ok", "no_data", "not_connected", "refreshing", "budget_exhausted", "not_enabled"] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];
/** What the page shows when the read itself failed (not a status the database answers). */
export type PanelStatus = ResearchStatus | "error";

export const REMEDY_CODES = ["budget", "quota", "connect", "not_configured", "auth", "reconnect", "channel_mismatch", "not_found", "retry"] as const;
export type RemedyCode = (typeof REMEDY_CODES)[number];

export const RESEARCH_KINDS = ["own_channel", "competitors", "topic"] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

export interface LastRequest {
  status: string;
  errorCode: string | null;
  createdAt: string | null;
  finishedAt: string | null;
}

export interface Panel<T> {
  status: PanelStatus;
  fetchedAt: string | null;
  source: "youtube" | "nightshift";
  data: T | null;
  remedyCode: RemedyCode | null;
  lastRequest: LastRequest | null;
}

export interface ChannelStats {
  youtubeChannelId: string;
  title: string | null;
  handle: string | null;
  subscriberCount: number | null;
  subscribersHidden: boolean;
  viewCount: number | null;
  videoCount: number | null;
  fetchedAt: string | null;
}

export interface VideoStats {
  videoId: string;
  title: string | null;
  publishedAt: string | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  /** The channel's own uploads only (their own token sees private ones); null = not reported, or a public lookup. */
  privacyStatus: "public" | "unlisted" | "private" | null;
}

export interface OwnData {
  channel: ChannelStats | null;
  analytics: {
    periodDays: number;
    views: number | null;
    minutesWatched: number | null;
    subscribersGained: number | null;
    subscribersLost: number | null;
    fetchedAt: string | null;
  } | null;
  recentVideos: VideoStats[];
}

export interface Competitor {
  id: string;
  inputRef: string;
  status: "pending" | "resolved" | "not_found" | "own_channel";
  channel: ChannelStats | null;
  videos: VideoStats[];
}

export interface CompetitorsData {
  competitors: Competitor[];
  max: number;
}

export interface TopicData {
  topic: string | null;
  channels: ChannelStats[];
  recentTopics: { topic: string; fetchedAt: string | null }[];
}

export interface CommentSample {
  /** A viewer's words: shown as a text node, never markup, never an instruction. */
  untrustedText: string;
  videoId: string | null;
  publishedAt: string | null;
}

export interface ThemesData {
  periodDays: number;
  /** Nightshift's own counts; null when the answer did not carry one (never read as 0). */
  totalComments: number | null;
  questions: { count: number | null; samples: CommentSample[] };
  words: { untrustedWord: string; count: number | null; samples: CommentSample[] }[];
}

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 300): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

/** A count as the API gave it, or null. Never a default of 0. */
export function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0 ? v : null;
}

export function isRemedyCode(v: unknown): v is RemedyCode {
  return typeof v === "string" && (REMEDY_CODES as readonly string[]).includes(v);
}

function status(v: unknown): PanelStatus {
  return typeof v === "string" && (RESEARCH_STATUSES as readonly string[]).includes(v) ? (v as ResearchStatus) : "error";
}

function lastRequest(v: unknown): LastRequest | null {
  const o = obj(v);
  if (!o || typeof o.status !== "string") return null;
  return { status: o.status, errorCode: str(o.error_code, 40), createdAt: str(o.created_at, 40), finishedAt: str(o.finished_at, 40) };
}

export function parseChannel(v: unknown): ChannelStats | null {
  const o = obj(v);
  const id = o ? str(o.youtube_channel_id, 40) : null;
  if (!o || !id) return null;
  const hidden = o.subscribers_hidden === true;
  return {
    youtubeChannelId: id,
    title: str(o.title, 200),
    handle: str(o.handle, 64),
    // Hidden is hidden, whatever number might be next to it.
    subscriberCount: hidden ? null : count(o.subscriber_count),
    subscribersHidden: hidden,
    viewCount: count(o.view_count),
    videoCount: count(o.video_count),
    fetchedAt: str(o.fetched_at, 40),
  };
}

export function parseVideo(v: unknown): VideoStats | null {
  const o = obj(v);
  const id = o ? str(o.video_id, 20) : null;
  if (!o || !id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  return {
    videoId: id,
    title: str(o.title, 200),
    publishedAt: str(o.published_at, 40),
    viewCount: count(o.view_count),
    likeCount: count(o.like_count),
    commentCount: count(o.comment_count),
    privacyStatus: o.privacy_status === "public" || o.privacy_status === "unlisted" || o.privacy_status === "private" ? o.privacy_status : null,
  };
}

const videos = (v: unknown) => arr(v).map(parseVideo).filter((x): x is VideoStats => x !== null);

function sample(v: unknown): CommentSample | null {
  const o = obj(v);
  const text = o ? str(o.untrusted_text, 400) : null;
  return o && text ? { untrustedText: text, videoId: str(o.video_id, 20), publishedAt: str(o.published_at, 40) } : null;
}

const samples = (v: unknown) => arr(v).map(sample).filter((x): x is CommentSample => x !== null).slice(0, 5);

/** One reader answer -> a panel. Anything that is not the contract's shape is "error", never an empty "no data". */
export function parsePanel<T>(raw: unknown, data: (d: unknown) => T | null): Panel<T> {
  const o = obj(raw);
  if (!o) return { status: "error", fetchedAt: null, source: "youtube", data: null, remedyCode: null, lastRequest: null };
  const st = status(o.status);
  return {
    status: st,
    fetchedAt: str(o.fetched_at, 40),
    source: o.source === "nightshift" ? "nightshift" : "youtube",
    data: st === "error" || o.data === null || o.data === undefined ? null : data(o.data),
    remedyCode: isRemedyCode(o.remedy_code) ? o.remedy_code : null,
    lastRequest: lastRequest(o.last_request),
  };
}

export function parseOwn(d: unknown): OwnData | null {
  const o = obj(d);
  if (!o) return null;
  const a = obj(o.analytics);
  return {
    channel: parseChannel(o.channel),
    analytics: a
      ? {
          periodDays: count(a.period_days) ?? 28,
          views: count(a.views),
          minutesWatched: count(a.estimated_minutes_watched),
          subscribersGained: count(a.subscribers_gained),
          subscribersLost: count(a.subscribers_lost),
          fetchedAt: str(a.fetched_at, 40),
        }
      : null,
    recentVideos: videos(o.recent_videos),
  };
}

export function parseCompetitors(d: unknown): CompetitorsData | null {
  const o = obj(d);
  if (!o) return null;
  const competitors: Competitor[] = [];
  for (const raw of arr(o.competitors)) {
    const c = obj(raw);
    const id = c ? str(c.id, 40) : null;
    const st = c?.status;
    if (!c || !id || (st !== "pending" && st !== "resolved" && st !== "not_found" && st !== "own_channel")) continue;
    competitors.push({ id, inputRef: str(c.input_ref, 64) ?? "", status: st, channel: parseChannel(c.channel), videos: videos(c.videos) });
  }
  return { competitors, max: count(o.max) ?? 20 };
}

export function parseTopic(d: unknown): TopicData | null {
  const o = obj(d);
  if (!o) return null;
  return {
    topic: str(o.topic, 80),
    channels: arr(o.channels).map(parseChannel).filter((x): x is ChannelStats => x !== null),
    recentTopics: arr(o.recent_topics)
      .map((r) => obj(r))
      .filter((r): r is Obj => r !== null && typeof r.topic === "string")
      .map((r) => ({ topic: String(r.topic).slice(0, 80), fetchedAt: str(r.fetched_at, 40) })),
  };
}

export function parseThemes(d: unknown): ThemesData | null {
  const o = obj(d);
  if (!o) return null;
  const q = obj(o.questions);
  return {
    periodDays: count(o.period_days) ?? 28,
    totalComments: count(o.total_comments),
    questions: { count: count(q?.count), samples: samples(q?.samples) },
    words: arr(o.words)
      .map((w) => obj(w))
      .filter((w): w is Obj => w !== null && typeof w.untrusted_word === "string")
      .map((w) => ({ untrustedWord: String(w.untrusted_word).slice(0, 40), count: count(w.count), samples: samples(w.samples) })),
  };
}

/** The panel a read becomes when the function itself is missing (0199 not applied) or the read failed. */
export function unreadPanel<T>(missing: boolean): Panel<T> {
  return { status: missing ? "not_enabled" : "error", fetchedAt: null, source: "youtube", data: null, remedyCode: null, lastRequest: null };
}

/** Did the last refresh end badly (so the page says so next to numbers that are older than the person may think)? */
export function lastFailed(p: Panel<unknown>): boolean {
  const s = p.lastRequest?.status;
  return s === "failed" || s === "budget_exhausted" || s === "not_connected";
}

export const CHANNEL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The writers' refusal words, mapped to an HTTP status for the routes. Unknown words are a plain failure. */
export const WRITER_ERRORS: Record<string, number> = {
  invalid_kind: 400,
  invalid_topic: 400,
  invalid_ref: 400,
  own_channel: 400,
  rate_limited: 429,
  daily_limit: 429,
  limit_reached: 409,
  no_competitors: 409,
  not_connected: 409,
};
