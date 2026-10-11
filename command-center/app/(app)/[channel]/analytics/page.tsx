import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { StatCard, Panel, EmptyState } from "@/components/ui";
import { DataList } from "@/components/g4/DataList";
import { Section, Figures } from "@/components/g4/Section";
import "../../app-pages-g4.css";
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
  color = "var(--ns-act)",
  inkColor,
}: {
  rows: Perf[];
  render: (p: Perf) => { primary: string; value: string; bar: number | null };
  max: number;
  emptyLabel: string;
  color?: string;
  /** The figure's own colour when it carries a meaning (ahead / behind); plain text otherwise. */
  inkColor?: string;
}) {
  if (rows.length === 0) {
    return <EmptyState>{emptyLabel}</EmptyState>;
  }
  return (
    <ol className="g4-rank" style={{ ["--g4-tone" as string]: color, ["--g4-tone-ink" as string]: inkColor }}>
      {rows.slice(0, max).map((p, i) => {
        const r = render(p);
        const width = r.bar === null ? 0 : Math.max(2, Math.min(100, r.bar));
        return (
          <li key={p.video_id}>
            <span className="g4-rank-n">{String(i + 1).padStart(2, "0")}</span>
            <div className="min-w-0">
              <div className="g4-rank-title">{r.primary}</div>
              <div className="g4-rank-bar" aria-hidden>
                <span style={{ width: `${width}%` }} />
              </div>
            </div>
            <span className="g4-rank-val">{r.value}</span>
          </li>
        );
      })}
    </ol>
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
    <div className="rhythm ns-open g4 stagger-enter">
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
          {/* The desk: the headline figures, real aggregates over the videos that have metrics. */}
          <section className="ns-desk" aria-label={t.analytics.performance}>
            <Figures>
              <StatCard label={t.analytics.withMetrics} value={num(withMetrics)} sub={fmt(t.analytics.ofLibrary, { n: num(videos.length) })} />
              <StatCard label={t.analytics.totalViews} value={num(totalViews)} sub={t.analytics.acrossMeasured} />
              <StatCard label={t.analytics.avgViewsDay} value={decimal(avgVpd, 1)} sub={t.analytics.velocity} />
              <StatCard label={t.analytics.avgEngagement} value={pct(avgEng)} sub={t.analytics.engFormula} />
            </Figures>
          </section>

          <div className="g4-cols">
            <Panel title={t.analytics.topPerformers}>
              <RankedList
                rows={topPerformers}
                max={N}
                color="var(--ns-go)"
                inkColor="var(--color-ok)"
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
                  color="var(--ns-caution)"
                  inkColor="var(--color-warn)"
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
                emptyLabel={t.analytics.notEnough}
                render={(p) => ({
                  primary: p.title,
                  value: seconds(p.retention),
                  bar: p.retention === null ? null : (p.retention / maxRet) * 100,
                })}
              />
            </Panel>
          </div>

          <Section title={t.analytics.allMeasured}>
            <DataList
              caption={t.analytics.allMeasured}
              rows={byVpd.concat(perf.filter((p) => p.viewsPerDay === null))}
              rowKey={(p) => p.video_id}
              columns={[
                { key: "title", label: t.analytics.thTitle, render: (p) => p.title },
                { key: "topic", label: t.analytics.thTopic, render: (p) => <span className="g4-muted">{p.topic ?? t.common.dash}</span> },
                { key: "views", label: t.analytics.thViews, align: "end", render: (p) => num(p.views) },
                { key: "vpd", label: t.analytics.thViewsDay, align: "end", render: (p) => decimal(p.viewsPerDay, 1) },
                { key: "eng", label: t.analytics.thEngagement, align: "end", render: (p) => <span className="g4-muted">{pct(p.engagement)}</span> },
                { key: "ret", label: t.analytics.thAvgDur, align: "end", render: (p) => <span className="g4-muted">{seconds(p.retention)}</span> },
              ]}
            />
          </Section>

          <p className="g4-note tnum">{t.analytics.note}</p>
        </>
      )}
    </div>
  );
}
