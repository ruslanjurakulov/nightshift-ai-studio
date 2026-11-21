/**
 * The site's live public counters ("Live from our pipeline"), read from public_site_stats() (migration 0164,
 * docs/PUBLIC_STATS.md). Pure: the server reader (lib/server/public-stats.ts) and the strip
 * (components/site/LiveStats.tsx) share it, and tests/public-stats.test.tsx pins it.
 *
 * Rule 5 is the whole design: a value the database did not send as a whole, non-negative number is "not measured yet"
 * (null here), never 0; a measured zero stays 0. No rate or percentage is derived from these, so a small sample cannot be
 * made to look like a trend.
 */

/** The counts, in the order the strip shows them. Each id is a key of public_site_stats()'s answer. */
export const PUBLIC_STAT_COUNTS = ["videos_rendered", "videos_uploaded_private", "videos_approved", "studio_generations"] as const;

export type PublicStatCount = (typeof PUBLIC_STAT_COUNTS)[number];

export type PublicStats = {
  /** When the numbers were measured (ISO), never the time of the page. */
  asOf: string;
  counts: Record<PublicStatCount, number | null>;
  /** When the newest queue run finished (ISO), or null when the database has none. */
  lastRunAt: string | null;
};

/** What the reader keeps: hidden (the switch is off), or the numbers. */
export type PublicStatsRead = { visible: false } | ({ visible: true } & PublicStats);

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function instant(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * public_site_stats()'s answer as the strip may use it. Hidden is only `visible === true` failing: anything else the
 * database could send (false, a string, a missing key) hides the strip. A visible answer without a measurement time is
 * hidden too, since "as of" is part of every number's label. null: the answer is not one this code knows (shown as nothing).
 */
export function parsePublicStats(data: unknown): PublicStatsRead | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.visible !== true) return { visible: false };
  const asOf = instant(d.as_of);
  if (!asOf) return { visible: false };
  const counts = Object.fromEntries(PUBLIC_STAT_COUNTS.map((k) => [k, count(d[k])])) as Record<PublicStatCount, number | null>;
  return { visible: true, asOf, counts, lastRunAt: instant(d.last_run_at) };
}

/** The numbers to draw, or null for "draw nothing at all" (hidden, not applied yet, unreadable). */
export function shownPublicStats(read: PublicStatsRead | null): PublicStats | null {
  if (!read || !read.visible) return null;
  return { asOf: read.asOf, counts: read.counts, lastRunAt: read.lastRunAt };
}
