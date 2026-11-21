// Series — a recurring content line within a channel. Mirrors the Python
// modules/series.py model and the content_series table (migration 0006).
// Read/display helpers for the Command Center; writes go through /api/series.

export type SeriesStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

export const AUTOMATION_LEVELS = [
  "manual",
  "assisted",
  "autopilot_approval",
  "full_autopilot",
] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

// The platforms a series can target. Publishing to anything beyond YouTube is
// not wired yet — these are the intent the model can express.
export const PLATFORM_OPTIONS = ["youtube", "tiktok", "instagram"] as const;
export type Platform = (typeof PLATFORM_OPTIONS)[number];

export type SeriesRow = {
  series_id: string;
  channel_id: string;
  name: string;
  description: string | null;
  niche: string | null;
  language: string | null;
  format: string | null;
  content_type: string | null;
  visual_style: string | null;
  voice_style: string | null;
  cadence: Record<string, unknown> | null;
  platforms: string[] | null;
  automation_level: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export function seriesStatus(row: Pick<SeriesRow, "status">): SeriesStatus {
  const s = (row.status ?? "").toUpperCase();
  return s === "ACTIVE" || s === "ARCHIVED" ? (s as SeriesStatus) : "PAUSED";
}

export function seriesPlatforms(row: Pick<SeriesRow, "platforms">): string[] {
  const p = row.platforms;
  return Array.isArray(p) ? p.filter((x) => typeof x === "string" && x.trim()) : [];
}

// A short human summary of the cadence object, e.g. {long_per_week:2,
// shorts_per_day:1} → "2 long/wk · 1 short/day". Unknown shapes render as
// nothing rather than inventing a number.
export function cadenceSummary(row: Pick<SeriesRow, "cadence">): string {
  const c = row.cadence ?? {};
  const parts: string[] = [];
  const longPerWeek = Number((c as Record<string, unknown>).long_per_week);
  const shortsPerDay = Number((c as Record<string, unknown>).shorts_per_day);
  if (Number.isFinite(longPerWeek) && longPerWeek > 0)
    parts.push(`${longPerWeek} long/wk`);
  if (Number.isFinite(shortsPerDay) && shortsPerDay > 0)
    parts.push(`${shortsPerDay} short/day`);
  return parts.join(" · ");
}

// Count of series per channel id, for a channel-level "N series" badge.
export function seriesCountByChannel(rows: SeriesRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.channel_id] = (out[r.channel_id] ?? 0) + 1;
  return out;
}
