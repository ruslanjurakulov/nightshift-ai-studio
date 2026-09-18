/**
 * Advisory intelligence derivations.
 *
 * The backend's advisory passes each emit ONE roll-up `system_events` row whose
 * `metadata` carries the pass's `to_dict()`/`summarize()` payload:
 *
 *   - `budget.forecast`     (modules/budget.py)          — month-end spend projection
 *   - `publish.timing`      (modules/publish_timing.py)  — best publish hour/weekday
 *   - `repackage.suggested` (modules/repackage.py)       — under-performers to re-title
 *   - `durability.check`    (modules/durability.py)      — is history mirrored off-box
 *   - `sponsorship.estimate`(modules/sponsorship.py)     — CPM-priced sponsor slot value
 *   - `revenue.tracked`     (modules/revenue_tracker.py) — real estimatedRevenue (USD) + RPM
 *   - `niche.rpm`           (modules/niche_rpm.py)       — cross-channel niche ranking
 *   - `quota.allocated`     (modules/quota_allocator.py) — daily upload split by performance
 *   - `spend.overview`      (modules/spend_overview.py)  — All-Accounts cost + month-end forecast
 *
 * These functions read only what those rows actually contain and translate it
 * into typed summaries the Command Center renders. Nothing here invents a value:
 * a missing pass returns `null` (never a fabricated zero), an unmeasured metric
 * stays `null`, and — mirroring the backend — "not mirrored" is kept distinct
 * from "unknown". A parse is defensive because `metadata` is `unknown` JSON that
 * an older or newer backend may shape slightly differently.
 */
import type { SystemEventRow } from "@/lib/types";
import { storedMs } from "@/lib/format";

export const EVENT_BUDGET_FORECAST = "budget.forecast";
export const EVENT_PUBLISH_TIMING = "publish.timing";
export const EVENT_REPACKAGE_SUGGESTED = "repackage.suggested";
export const EVENT_DURABILITY_CHECK = "durability.check";
export const EVENT_VIDIQ_RESEARCH = "vidiq.research";
export const EVENT_SPONSORSHIP_ESTIMATE = "sponsorship.estimate";
export const EVENT_REVENUE_TRACKED = "revenue.tracked";
export const EVENT_NICHE_RPM = "niche.rpm";
export const EVENT_QUOTA_ALLOCATED = "quota.allocated";
export const EVENT_SPEND_OVERVIEW = "spend.overview";
export const EVENT_DIRECTOR_PLAN = "director.plan";
export const EVENT_AGENT_PLAN = "agent.plan";
export const EVENT_ELEMENTS_APPLIED = "elements.applied";

// -- value coercion: unknown JSON in, typed-or-null out ---------------------

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * The most recent event named `name`. Events usually arrive newest-first, but
 * this never relies on that — it compares stored timestamps so a re-ordered or
 * realtime-appended list still yields the genuinely latest row.
 */
function latestEvent(events: SystemEventRow[], name: string): SystemEventRow | null {
  let best: SystemEventRow | null = null;
  for (const e of events ?? []) {
    if (e.event !== name) continue;
    if (best === null || (storedMs(e.ts) ?? 0) > (storedMs(best.ts) ?? 0)) best = e;
  }
  return best;
}

// -- typed summaries --------------------------------------------------------

export interface SpendForecast {
  ts: string;
  channelId: string | null;
  /** Month-to-date priced spend. A floor when `hasUnpriced` is true. */
  spentUsd: number | null;
  /** Straight-line month-end projection, or null when it couldn't be computed. */
  projectedUsd: number | null;
  /** The channel's own ceiling, or null when none is set. */
  ceilingUsd: number | null;
  elapsedDays: number | null;
  daysInMonth: number | null;
  /** Only ever true when the backend actually flagged an over-ceiling pace. */
  projectedExceeds: boolean;
  /** True when some costs are unpriced, so spend/projection read as a floor. */
  hasUnpriced: boolean;
}

export function parseSpendForecast(e: SystemEventRow | null): SpendForecast | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  return {
    ts: e.ts,
    channelId: strOrNull(m.channel_id),
    spentUsd: numOrNull(m.spent_usd),
    projectedUsd: numOrNull(m.projected_usd),
    ceilingUsd: numOrNull(m.ceiling_usd),
    elapsedDays: numOrNull(m.elapsed_days),
    daysInMonth: numOrNull(m.days_in_month),
    projectedExceeds: m.projected_exceeds === true,
    hasUnpriced: m.has_unpriced === true,
  };
}

export interface PublishTiming {
  ts: string;
  bestHourUtc: number | null;
  bestWeekday: number | null;
  bestWeekdayName: string | null;
  samples: number | null;
  timezone: string | null;
  /** A recommendation exists only when both hour and weekday are known. */
  hasRecommendation: boolean;
}

export function parsePublishTiming(e: SystemEventRow | null): PublishTiming | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  const hour = numOrNull(m.best_hour_utc);
  const weekday = numOrNull(m.best_weekday);
  return {
    ts: e.ts,
    bestHourUtc: hour,
    bestWeekday: weekday,
    bestWeekdayName: strOrNull(m.best_weekday_name),
    samples: numOrNull(m.samples),
    timezone: strOrNull(m.timezone),
    hasRecommendation: hour !== null && weekday !== null,
  };
}

export interface RepackageWorst {
  videoId: string | null;
  title: string | null;
  ctr: number | null;
  channelMedianCtr: number | null;
  ageDays: number | null;
  reason: string | null;
}

export interface RepackageSummary {
  ts: string;
  /** How many published videos are flagged as under-performing. */
  count: number | null;
  /** The single worst offender, or null when nothing is flagged. */
  worst: RepackageWorst | null;
}

export function parseRepackage(e: SystemEventRow | null): RepackageSummary | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  const worstRec = asRecord(m.worst);
  const worst: RepackageWorst | null = worstRec
    ? {
        videoId: strOrNull(worstRec.video_id),
        title: strOrNull(worstRec.title),
        ctr: numOrNull(worstRec.ctr),
        channelMedianCtr: numOrNull(worstRec.channel_median_ctr),
        ageDays: numOrNull(worstRec.age_days),
        reason: strOrNull(worstRec.reason),
      }
    : null;
  return { ts: e.ts, count: numOrNull(m.count), worst };
}

export interface DurabilitySummary {
  ts: string;
  localVideos: number | null;
  remoteVideos: number | null;
  mirrorConfigured: boolean | null;
  /** null = unknown (unreadable/unconfigured remote); false = a real gap. */
  mirrored: boolean | null;
  gap: number | null;
}

export function parseDurability(e: SystemEventRow | null): DurabilitySummary | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  return {
    ts: e.ts,
    localVideos: numOrNull(m.local_videos),
    remoteVideos: numOrNull(m.remote_videos),
    mirrorConfigured: boolOrNull(m.mirror_configured),
    mirrored: boolOrNull(m.mirrored),
    gap: numOrNull(m.gap),
  };
}

export interface VidiqKeyword {
  term: string;
  /** vidIQ opportunity score, 0..1, or null when it couldn't be computed. */
  opportunity: number | null;
}

export interface VidiqResearch {
  ts: string;
  /** How many keywords vidIQ could actually score (never a fabricated count). */
  keywordsScored: number | null;
  /** The highest-opportunity term, or null when nothing was scorable. */
  best: string | null;
  /** The ranked head of the list, best first. */
  top: VidiqKeyword[];
}

export function parseVidiqResearch(e: SystemEventRow | null): VidiqResearch | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  const rawTop = Array.isArray(m.top) ? m.top : [];
  const top: VidiqKeyword[] = rawTop
    .map((row) => {
      const r = asRecord(row);
      if (!r) return null;
      const term = strOrNull(r.term);
      if (!term) return null;
      return { term, opportunity: numOrNull(r.opportunity) };
    })
    .filter((k): k is VidiqKeyword => k !== null);
  return {
    ts: e.ts,
    keywordsScored: numOrNull(m.keywords_scored),
    best: strOrNull(m.best),
    top,
  };
}

export interface Sponsorship {
  ts: string;
  /** Mean views over measured long-form videos, or null when none measured. */
  averageViews: number | null;
  measuredVideos: number | null;
  /** The configured sponsorship CPM (USD), or null when the rate is unset. */
  cpmUsd: number | null;
  /** Suggested slot price (USD), or null when reach or rate is missing. */
  priceUsd: number | null;
  currency: string | null;
  reason: string | null;
  /** A price exists only when reach was measured AND a CPM is configured. */
  hasPrice: boolean;
}

export function parseSponsorship(e: SystemEventRow | null): Sponsorship | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  const priceUsd = numOrNull(m.price_usd);
  return {
    ts: e.ts,
    averageViews: numOrNull(m.average_views),
    measuredVideos: numOrNull(m.measured_videos),
    cpmUsd: numOrNull(m.cpm_usd),
    priceUsd,
    currency: strOrNull(m.currency),
    reason: strOrNull(m.reason),
    hasPrice: priceUsd !== null,
  };
}

export interface RevenueEarner {
  videoId: string;
  /** Real estimatedRevenue in USD, or null when unknown (never a fabricated 0). */
  revenueUsd: number | null;
  views: number | null;
  /** revenue / views × 1000, or null when either is unknown. */
  rpmUsd: number | null;
}

export interface RevenueTracked {
  ts: string;
  /** Summed USD across measured videos, or null when none were measured. */
  totalUsd: number | null;
  /** Channel RPM (USD) over measured views, or null. */
  channelRpmUsd: number | null;
  /** How many videos reported real revenue (never a fabricated count). */
  measuredCount: number | null;
  videoCount: number | null;
  currency: string | null;
  /** Top earners, best first. */
  top: RevenueEarner[];
  /** Revenue exists only when at least one video actually reported it. */
  hasRevenue: boolean;
}

export function parseRevenueTracked(e: SystemEventRow | null): RevenueTracked | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  const rawTop = Array.isArray(m.top_earners) ? m.top_earners : [];
  const top: RevenueEarner[] = rawTop
    .map((row) => {
      const r = asRecord(row);
      if (!r) return null;
      const videoId = strOrNull(r.video_id);
      if (!videoId) return null;   // a row without a video id carries no earner
      return {
        videoId,
        revenueUsd: numOrNull(r.revenue_usd),
        views: numOrNull(r.views),
        rpmUsd: numOrNull(r.rpm_usd),
      };
    })
    .filter((k): k is RevenueEarner => k !== null);
  const totalUsd = numOrNull(m.total_usd);
  return {
    ts: e.ts,
    totalUsd,
    channelRpmUsd: numOrNull(m.channel_rpm_usd),
    measuredCount: numOrNull(m.measured_count),
    videoCount: numOrNull(m.video_count),
    currency: strOrNull(m.currency),
    top,
    hasRevenue: totalUsd !== null,
  };
}

export interface NicheRow {
  niche: string;
  /** 2 = measured earnings (real RPM), 1 = engagement only, 0 = insufficient data. */
  tier: number | null;
  videoCount: number | null;
  avgViews: number | null;
  /** Real RPM (USD), only when revenue was supplied; else null (never a fabricated 0). */
  rpmUsd: number | null;
  /** 0..1 composite, or null when nothing measurable exists for the niche. */
  score: number | null;
}

export interface NicheRpm {
  ts: string;
  /** Niches ranked best-first, each tagged with its honest tier. */
  niches: NicheRow[];
  /** The niche backed by enough measured videos to recommend, or null. */
  bestNiche: string | null;
  measuredCount: number | null;
  nicheCount: number | null;
}

export function parseNicheRpm(e: SystemEventRow | null): NicheRpm | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  const rawNiches = Array.isArray(m.niches) ? m.niches : [];
  const niches: NicheRow[] = rawNiches
    .map((row) => {
      const r = asRecord(row);
      if (!r) return null;
      const niche = strOrNull(r.niche);
      if (!niche) return null;
      return {
        niche,
        tier: numOrNull(r.tier),
        videoCount: numOrNull(r.video_count),
        avgViews: numOrNull(r.avg_views),
        rpmUsd: numOrNull(r.rpm_usd),
        score: numOrNull(r.score),
      };
    })
    .filter((n): n is NicheRow => n !== null);
  return {
    ts: e.ts,
    niches,
    bestNiche: strOrNull(m.best_niche),
    measuredCount: numOrNull(m.measured_count),
    nicheCount: numOrNull(m.niche_count),
  };
}

export interface QuotaChannel {
  channelId: string;
  name: string;
  slots: number | null;
  /** Measured weight (views/day), or null when unreadable. */
  score: number | null;
  /** Fraction of total measured performance, or null when nothing is measured. */
  share: number | null;
}

export interface QuotaAllocation {
  ts: string;
  totalSlots: number | null;
  channelCount: number | null;
  /** Channels, best-allocated first. */
  channels: QuotaChannel[];
}

export function parseQuotaAllocation(e: SystemEventRow | null): QuotaAllocation | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  const rawChannels = Array.isArray(m.channels) ? m.channels : [];
  const channels: QuotaChannel[] = rawChannels
    .map((row) => {
      const r = asRecord(row);
      if (!r) return null;
      const channelId = strOrNull(r.channel_id);
      if (!channelId) return null;
      return {
        channelId,
        name: strOrNull(r.name) ?? channelId,
        slots: numOrNull(r.slots),
        score: numOrNull(r.score),
        share: numOrNull(r.share),
      };
    })
    .filter((c): c is QuotaChannel => c !== null);
  return {
    ts: e.ts,
    totalSlots: numOrNull(m.total_slots),
    channelCount: numOrNull(m.channel_count),
    channels,
  };
}

export interface SpendChannel {
  channelId: string;
  name: string;
  /** Month-to-date priced spend, or null when nothing is priced (never 0). */
  spentUsd: number | null;
  projectedUsd: number | null;
  ceilingUsd: number | null;
  /** How many more videos the budget covers, or null when unknown. */
  videosRemaining: number | null;
  avgCostUsd: number | null;
}

export interface SpendOverview {
  ts: string;
  /** Sum over channels with a known spend, or null when nothing is priced. */
  totalSpentUsd: number | null;
  totalProjectedUsd: number | null;
  channelCount: number | null;
  /** True when some cost is quantities-only (a rate isn't set). */
  anyUnpriced: boolean;
  /** Channels, biggest spend first. */
  channels: SpendChannel[];
}

export function parseSpendOverview(e: SystemEventRow | null): SpendOverview | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  const rawChannels = Array.isArray(m.channels) ? m.channels : [];
  const channels: SpendChannel[] = rawChannels
    .map((row) => {
      const r = asRecord(row);
      if (!r) return null;
      const channelId = strOrNull(r.channel_id);
      if (!channelId) return null;
      return {
        channelId,
        name: strOrNull(r.name) ?? channelId,
        spentUsd: numOrNull(r.spent_usd),
        projectedUsd: numOrNull(r.projected_usd),
        ceilingUsd: numOrNull(r.ceiling_usd),
        videosRemaining: numOrNull(r.videos_remaining),
        avgCostUsd: numOrNull(r.avg_cost_usd),
      };
    })
    .filter((c): c is SpendChannel => c !== null);
  return {
    ts: e.ts,
    totalSpentUsd: numOrNull(m.total_spent_usd),
    totalProjectedUsd: numOrNull(m.total_projected_usd),
    channelCount: numOrNull(m.channel_count),
    anyUnpriced: m.any_unpriced === true,
    channels,
  };
}

export interface ElementsApplied {
  ts: string;
  defined: number | null;
  applied: string[];
  scenesTouched: number | null;
}

/** Character Bible elements applied to a run (modules/elements.py). */
export function parseElementsApplied(e: SystemEventRow | null): ElementsApplied | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  const applied = Array.isArray(m.applied)
    ? m.applied.map((x) => strOrNull(x)).filter((x): x is string => x !== null)
    : [];
  return {
    ts: e.ts,
    defined: numOrNull(m.defined),
    applied,
    scenesTouched: numOrNull(m.scenes_touched),
  };
}

export interface DirectorShot {
  scene: number | null;
  name: string;
  shot: string;
  camera: string;
  mood: string;
}

export interface DirectorPlan {
  ts: string;
  scenes: number | null;
  shots: DirectorShot[];
}

/** Director Mode's per-scene shot plan (modules/director.py). */
export function parseDirectorPlan(e: SystemEventRow | null): DirectorPlan | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  const rawShots = Array.isArray(m.shots) ? m.shots : [];
  const shots: DirectorShot[] = rawShots
    .map((row): DirectorShot | null => {
      const r = asRecord(row);
      if (!r) return null;
      return {
        scene: numOrNull(r.scene),
        name: strOrNull(r.name) ?? "",
        shot: strOrNull(r.shot) ?? "",
        camera: strOrNull(r.camera) ?? "",
        mood: strOrNull(r.mood) ?? "",
      };
    })
    .filter((s): s is DirectorShot => s !== null);
  return { ts: e.ts, scenes: numOrNull(m.scenes), shots };
}

export interface AgentPlanView {
  ts: string;
  topic: string;
  rationale: string;
  source: string;
  score: number | null;
  keywords: string[];
  videoProvider: string;
  voiceProvider: string;
}

/** The autopilot agent's daily plan (modules/agent_planner.py). */
export function parseAgentPlan(e: SystemEventRow | null): AgentPlanView | null {
  if (!e) return null;
  const m = asRecord(e.metadata) ?? {};
  const keywords = Array.isArray(m.keywords)
    ? m.keywords.map((x) => strOrNull(x)).filter((x): x is string => x !== null)
    : [];
  return {
    ts: e.ts,
    topic: strOrNull(m.topic) ?? "",
    rationale: strOrNull(m.rationale) ?? "",
    source: strOrNull(m.source) ?? "",
    score: numOrNull(m.score),
    keywords,
    videoProvider: strOrNull(m.video_provider) ?? "",
    voiceProvider: strOrNull(m.voice_provider) ?? "",
  };
}

export interface AdvisoryIntelligence {
  spend: SpendForecast | null;
  timing: PublishTiming | null;
  repackage: RepackageSummary | null;
  durability: DurabilitySummary | null;
  vidiq: VidiqResearch | null;
  sponsorship: Sponsorship | null;
  revenue: RevenueTracked | null;
  nicheRpm: NicheRpm | null;
  quota: QuotaAllocation | null;
  spendOverview: SpendOverview | null;
  director: DirectorPlan | null;
  agent: AgentPlanView | null;
  elements: ElementsApplied | null;
}

/**
 * The latest advisory summary of each kind from a `system_events` list. Any
 * pass that has never run is `null` — the view shows it as "no data yet", never
 * as an empty/zero result.
 */
export function deriveAdvisory(events: SystemEventRow[]): AdvisoryIntelligence {
  return {
    spend: parseSpendForecast(latestEvent(events, EVENT_BUDGET_FORECAST)),
    timing: parsePublishTiming(latestEvent(events, EVENT_PUBLISH_TIMING)),
    repackage: parseRepackage(latestEvent(events, EVENT_REPACKAGE_SUGGESTED)),
    durability: parseDurability(latestEvent(events, EVENT_DURABILITY_CHECK)),
    vidiq: parseVidiqResearch(latestEvent(events, EVENT_VIDIQ_RESEARCH)),
    sponsorship: parseSponsorship(latestEvent(events, EVENT_SPONSORSHIP_ESTIMATE)),
    revenue: parseRevenueTracked(latestEvent(events, EVENT_REVENUE_TRACKED)),
    nicheRpm: parseNicheRpm(latestEvent(events, EVENT_NICHE_RPM)),
    quota: parseQuotaAllocation(latestEvent(events, EVENT_QUOTA_ALLOCATED)),
    spendOverview: parseSpendOverview(latestEvent(events, EVENT_SPEND_OVERVIEW)),
    director: parseDirectorPlan(latestEvent(events, EVENT_DIRECTOR_PLAN)),
    agent: parseAgentPlan(latestEvent(events, EVENT_AGENT_PLAN)),
    elements: parseElementsApplied(latestEvent(events, EVENT_ELEMENTS_APPLIED)),
  };
}
