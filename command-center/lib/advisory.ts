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

export interface AdvisoryIntelligence {
  spend: SpendForecast | null;
  timing: PublishTiming | null;
  repackage: RepackageSummary | null;
  durability: DurabilitySummary | null;
  vidiq: VidiqResearch | null;
  sponsorship: Sponsorship | null;
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
  };
}
