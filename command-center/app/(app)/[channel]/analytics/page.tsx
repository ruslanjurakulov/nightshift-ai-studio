import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { StatCard, Panel, EmptyState } from "@/components/ui";
import { num, decimal } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelScope } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { fmt } from "@/lib/i18n";
import type { MetricsSnapshotRow, VideoRow } from "@/lib/types";
import { uploadedOnly } from "@/lib/heldVideos";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A video joined to its latest metrics snapshot, with derived figures.
 *  Any field that can't be honestly computed is left null and rendered N/A. */
interface Perf {
  video_id: string;
  title: string;
  topic: string | null;
  views: number | null;
  /** (likes + comments) / views, when views > 0. */
  engagement: number | null;
  /** average_view_duration_seconds — the retention proxy the schema stores. */
  retention: number | null;
  /** views / max(1, days between published_at and snapshot_date). */
  viewsPerDay: number | null;
  snapshotDate: string | null;
}

function parseMs(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = new Date(text).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Mirror of the backend feedback_engine `_views_per_day`: views over the
 *  elapsed days between publish and the snapshot, day-zero floored to 1. */
function viewsPerDay(
  views: number | null,
  publishedAt: string | null,
  snapshotDate: string | null,
): number | null {
  if (views === null) return null;
  const pub = parseMs(publishedAt);
  const measured = parseMs(snapshotDate);
  if (pub === null || measured === null) return null;
  const elapsedDays = Math.floor((measured - pub) / DAY_MS);
  return views / Math.max(1, elapsedDays);
}

function pct(rate: number | null): string {
  return rate === null ? "N/A" : `${(rate * 100).toFixed(2)}%`;
}

function seconds(s: number | null): string {
  return s === null ? "N/A" : `${decimal(s, 0)}s`;
}

/** A compact, axis-less ranked table. Each row shows one label + value pair,
 *  plus a CSS bar sized to the value relative to the section max (real values,
 *  just visually scaled — never invented). */
function RankedList({
  rows,
  render,
  max,
  emptyLabel,
  color = "var(--color-primary)",
}: {
  rows: Perf[];
  render: (p: Perf) => { primary: string; value: string; bar: number | null };
  max: number;
  emptyLabel: string;
  color?: string;
}) {
  if (rows.length === 0) {
    return <EmptyState>{emptyLabel}</EmptyState>;
  }
  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {rows.slice(0, max).map((p, i) => {
        const r = render(p);
        const width = r.bar === null ? 0 : Math.max(2, Math.min(100, r.bar));
        return (
          <li key={p.video_id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="mono w-5 shrink-0 text-[11px] text-[var(--color-muted)] tabular-nums">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-[var(--color-fg)]">{r.primary}</div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--color-panel-2)]">
                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${width}%`, background: color }} />
              </div>
            </div>
            <span className="mono shrink-0 text-sm font-semibold tabular-nums" style={{ color }}>
              {r.value}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default async function AnalyticsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope every channel-owned query to the selected channel (view control;
  // RLS still decides what may be read at all).
  const scope = await getChannelScope();

  const supabase = await createClient();
  let videos: VideoRow[] = [];
  let snapshots: MetricsSnapshotRow[] = [];
  let dbHealthy = true;

  if (supabase) {
    const [vid, snap] = await Promise.all([
      uploadedOnly(scopeQuery(supabase.from("videos").select("*"), scope)).order("published_at", { ascending: false }).limit(500),
      supabase.from("metrics_snapshots").select("*").limit(5000),
    ]);
    if (vid.error || snap.error) dbHealthy = false;
    videos = (vid.data as VideoRow[]) ?? [];
    snapshots = (snap.data as MetricsSnapshotRow[]) ?? [];
  }

  // Reduce snapshots to the latest per video_id in JS (no latest-per-group SQL).
  const latest = new Map<string, MetricsSnapshotRow>();
  for (const s of snapshots) {
    const prev = latest.get(s.video_id);
    if (!prev || (parseMs(s.snapshot_date) ?? 0) >= (parseMs(prev.snapshot_date) ?? 0)) {
      latest.set(s.video_id, s);
    }
  }

  // Build per-video performance records for videos that actually have metrics.
  const perf: Perf[] = [];
  for (const v of videos) {
    const m = latest.get(v.video_id);
    if (!m) continue; // no snapshot yet — expected, not an error
    const views = m.views ?? null;
    const likes = m.likes ?? 0;
    const comments = m.comment_count ?? 0;
    const engagement = views !== null && views > 0 ? (likes + comments) / views : null;
    const retention =
      m.average_view_duration_seconds !== null && m.average_view_duration_seconds !== undefined
        ? m.average_view_duration_seconds
        : null;
    perf.push({
      video_id: v.video_id,
      title: v.title ?? v.video_id,
      topic: v.topic,
      views,
      engagement,
      retention,
      viewsPerDay: viewsPerDay(views, v.published_at, m.snapshot_date),
      snapshotDate: m.snapshot_date ?? null,
    });
  }

  const withMetrics = perf.length;

  // Aggregate stats — only over the real records we have.
  const viewsVals = perf.map((p) => p.views).filter((x): x is number => x !== null);
  const totalViews = viewsVals.length ? viewsVals.reduce((a, b) => a + b, 0) : null;
  const vpdVals = perf.map((p) => p.viewsPerDay).filter((x): x is number => x !== null);
  const avgVpd = vpdVals.length ? vpdVals.reduce((a, b) => a + b, 0) / vpdVals.length : null;
  const engVals = perf.map((p) => p.engagement).filter((x): x is number => x !== null);
  const avgEng = engVals.length ? engVals.reduce((a, b) => a + b, 0) / engVals.length : null;

  // Rankings (each over records where the ranked metric is present).
  const byVpd = perf
    .filter((p) => p.viewsPerDay !== null)
    .sort((a, b) => (b.viewsPerDay ?? 0) - (a.viewsPerDay ?? 0));
  const topPerformers = byVpd;
  const underperformers = [...byVpd].reverse();
  const byEngagement = perf
    .filter((p) => p.engagement !== null)
    .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0));
  const byRetention = perf
    .filter((p) => p.retention !== null)
    .sort((a, b) => (b.retention ?? 0) - (a.retention ?? 0));

  const N = 5;
  const maxVpd = byVpd.length ? byVpd[0].viewsPerDay ?? 1 : 1;
  const maxEng = byEngagement.length ? byEngagement[0].engagement ?? 1 : 1;
  const maxRet = byRetention.length ? byRetention[0].retention ?? 1 : 1;

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="analytics" title={t.analytics.title} subtitle={t.analytics.subtitle} />

      {!dbHealthy ? (
        <Panel title={t.analytics.performance}>
          <EmptyState>{t.analytics.readErr}</EmptyState>
        </Panel>
      ) : withMetrics < 1 ? (
        <Panel title={t.analytics.performance}>
          <EmptyState>{t.analytics.empty}</EmptyState>
        </Panel>
      ) : (
        <>
          {/* Stat row — real aggregates over the videos that have metrics. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label={t.analytics.withMetrics} value={num(withMetrics)} sub={fmt(t.analytics.ofLibrary, { n: num(videos.length) })} />
            <StatCard label={t.analytics.totalViews} value={num(totalViews)} tone="ok" sub={t.analytics.acrossMeasured} />
            <StatCard label={t.analytics.avgViewsDay} value={decimal(avgVpd, 1)} tone="ok" sub={t.analytics.velocity} />
            <StatCard label={t.analytics.avgEngagement} value={pct(avgEng)} sub={t.analytics.engFormula} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title={t.analytics.topPerformers}>
              <RankedList
                rows={topPerformers}
                max={N}
                color="var(--color-ok)"
                emptyLabel={t.analytics.notEnough}
                render={(p) => ({
                  primary: p.title,
                  value: decimal(p.viewsPerDay, 1),
                  bar: p.viewsPerDay === null ? null : (p.viewsPerDay / maxVpd) * 100,
                })}
              />
            </Panel>

            <Panel title={t.analytics.underperformers}>
              {byVpd.length < 2 ? (
                <EmptyState>{t.analytics.needTwo}</EmptyState>
              ) : (
                <RankedList
                  rows={underperformers}
                  max={N}
                  color="var(--color-warn)"
                  emptyLabel={t.analytics.notEnough}
                  render={(p) => ({
                    primary: p.title,
                    value: decimal(p.viewsPerDay, 1),
                    bar: p.viewsPerDay === null ? null : (p.viewsPerDay / maxVpd) * 100,
                  })}
                />
              )}
            </Panel>

            <Panel title={t.analytics.bestEngagement}>
              <RankedList
                rows={byEngagement}
                max={N}
                color="var(--color-primary)"
                emptyLabel={t.analytics.notEnough}
                render={(p) => ({
                  primary: p.title,
                  value: pct(p.engagement),
                  bar: p.engagement === null ? null : (p.engagement / maxEng) * 100,
                })}
              />
            </Panel>

            <Panel title={t.analytics.bestRetention}>
              <RankedList
                rows={byRetention}
                max={N}
                color="var(--color-primary)"
                emptyLabel={t.analytics.notEnough}
                render={(p) => ({
                  primary: p.title,
                  value: seconds(p.retention),
                  bar: p.retention === null ? null : (p.retention / maxRet) * 100,
                })}
              />
            </Panel>
          </div>

          <Panel title={t.analytics.allMeasured}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                    <th className="px-4 py-2 font-semibold">{t.analytics.thTitle}</th>
                    <th className="px-4 py-2 font-semibold">{t.analytics.thTopic}</th>
                    <th className="px-4 py-2 text-right font-semibold">{t.analytics.thViews}</th>
                    <th className="px-4 py-2 text-right font-semibold">{t.analytics.thViewsDay}</th>
                    <th className="px-4 py-2 text-right font-semibold">{t.analytics.thEngagement}</th>
                    <th className="px-4 py-2 text-right font-semibold">{t.analytics.thAvgDur}</th>
                  </tr>
                </thead>
                <tbody>
                  {byVpd.concat(perf.filter((p) => p.viewsPerDay === null)).map((p) => (
                    <tr key={p.video_id} className="border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-panel-2)]">
                      <td className="px-4 py-2 text-[var(--color-fg)]">{p.title}</td>
                      <td className="px-4 py-2 text-[var(--color-muted)]">{p.topic ?? t.common.dash}</td>
                      <td className="px-4 py-2 text-right mono tabular-nums text-[var(--color-fg)]">{num(p.views)}</td>
                      <td className="px-4 py-2 text-right mono tabular-nums text-[var(--color-fg)]">{decimal(p.viewsPerDay, 1)}</td>
                      <td className="px-4 py-2 text-right mono tabular-nums text-[var(--color-muted)]">{pct(p.engagement)}</td>
                      <td className="px-4 py-2 text-right mono tabular-nums text-[var(--color-muted)]">{seconds(p.retention)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <p className="mono text-[10px] text-[var(--color-muted)]">{t.analytics.note}</p>
        </>
      )}
    </div>
  );
}
