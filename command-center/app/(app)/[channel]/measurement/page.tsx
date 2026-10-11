import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { StatCard, Panel, EmptyState, StatusPill } from "@/components/ui";
import { DataList } from "@/components/g4/DataList";
import { Figures } from "@/components/g4/Section";
import "../../app-pages-g4.css";
import { num, relativeTime } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelScope } from "@/lib/channels-server";
import { scopeQuery, inSelection } from "@/lib/channels";
import { fmt } from "@/lib/i18n";
import {
  summariseCosts,
  variantPerformance,
  hookPerformance,
  aggregateRetention,
  MIN_PER_VARIANT,
  MIN_LIFT,
  MIN_CURVES,
  HOOK_RATIO,
} from "@/lib/measurement";
import { RetentionCurveChart } from "@/components/measure/RetentionCurveChart";
import { ExperimentStatus } from "@/components/measure/ExperimentStatus";
import { hookExperiment, thumbnailExperiment } from "@/lib/experiments";
import type {
  MetricsSnapshotRow,
  RetentionPointRow,
  SystemEventRow,
  VideoCostRow,
  VideoRow,
} from "@/lib/types";
import { uploadedOnly } from "@/lib/heldVideos";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const GATE_EVENTS = ["publish.blocked", "publish.allowed"];

/** USD with enough places to be useful at fractions of a cent per video. */
function usd(value: number | null): string {
  return value === null ? "N/A" : `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function pct(value: number | null, digits = 1): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(digits)}%`;
}

export default async function MeasurePage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  const scope = await getChannelScope();

  const supabase = await createClient();
  let costs: VideoCostRow[] = [];
  let videos: VideoRow[] = [];
  let snapshots: MetricsSnapshotRow[] = [];
  let retention: RetentionPointRow[] = [];
  let gateEvents: SystemEventRow[] = [];
  let dbHealthy = true;

  if (supabase) {
    const [cost, vid, snap, ret, ev] = await Promise.all([
      scopeQuery(supabase.from("video_costs").select("*"), scope)
        .order("recorded_at", { ascending: false })
        .limit(2000),
      uploadedOnly(scopeQuery(supabase.from("videos").select("*"), scope))
        .order("published_at", { ascending: false })
        .limit(500),
      // Snapshots carry no channel_id — they are scoped by the videos they join to.
      supabase.from("metrics_snapshots").select("*").limit(5000),
      supabase
        .from("retention_points")
        .select("*")
        .order("measured_date", { ascending: true })
        .limit(5000),
      scopeQuery(supabase.from("system_events").select("*"), scope, { nullIsGlobal: true })
        .in("event", GATE_EVENTS)
        .order("ts", { ascending: false })
        .limit(25),
    ]);
    // Migration 0002 may not be applied yet; that reads as an error here rather
    // than as an empty page with no explanation.
    if (cost.error || ret.error) dbHealthy = false;
    costs = (cost.data as VideoCostRow[]) ?? [];
    videos = (vid.data as VideoRow[]) ?? [];
    snapshots = (snap.data as MetricsSnapshotRow[]) ?? [];
    retention = (ret.data as RetentionPointRow[]) ?? [];
    gateEvents = (ev.data as SystemEventRow[]) ?? [];
  }

  const cost = summariseCosts(costs);
  const ab = variantPerformance(videos, snapshots);
  const hook = hookPerformance(videos, snapshots);
  const abExp = thumbnailExperiment(ab);
  const hookExp = hookExperiment(hook);

  // Retention rows have no channel of their own — they belong to the video, so
  // the channel scope is applied by keeping only this selection's videos.
  const scopedIds = new Set(
    videos.filter((v) => inSelection(v.channel_id, scope)).map((v) => v.video_id),
  );
  const curve = aggregateRetention(retention.filter((p) => scopedIds.has(p.video_id)));

  const titleOf = new Map(videos.map((v) => [v.video_id, v.title ?? v.video_id]));

  const abReason =
    ab.reason === "needs_more_videos"
      ? fmt(t.measure.reasonNeedsMore, {
          min: String(MIN_PER_VARIANT),
          a: String(ab.a.videos),
          b: String(ab.b.videos),
        })
      : ab.reason === "no_ctr_measured"
        ? t.measure.reasonNoCtr
        : ab.reason === "zero_ctr"
          ? t.measure.reasonZeroCtr
          : ab.reason === "under_lift_floor"
            ? fmt(t.measure.reasonUnderFloor, {
                lift: pct(ab.lift, 0),
                floor: pct(MIN_LIFT, 0),
              })
            : fmt(t.measure.reasonDecided, {
                variant: ab.winner ?? "",
                lift: pct(ab.lift, 0),
                n: String(ab.arms.reduce((sum, arm) => sum + arm.videos, 0)),
              });

  const hookReason =
    hook.reason === "needs_more_videos"
      ? fmt(t.measure.reasonNeedsMore, {
          min: String(MIN_PER_VARIANT),
          a: String(hook.a.videos),
          b: String(hook.b.videos),
        })
      : hook.reason === "no_retention_measured"
        ? t.measure.hookNoRetention
        : hook.reason === "zero_retention"
          ? t.measure.hookZeroRetention
          : hook.reason === "under_lift_floor"
            ? fmt(t.measure.reasonUnderFloor, { lift: pct(hook.lift, 0), floor: pct(MIN_LIFT, 0) })
            : fmt(t.measure.reasonDecided, {
                variant: hook.winner ?? "",
                lift: pct(hook.lift, 0),
                n: String(hook.a.videos + hook.b.videos),
              });

  const armLabel = (variant: string) =>
    variant === "A" ? t.measure.variantA : variant === "B" ? t.measure.variantB : fmt(t.measure.variantN, { v: variant });

  return (
    <div className="rhythm ns-open g4 stagger-enter">
      <PageHeader icon="measurement" title={t.measure.title} subtitle={t.measure.subtitle} />

      {!dbHealthy ? (
        <Panel title={t.measure.costTitle}>
          <EmptyState>{t.measure.readErr}</EmptyState>
        </Panel>
      ) : (
        <>
          {/* ---------------------------------------------------------- cost: the desk */}
          <section className="ns-desk" aria-label={t.measure.costTitle}>
            <Figures>
              <StatCard
                label={t.measure.totalCost}
                value={usd(cost.totalUsd)}
                sub={fmt(t.measure.ofMeasured, { n: num(cost.measuredVideos) })}
              />
              <StatCard label={t.measure.meanCost} value={usd(cost.meanUsd)} />
              <StatCard label={t.measure.pricedVideos} value={num(cost.pricedVideos)} />
              <StatCard label={t.measure.measuredVideos} value={num(cost.measuredVideos)} />
            </Figures>
          </section>

          {cost.unpricedUnits.length > 0 && (
            <Panel title={t.measure.unpricedTitle}>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {cost.unpricedUnits.map((unit) => (
                    <code
                      key={unit}
                      className="tnum rounded border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 text-sm text-[var(--color-warn)]"
                    >
                      CHRONOS_PRICE_{unit.toUpperCase()}
                    </code>
                  ))}
                </div>
                <p className="g4-note">{t.measure.unpricedHint}</p>
              </div>
            </Panel>
          )}

          <div className="g4-cols" data-wide="left">
            <Panel title={t.measure.costTitle}>
              {cost.videos.length === 0 ? (
                <EmptyState>{t.measure.costEmpty}</EmptyState>
              ) : (
                <DataList
                  caption={t.measure.costTitle}
                  rows={cost.videos.slice(0, 20)}
                  rowKey={(v) => String(v.video_id ?? v.slug ?? v.recordedAt)}
                  columns={[
                    { key: "video", label: t.measure.thVideo, render: (v) => (v.video_id && titleOf.get(v.video_id)) ?? v.slug ?? t.common.dash },
                    {
                      key: "cost",
                      label: t.measure.thCost,
                      align: "end",
                      render: (v) =>
                        v.usd === null ? <span className="g4-muted">{t.measure.unknownCost}</span> : usd(v.usd),
                    },
                    { key: "entries", label: t.measure.thEntries, align: "end", render: (v) => <span className="g4-muted">{num(v.entries)}</span> },
                    { key: "rec", label: t.measure.thRecorded, align: "end", nowrap: true, render: (v) => <span className="g4-muted">{relativeTime(v.recordedAt)}</span> },
                  ]}
                />
              )}
            </Panel>

            <Panel title={t.measure.quantitiesTitle}>
              {Object.keys(cost.quantityByUnit).length === 0 ? (
                <EmptyState>{t.measure.costEmpty}</EmptyState>
              ) : (
                <dl className="g4-kv">
                  {Object.entries(cost.quantityByUnit)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([unit, quantity]) => (
                      <div key={unit}>
                        {/* Unit names are schema identifiers, so they are not translated. */}
                        <dt className="tnum">{unit}</dt>
                        <dd>{num(Math.round(quantity))}</dd>
                      </div>
                    ))}
                </dl>
              )}
            </Panel>
          </div>

          {/* ------------------------------------------------------------ A/B */}
          <Panel title={t.measure.abTitle}>
            <div className="flex flex-col gap-4">
              <p className="g4-note">{t.measure.abSubtitle}</p>

              {ab.arms.every((arm) => arm.videos === 0) ? (
                <EmptyState>{t.measure.abEmpty}</EmptyState>
              ) : (
                <>
                  <div className="g4-arms">
                    {ab.arms.map((arm) => {
                      const isWinner = ab.winner === arm.variant;
                      return (
                        <div key={arm.variant} className="g4-arm" data-leader={isWinner}>
                          <div className="flex flex-wrap items-center gap-3">
                            <span className="t-label">{armLabel(arm.variant)}</span>
                            {isWinner && <StatusPill tone="ok" label={t.measure.armAhead} />}
                          </div>
                          <div className="t-figure tnum">{pct(arm.meanCtr, 2)}</div>
                          <div className="tnum g4-muted g4-small">
                            {num(arm.videos)} {t.measure.abVideos} · {num(arm.impressions)} {t.measure.impressionsLabel}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <ExperimentStatus exp={abExp} reason={abReason} t={t} />
                </>
              )}
            </div>
          </Panel>

          {/* --------------------------------------------- first-30s hook A/B */}
          <Panel title={t.measure.hookTitle}>
            <div className="flex flex-col gap-4">
              <p className="g4-note">{t.measure.hookSubtitle}</p>

              {hook.a.videos === 0 && hook.b.videos === 0 ? (
                <EmptyState>{t.measure.hookEmpty}</EmptyState>
              ) : (
                <>
                  <div className="g4-arms">
                    {[hook.a, hook.b].map((arm) => {
                      const isWinner = hook.winner === arm.variant;
                      return (
                        <div key={arm.variant} className="g4-arm" data-leader={isWinner}>
                          <div className="flex flex-wrap items-center gap-3">
                            <span className="t-label">{arm.variant === "A" ? t.measure.hookA : t.measure.hookB}</span>
                            {isWinner && <StatusPill tone="ok" label={t.measure.armAhead} />}
                          </div>
                          <div className="t-figure tnum">
                            {arm.meanRetention === null ? t.common.na : `${arm.meanRetention.toFixed(1)}s`}
                          </div>
                          <div className="tnum g4-muted g4-small">
                            {num(arm.videos)} {t.measure.abVideos}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <ExperimentStatus exp={hookExp} reason={hookReason} t={t} />
                </>
              )}
            </div>
          </Panel>

          {/* ------------------------------------------------------ retention */}
          <Panel title={t.measure.retentionTitle}>
            <div className="flex flex-col gap-6">
              <p className="g4-note">{t.measure.retentionSubtitle}</p>

              {curve.points.length === 0 ? (
                <EmptyState>{t.measure.retentionEmpty}</EmptyState>
              ) : (
                <>
                  <Figures>
                    <StatCard
                      label={t.measure.hookRetention}
                      value={pct(curve.hookRetention, 0)}
                      tone={curve.hookRetention !== null && curve.hookRetention < 0.7 ? "warn" : "ok"}
                      sub={fmt(t.measure.hookWindow, { pct: pct(HOOK_RATIO, 0) })}
                    />
                    <StatCard label={t.measure.cliffAt} value={pct(curve.cliffAt, 0)} />
                    <StatCard label={t.measure.cliffDrop} value={pct(curve.cliffDrop, 0)} />
                    <StatCard label={t.measure.curveVideos} value={num(curve.videos)} />
                  </Figures>

                  <RetentionCurveChart
                    points={curve.points}
                    cliffAt={curve.cliffAt}
                    hookRatio={HOOK_RATIO}
                    label={t.measure.retentionTitle}
                  />

                  {!curve.enough && (
                    <p className="g4-note" data-tone="warn">
                      {fmt(t.measure.retentionThin, {
                        min: String(MIN_CURVES),
                        n: String(curve.videos),
                      })}
                    </p>
                  )}
                  {curve.cliffAt === null && <p className="g4-note">{t.measure.noCliff}</p>}
                </>
              )}
            </div>
          </Panel>

          {/* ----------------------------------------------------------- gate */}
          <Panel title={t.measure.gateTitle}>
            <p className="g4-note">{t.measure.gateSubtitle}</p>
            {gateEvents.length === 0 ? (
              <EmptyState>{t.measure.gateEmpty}</EmptyState>
            ) : (
              <ul className="g4-kv g4-gate mt-4">
                {gateEvents.map((e) => {
                  const blocked = e.event === "publish.blocked";
                  // Reasons are the gate's own strings (see publish_gate.to_metadata);
                  // no script or claim text is ever carried in an event.
                  const reasons = [
                    ...((e.metadata?.blocks as string[] | undefined) ?? []),
                    ...((e.metadata?.warnings as string[] | undefined) ?? []),
                  ];
                  return (
                    <li key={e.event_key}>
                      <span className="g4-gate-lamp">
                        <StatusPill
                          tone={blocked ? "fail" : "ok"}
                          label={blocked ? t.measure.gateBlocked : t.measure.gateAllowed}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="tnum g4-muted g4-small">
                          {relativeTime(e.ts)}
                          {e.channel_id ? ` · ${e.channel_id}` : ""}
                        </div>
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {reasons.length === 0 ? (
                            <li className="g4-muted g4-small">{t.common.dash}</li>
                          ) : (
                            reasons.map((reason, i) => (
                              <li key={i} className="text-sm text-[var(--color-fg)]">
                                {reason}
                              </li>
                            ))
                          )}
                        </ul>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="g4-note tnum mt-4">{t.measure.gateNote}</p>
          </Panel>

          <p className="g4-note tnum">{t.measure.note}</p>
        </>
      )}
    </div>
  );
}
