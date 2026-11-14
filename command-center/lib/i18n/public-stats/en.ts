/**
 * The site's live counters ("Live from our pipeline", components/site/LiveStats.tsx; migration 0164, docs/PUBLIC_STATS.md).
 * Shown only once the owner turns them on. English is the source: ru.ts and uz.ts are typed `PublicStatsDictionary`.
 * The ru and uz sentences are machine drafts: have a native speaker read them.
 *
 * Each label says what is counted; a number never stands alone. `notMeasured` is what a value the database did not send reads
 * (never 0). No sentence here may state a figure: the figures come from the database only.
 */
export const publicStatsEn = {
  label: "Live from our pipeline",
  lead: "Counted from our database across our customers' workspaces. Our own and test workspaces are left out.",
  /** {time}: when the numbers were measured, in UTC. */
  asOf: "As of {time}",
  notMeasured: "not measured yet",
  counts: {
    /** A lower bound in the database (docs/PUBLIC_STATS.md): said so. */
    videos_rendered: "Videos rendered (at least)",
    videos_uploaded_private: "Videos uploaded to YouTube as private",
    videos_approved: "Videos a person approved",
    studio_generations: "Studio generations completed",
  },
  lastRun: "Last pipeline run finished",
  /** The database gives the last run only to the hour (so no customer can match it to their own run): {day} and the hour's two ends. */
  hourRange: "{day}, between {from} and {to} UTC",
};

export type PublicStatsDictionary = typeof publicStatsEn;
