import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { formatDay } from "@/lib/date-format";
import { formatNumber } from "@/lib/number-format";
import { PUBLIC_STAT_COUNTS, type PublicStats } from "@/lib/public-stats";

/** "Nov 14, 2026, 05:10 UTC": the server has no visitor's zone, so the time says which one it is in. */
export function statsTime(iso: string, locale: Locale): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatDay(d, locale, "UTC")}, ${hh}:${mm} UTC`;
}

/**
 * "Live from our pipeline": what the pipeline has done, counted by the database (public_site_stats(), migration 0164;
 * docs/PUBLIC_STATS.md). Wired into the landing (under the facts row) and /solutions, and invisible until the owner turns
 * the switch on: `stats` is null while it is off, while 0164 is not applied, and when the read failed, and then this renders
 * nothing at all (no empty box, no zeros).
 *
 * Every number carries the label of what it counts and the strip says when it was measured. A value the database did not send
 * reads "not measured yet", never 0. No rate or percentage is shown. A Server Component: nothing here runs in the browser.
 */
export function LiveStats({ t, locale, stats }: { t: Dictionary; locale: Locale; stats: PublicStats | null }) {
  if (!stats) return null;
  const s = t.site.liveStats;
  const items = [
    ...PUBLIC_STAT_COUNTS.map((id) => {
      const n = stats.counts[id];
      return { id, label: s.counts[id], value: n === null ? null : formatNumber(n, locale, 0) };
    }),
    { id: "last_run_at", label: s.lastRun, value: stats.lastRunAt ? statsTime(stats.lastRunAt, locale) : null },
  ];
  return (
    <section aria-labelledby="live-stats-title" className="nx-live" data-live-stats>
      <div className="nx-wrap">
        <div className="nx-live-head">
          <h2 id="live-stats-title" className="nx-live-h">
            <span className="nx-live-dot" aria-hidden />
            {s.label}
          </h2>
          <p className="nx-live-asof">
            <time dateTime={stats.asOf}>{fmt(s.asOf, { time: statsTime(stats.asOf, locale) })}</time>
          </p>
        </div>
        <p className="nx-live-lead">{s.lead}</p>
        <dl className="nx-live-list">
          {items.map((i) => (
            <div key={i.id} data-stat={i.id} data-measured={i.value === null ? "no" : "yes"}>
              <dt className="nx-live-l">{i.label}</dt>
              <dd className={i.id === "last_run_at" ? "nx-live-n nx-live-time" : "nx-live-n"}>
                {i.value ?? <span className="nx-live-none">{s.notMeasured}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
