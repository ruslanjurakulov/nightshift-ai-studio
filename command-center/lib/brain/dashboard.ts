/**
 * The customer's Nightshift Brain dashboard, the pure half: client-safe and
 * unit-tested (tests/brain-dashboard.test.ts).
 *
 * It shapes what brain_org_facts (migration 0201) returns for ONE organization
 * and works out the few figures the page shows on top of it. Every figure
 * keeps the line between "measured" and "assumed" (CLAUDE.md rule 5):
 *
 * - a credit forecast is an ESTIMATE from the last 14 days, said as such, and
 *   it is no figure at all when nothing was spent or the balance is unknown;
 * - "fetched N min ago" travels with every number read from somewhere else;
 * - an unknown is null, never 0.
 */

export const FORECAST_WINDOW_DAYS = 14;
/** The share of the plan's credits used at which the page warns. The owner's number. */
export const WARN_USED_SHARE = 0.7;

/** What the page groups spend into. A creative job is told apart by its capability. */
export type SpendTool = "image" | "video" | "voice" | "channel_videos" | "film" | "export" | "chat" | "other";
export const SPEND_TOOLS: readonly SpendTool[] = ["image", "video", "voice", "channel_videos", "film", "export", "chat", "other"];

const IMAGE_CAPS = new Set(["t2i", "edit", "upscale", "remove_bg", "expand", "relight", "erase"]);
const VIDEO_CAPS = new Set(["t2v", "i2v", "video_edit", "video_reframe", "video_remove_bg", "video_upscale"]);
const VOICE_CAPS = new Set(["tts", "sfx", "music", "voice_change", "dub"]);

/** The tool a ledger tag from brain_org_facts belongs to ("cj:t2i", "run", "film" …). */
export function toolOfTag(tag: string): SpendTool {
  if (tag.startsWith("cj:")) {
    const cap = tag.slice(3);
    if (IMAGE_CAPS.has(cap)) return "image";
    if (VIDEO_CAPS.has(cap)) return "video";
    if (VOICE_CAPS.has(cap)) return "voice";
    return "other";
  }
  if (tag === "run") return "channel_videos";
  if (tag === "film") return "film";
  if (tag === "export") return "export";
  if (tag === "chat") return "chat";
  return "other";
}

function num(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Credits charged per tool, every tool present (0 where nothing was charged, which the ledger does measure). */
export function spendByTool(raw: unknown): Record<SpendTool, number> {
  const out = Object.fromEntries(SPEND_TOOLS.map((t) => [t, 0])) as Record<SpendTool, number>;
  const o = obj(raw);
  if (!o) return out;
  for (const [tag, v] of Object.entries(o)) {
    const n = num(v);
    if (n !== null && n > 0) out[toolOfTag(tag)] = Math.round((out[toolOfTag(tag)] + n) * 100) / 100;
  }
  return out;
}

export interface DayPoint {
  day: string;
  credits: number;
}

export interface BrainFacts {
  orgId: string;
  generatedAt: string | null;
  spend14: Record<SpendTool, number>;
  spend30: Record<SpendTool, number>;
  daily: DayPoint[];
  /** What can be spent now; null when unknown, "exempt" for a workspace that is never charged. */
  spendable: number | "exempt" | null;
  plan: { name: string | null; granted: number | null; spent: number | null; periodEnd: string | null } | null;
  /** The renewal: the subscription's current period end, when there is one. */
  renewsAt: string | null;
  videosTotal: number | null;
  recentVideos: {
    videoId: string;
    title: string | null;
    channelId: string | null;
    publishedAt: string | null;
    views: number | null;
    likes: number | null;
    comments: number | null;
    snapshotDate: string | null;
  }[];
  memory: { characters: number | null; styleKits: number | null; brandDomains: number | null };
}

/** brain_org_facts' answer as the page reads it; null for anything that is not one. */
export function coerceFacts(raw: unknown): BrainFacts | null {
  const r = obj(raw);
  if (!r || !str(r.org_id)) return null;
  const credits = obj(r.credits) ?? {};
  const usage = obj(credits.usage);
  const planCredits = obj(usage?.plan_credits);
  const plan = obj(usage?.plan);
  const sub = obj(usage?.subscription);
  const daily: DayPoint[] = Array.isArray(credits.daily_14d)
    ? (credits.daily_14d as unknown[]).flatMap((d) => {
        const o = obj(d);
        const day = str(o?.day);
        const c = num(o?.credits);
        return day && c !== null ? [{ day, credits: c }] : [];
      })
    : [];
  const spendable =
    usage?.exempt === true ? "exempt" : num(usage?.spendable_now);
  const projects = obj(r.projects) ?? {};
  const memory = obj(r.memory) ?? {};
  return {
    orgId: r.org_id as string,
    generatedAt: str(r.generated_at),
    spend14: spendByTool(credits.spend_by_tool_14d),
    spend30: spendByTool(credits.spend_by_tool_30d),
    daily,
    spendable,
    plan:
      plan || planCredits
        ? {
            name: str(plan?.name),
            granted: num(planCredits?.granted),
            spent: num(planCredits?.spent),
            periodEnd: str(planCredits?.period_end),
          }
        : null,
    renewsAt: str(sub?.current_period_end) ?? str(planCredits?.period_end),
    videosTotal: num(projects.videos_total),
    recentVideos: Array.isArray(projects.recent_videos)
      ? (projects.recent_videos as unknown[]).flatMap((v) => {
          const o = obj(v);
          const id = str(o?.video_id);
          if (!o || !id) return [];
          const latest = obj(o.latest);
          return [
            {
              videoId: id,
              title: str(o.title),
              channelId: str(o.channel_id),
              publishedAt: str(o.published_at),
              views: num(latest?.views),
              likes: num(latest?.likes),
              comments: num(latest?.comments),
              snapshotDate: str(latest?.date),
            },
          ];
        })
      : [],
    memory: {
      characters: num(memory.characters),
      styleKits: num(memory.style_kits),
      brandDomains: num(memory.brand_domains),
    },
  };
}

export type Forecast =
  | { state: "exempt" }
  | { state: "unknown" }
  | { state: "no_spend"; avgPerDay: 0 }
  | { state: "estimate"; avgPerDay: number; daysLeft: number; runsOutOn: string; beforeRenewal: boolean | null };

/**
 * "At this rate your credits last until <date>": the average of the last 14
 * calendar days (quiet days count as 0, or a busy weekend would be stretched
 * over the whole fortnight), divided into what can be spent now. An estimate
 * only. No spend, an unknown balance or a series shorter than the window give
 * no date at all: a date from three data points would look measured.
 */
export function forecast(f: Pick<BrainFacts, "spendable" | "daily" | "renewsAt">, now: number = Date.now()): Forecast {
  if (f.spendable === "exempt") return { state: "exempt" };
  if (f.spendable === null || f.daily.length < FORECAST_WINDOW_DAYS) return { state: "unknown" };
  const window = f.daily.slice(-FORECAST_WINDOW_DAYS);
  const total = window.reduce((s, d) => s + Math.max(0, d.credits), 0);
  if (total <= 0) return { state: "no_spend", avgPerDay: 0 };
  const avgPerDay = total / FORECAST_WINDOW_DAYS;
  const daysLeft = Math.max(0, f.spendable) / avgPerDay;
  const runsOut = new Date(now + Math.floor(daysLeft) * 86_400_000);
  const renew = f.renewsAt ? Date.parse(f.renewsAt) : NaN;
  return {
    state: "estimate",
    avgPerDay: Math.round(avgPerDay * 100) / 100,
    daysLeft: Math.floor(daysLeft),
    runsOutOn: runsOut.toISOString().slice(0, 10),
    beforeRenewal: Number.isNaN(renew) ? null : runsOut.getTime() < renew,
  };
}

/** The share of the plan's credits used this period; null when either figure is unknown or nothing was granted. */
export function usedShare(plan: BrainFacts["plan"]): number | null {
  if (!plan || plan.granted === null || plan.spent === null || plan.granted <= 0) return null;
  return Math.min(1, Math.max(0, plan.spent / plan.granted));
}

export function warnUsed(plan: BrainFacts["plan"]): boolean {
  const s = usedShare(plan);
  return s !== null && s >= WARN_USED_SHARE;
}

/** Whole minutes since `iso`; null when the time is unknown. A clock a little ahead reads 0, never negative. */
export function minutesAgo(iso: string | null, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 60_000));
}

/** Where the 14-day spark line sits, 0..1 per day; all zeros stay a flat line (never scaled up to look busy). */
export function sparkPoints(daily: readonly DayPoint[]): number[] {
  const max = Math.max(0, ...daily.map((d) => d.credits));
  return daily.map((d) => (max > 0 ? Math.max(0, d.credits) / max : 0));
}

/** What a read of brain_org_facts ends as. Four outcomes that never blur. */
export type BrainFactsRead =
  | { state: "ok"; facts: BrainFacts }
  | { state: "not_available" }
  | { state: "not_found" }
  | { state: "failed" };

/** The channel section's read (S10's research readers, docs/studio/RESEARCH_TOOLS.md). Statuses are S10's own words, said
 *  as such, never as "0". There is no growth series in v1: YouTube's policies forbid deriving one from snapshots, so none is
 *  drawn (S10, 21 Nov). */
export type ChannelStatus = "ok" | "no_data" | "not_connected" | "refreshing" | "budget_exhausted" | "not_enabled";

export interface ChannelUpload {
  videoId: string;
  title: string | null;
  publishedAt: string | null;
  views: number | null;
}

export interface ChannelTheme {
  /** A question or a repeated-word group, grouped by Nightshift from comments: viewers' words, shown as plain text. */
  label: string;
  count: number | null;
}

export type ChannelRead =
  | { state: "not_enabled" }
  /** All channels is open and the workspace has several: the card asks for one instead of adding them up. */
  | { state: "pick_channel" }
  | { state: "no_channel" }
  | { state: "failed" }
  | { state: Exclude<ChannelStatus, "ok" | "not_enabled">; channelId: string; fetchedAt: string | null; remedy: string | null }
  | {
      state: "ok";
      channelId: string;
      fetchedAt: string | null;
      title: string | null;
      /** null with subscribersHidden: YouTube hides the count. null alone: not reported. */
      subscribers: number | null;
      subscribersHidden: boolean;
      views: number | null;
      videoCount: number | null;
      topUploads: ChannelUpload[];
      /** The 28-day Analytics block (OAuth owners only); null when YouTube did not give one. It lags ~48 h. */
      analytics: { views: number | null; minutesWatched: number | null; subsGained: number | null; subsLost: number | null; fetchedAt: string | null } | null;
      themes: ChannelTheme[];
      themesStatus: ChannelStatus | null;
    };

const CHANNEL_STATUSES: readonly ChannelStatus[] = ["ok", "no_data", "not_connected", "refreshing", "budget_exhausted", "not_enabled"];

function status(v: unknown): ChannelStatus | null {
  return typeof v === "string" && (CHANNEL_STATUSES as readonly string[]).includes(v) ? (v as ChannelStatus) : null;
}

function firstArray(o: Record<string, unknown> | null, keys: string[]): unknown[] {
  for (const k of keys) if (o && Array.isArray(o[k])) return o[k] as unknown[];
  return [];
}

/**
 * research_own_channel's envelope ({status, fetched_at, source, data, remedy?}) as the card reads it, with
 * research_comment_themes' beside it. Anything that is not the envelope is "failed", never an empty channel.
 */
export function coerceChannel(channelId: string, own: unknown, themes: unknown): ChannelRead {
  const env = obj(own);
  const st = status(env?.status);
  if (!env || !st) return { state: "failed" };
  if (st === "not_enabled") return { state: "not_enabled" };
  const fetchedAt = str(env.fetched_at);
  if (st !== "ok") return { state: st, channelId, fetchedAt, remedy: str(env.remedy) };
  const d = obj(env.data) ?? {};
  const uploads = firstArray(d, ["uploads", "recent_uploads", "videos"]).flatMap((u) => {
    const o = obj(u);
    const id = str(o?.video_id);
    return o && id ? [{ videoId: id, title: str(o.title), publishedAt: str(o.published_at), views: num(o.view_count) }] : [];
  });
  // The most-watched of the recent uploads first; an upload whose count is unknown goes last, never as 0.
  uploads.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  const an = obj(d.analytics);
  const tEnv = obj(themes);
  const tStatus = status(tEnv?.status);
  const td = tStatus === "ok" ? (obj(tEnv?.data) ?? {}) : null;
  const themeRows: ChannelTheme[] = td
    ? [...firstArray(td, ["questions"]), ...firstArray(td, ["groups", "word_groups", "themes"])].flatMap((g) => {
        const o = obj(g);
        const label = str(o?.label) ?? str(o?.text) ?? str(o?.word) ?? str(o?.question);
        return label ? [{ label: label.slice(0, 80), count: num(o?.count) }] : [];
      })
    : [];
  return {
    state: "ok",
    channelId,
    fetchedAt,
    title: str(d.title) ?? str(d.channel_title),
    subscribers: num(d.subscriber_count),
    subscribersHidden: d.subscribers_hidden === true,
    views: num(d.view_count),
    videoCount: num(d.video_count),
    topUploads: uploads.slice(0, 5),
    analytics: an
      ? {
          views: num(an.views),
          minutesWatched: num(an.estimated_minutes_watched),
          subsGained: num(an.subscribers_gained),
          subsLost: num(an.subscribers_lost),
          fetchedAt: str(an.fetched_at),
        }
      : null,
    themes: themeRows.slice(0, 8),
    themesStatus: tStatus,
  };
}
