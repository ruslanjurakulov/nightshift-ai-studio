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
  // A channel run, a scene re-render of one, a series episode and an API run are all the channel's videos.
  if (tag === "run" || tag === "scene_regenerate") return "channel_videos";
  if (tag === "repurpose") return "video";
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
  /** The renewal: the period end of a subscription that WILL renew (active, not set to cancel). */
  renewsAt: string | null;
  /** The period end of a subscription that will NOT renew (cancelled, or set to cancel at period end). */
  endsAt: string | null;
  /** The 14-day window's first day, and when this org could first have spent in it (a younger org starts later). */
  windowStart: string | null;
  historyStart: string | null;
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

const RENEWING = new Set(["active", "trialing", "past_due"]);

/** "Renews on" only for a subscription that will; a cancelled one, or one set to cancel, "ends on" the same date. */
function renewal(sub: Record<string, unknown> | null): { renewsAt: string | null; endsAt: string | null } {
  const end = str(sub?.current_period_end);
  if (!sub || !end) return { renewsAt: null, endsAt: null };
  const renews = typeof sub.status === "string" && RENEWING.has(sub.status) && sub.cancel_at_period_end !== true;
  return renews ? { renewsAt: end, endsAt: null } : { renewsAt: null, endsAt: end };
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
    ...renewal(sub),
    windowStart: str(credits.window_start),
    historyStart: str(credits.history_start),
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

/** A forecast needs at least this many days of this org's own history: a date from two days would look measured. */
export const FORECAST_MIN_DAYS = 7;

export type Forecast =
  | { state: "exempt" }
  | { state: "unknown" }
  | { state: "short_history"; days: number }
  | { state: "no_spend"; avgPerDay: 0 }
  /** At this rate the money outlasts the renewal: plan credits expire then, so no date past it is given. */
  | { state: "past_renewal"; avgPerDay: number; renewsAt: string }
  | { state: "estimate"; avgPerDay: number; daysLeft: number; runsOutOn: string };

/**
 * "At this rate your credits last until <date>": what was charged in the 14-day window divided by the days of it this
 * org actually existed (quiet days count as 0, days before the org existed do not), divided into what can be spent now.
 * An estimate only. No date when nothing was spent, the balance is unknown, the org is younger than a week, or the
 * date falls after the plan renews (plan credits expire at renewal, so a date past it would be counted from money that
 * will be gone).
 */
export function forecast(
  f: Pick<BrainFacts, "spendable" | "daily" | "renewsAt" | "historyStart">,
  now: number = Date.now(),
): Forecast {
  if (f.spendable === "exempt") return { state: "exempt" };
  if (f.spendable === null || f.daily.length < FORECAST_WINDOW_DAYS) return { state: "unknown" };
  const start = f.historyStart ? Date.parse(f.historyStart) : NaN;
  const days = Number.isNaN(start)
    ? FORECAST_WINDOW_DAYS
    : Math.min(FORECAST_WINDOW_DAYS, Math.max(1, Math.ceil((now - start) / 86_400_000)));
  if (days < FORECAST_MIN_DAYS) return { state: "short_history", days };
  const window = f.daily.slice(-days);
  const total = window.reduce((s, d) => s + Math.max(0, d.credits), 0);
  if (total <= 0) return { state: "no_spend", avgPerDay: 0 };
  const avgPerDay = Math.round((total / days) * 100) / 100;
  const daysLeft = Math.floor(Math.max(0, f.spendable) / (total / days));
  const runsOut = now + daysLeft * 86_400_000;
  const renew = f.renewsAt ? Date.parse(f.renewsAt) : NaN;
  if (!Number.isNaN(renew) && runsOut >= renew && f.renewsAt) return { state: "past_renewal", avgPerDay, renewsAt: f.renewsAt };
  return { state: "estimate", avgPerDay, daysLeft, runsOutOn: new Date(runsOut).toISOString().slice(0, 10) };
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
  /** S10 lists the channel's own uploads, private and unlisted included; a member sees which is which. Null before that field. */
  privacy: "public" | "unlisted" | "private" | null;
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
      analytics: { views: number | null; minutesWatched: number | null; subsGained: number | null; subsLost: number | null; dataThrough: string | null } | null;
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
  // S10 (0199): the channel's counters are nested under data.channel (null when nothing is cached yet).
  const ch = obj(d.channel);
  const uploads = firstArray(d, ["recent_videos"]).flatMap((u) => {
    const o = obj(u);
    const id = str(o?.video_id);
    const p = o?.privacy_status;
    const privacy: ChannelUpload["privacy"] = p === "public" || p === "unlisted" || p === "private" ? p : null;
    return o && id ? [{ videoId: id, title: str(o.title), publishedAt: str(o.published_at), views: num(o.view_count), privacy }] : [];
  });
  // The most-watched of the recent uploads first; an upload whose count is unknown goes last, never as 0.
  uploads.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  const an = obj(d.analytics);
  const tEnv = obj(themes);
  const tStatus = status(tEnv?.status);
  const td = tStatus === "ok" ? (obj(tEnv?.data) ?? {}) : null;
  const questions = num(obj(td?.questions)?.count);
  const themeRows: ChannelTheme[] = td
    ? [
        ...(questions !== null && questions > 0 ? [{ label: QUESTIONS_THEME, count: questions }] : []),
        ...firstArray(td, ["words"]).flatMap((g) => {
          const o = obj(g);
          // untrusted_word: a viewer's word, rendered as plain text by React, never as markup.
          const label = str(o?.untrusted_word);
          return label ? [{ label: label.slice(0, 80), count: num(o?.count) }] : [];
        }),
      ]
    : [];
  return {
    state: "ok",
    channelId,
    fetchedAt: str(ch?.fetched_at) ?? fetchedAt,
    title: str(ch?.title),
    subscribers: ch?.subscribers_hidden === true ? null : num(ch?.subscriber_count),
    subscribersHidden: ch?.subscribers_hidden === true,
    views: num(ch?.view_count),
    videoCount: num(ch?.video_count),
    topUploads: uploads.slice(0, 5),
    analytics: an
      ? {
          views: num(an.views),
          minutesWatched: num(an.estimated_minutes_watched),
          subsGained: num(an.subscribers_gained),
          subsLost: num(an.subscribers_lost),
          dataThrough: dataThroughDay(str(an.fetched_at)),
        }
      : null,
    themes: themeRows.slice(0, 8),
    themesStatus: tStatus,
  };
}

/** The questions group's marker: the card names it in the reader's language (the reader's own text is never a label). */
export const QUESTIONS_THEME = "\u0000questions";

/** YouTube Analytics' window ends the day BEFORE it was fetched (UTC): that is the honest "data through" day. */
export function dataThroughDay(fetchedAt: string | null): string | null {
  if (!fetchedAt) return null;
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return null;
  return new Date(t - 86_400_000).toISOString().slice(0, 10);
}
