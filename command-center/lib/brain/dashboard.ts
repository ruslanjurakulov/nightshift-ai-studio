/**
 * The customer's Nightshift Brain dashboard, the pure half: client-safe and
 * unit-tested (tests/brain-dashboard.test.ts).
 *
 * It shapes what brain_org_facts (migration 0196) returns for ONE organization
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

/** The channel section's read (S10's research readers). Statuses are S10's words, said as such, never as "0". */
export type ChannelRead =
  | { state: "not_available" }
  | { state: "not_connected" }
  | { state: "no_data"; fetchedAt: string | null }
  | { state: "refreshing"; fetchedAt: string | null }
  | { state: "budget_exhausted"; fetchedAt: string | null }
  | { state: "failed" }
  | {
      state: "ok";
      fetchedAt: string | null;
      /** null = YouTube hides the count; undefined never reaches the page. */
      subscribers: number | null;
      subscribersHidden: boolean;
      views: number | null;
      growth: DayPoint[];
      topVideos: { videoId: string; title: string | null; views: number | null }[];
      themes: string[];
    };
