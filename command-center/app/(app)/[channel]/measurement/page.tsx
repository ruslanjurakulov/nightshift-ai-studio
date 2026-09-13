import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { StatCard, Panel, EmptyState, StatusPill } from "@/components/ui";
import { num, relativeTime } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { getChannelSelection } from "@/lib/channels-server";
import { scopeQuery, inSelection } from "@/lib/channels";
import { fmt } from "@/lib/i18n";
import {
  summariseCosts,
  variantPerformance,
  aggregateRetention,
  MIN_PER_VARIANT,
  MIN_LIFT,
  MIN_CURVES,
  HOOK_RATIO,
} from "@/lib/measurement";
import { RetentionCurveChart } from "@/components/measure/RetentionCurveChart";
import type {
  MetricsSnapshotRow,
  RetentionPointRow,
  SystemEventRow,
  VideoCostRow,
  VideoRow,
} from "@/lib/types";

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
  const selection = await getChannelSelection();

  const supabase = await createClient();
  let costs: VideoCostRow[] = [];
  let videos: VideoRow[] = [];
  let snapshots: MetricsSnapshotRow[] = [];
  let retention: RetentionPointRow[] = [];
  let gateEvents: SystemEventRow[] = [];
  let dbHealthy = true;

  if (supabase) {
    const [cost, vid, snap, ret, ev] = await Promise.all([
      scopeQuery(supabase.from("video_costs").select("*"), selection)
        .order("recorded_at", { ascending: false })
        .limit(2000),
      scopeQuery(supabase.from("videos").select("*"), selection)
        .order("published_at", { ascending: false })
        .limit(500),
      // Snapshots carry no channel_id — they are scoped by the videos they join to.
      supabase.from("metrics_snapshots").select("*").limit(5000),
      supabase
        .from("retention_points")
        .select("*")
        .order("measured_date", { ascending: true })
        .limit(5000),
      scopeQuery(supabase.from("system_events").select("*"), selection, { nullIsGlobal: true })
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

  // Retention rows have no channel of their own — they belong to the video, so
  // the channel scope is applied by keeping only this selection's videos.
  const scopedIds = new Set(
    videos.filter((v) => inSelection(v.channel_id, selection)).map((v) => v.video_id),
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

  return (
    <div className="rhythm stagger-enter">
      <div>
        <h1 className="t-hero">{t.measure.title}</h1>
        <p className="t-lead mt-4">{t.measure.subtitle}</p>
      </div>

      {!dbHealthy ? (
        <Panel title={t.measure.costTitle}>
          <EmptyState>{t.measure.readErr}</EmptyState>
        </Panel>
      ) : (
        <>
          {/* ---------------------------------------------------------- cost */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label={t.measure.totalCost}
              value={usd(cost.totalUsd)}
              tone={cost.totalUsd === null ? "idle" : "ok"}
              sub={fmt(t.measure.ofMeasured, { n: num(cost.measuredVideos) })}
            />
            <StatCard label={t.measure.meanCost} value={usd(cost.meanUsd)} />
            <StatCard label={t.measure.pricedVideos} value={num(cost.pricedVideos)} />
            <StatCard label={t.measure.measuredVideos} value={num(cost.measuredVideos)} />
          </div>

          {cost.unpricedUnits.length > 0 && (
            <Panel title={t.measure.unpricedTitle}>
              <div className="flex flex-col gap-3 px-4 py-3">
                <div className="flex flex-wrap gap-2">
                  {cost.unpricedUnits.map((unit) => (
                    <code
                      key={unit}
                      className="mono rounded border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 text-[11px] text-[var(--color-warn)]"
                    >
                      CHRONOS_PRICE_{unit.toUpperCase()}
                    </code>
                  ))}
                </div>
                <p className="text-xs leading-relaxed text-[var(--color-muted)]">
                  {t.measure.unpricedHint}
                </p>
              </div>
            </Panel>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
            <Panel title={t.measure.costTitle}>
              {cost.videos.length === 0 ? (
                <EmptyState>{t.measure.costEmpty}</EmptyState>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--color-border)] text-left text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                        <th className="px-4 py-2 font-semibold">{t.measure.thVideo}</th>
                        <th className="px-4 py-2 text-right font-semibold">{t.measure.thCost}</th>
                        <th className="px-4 py-2 text-right font-semibold">{t.measure.thEntries}</th>
                        <th className="px-4 py-2 text-right font-semibold">{t.measure.thRecorded}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cost.videos.slice(0, 20).map((v) => (
                        <tr
                          key={v.video_id ?? v.slug ?? v.recordedAt}
                          className="border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-panel-2)]"
                        >
                          <td className="px-4 py-2 text-[var(--color-fg)]">
                            {(v.video_id && titleOf.get(v.video_id)) ?? v.slug ?? t.common.dash}
                          </td>
                          <td className="mono px-4 py-2 text-right tabular-nums">
                            {v.usd === null ? (
                              <span className="text-[var(--color-muted)]">
                                {t.measure.unknownCost}
                              </span>
                            ) : (
                              <span className="text-[var(--color-fg)]">{usd(v.usd)}</span>
                            )}
                          </td>
                          <td className="mono px-4 py-2 text-right tabular-nums text-[var(--color-muted)]">
                            {num(v.entries)}
                          </td>
                          <td className="mono px-4 py-2 text-right text-[11px] text-[var(--color-muted)]">
                            {relativeTime(v.recordedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel title={t.measure.quantitiesTitle}>
              {Object.keys(cost.quantityByUnit).length === 0 ? (
                <EmptyState>{t.measure.costEmpty}</EmptyState>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {Object.entries(cost.quantityByUnit)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([unit, quantity]) => (
                      <li key={unit} className="flex items-baseline gap-3 px-4 py-2.5">
                        {/* Unit names are schema identifiers, so they are not translated. */}
                        <span className="mono min-w-0 flex-1 truncate text-xs text-[var(--color-muted)]">
                          {unit}
                        </span>
                        <span className="mono shrink-0 text-sm tabular-nums text-[var(--color-fg)]">
                          {num(Math.round(quantity))}
                        </span>
                      </li>
                    ))}
                </ul>
              )}
            </Panel>
          </div>

          {/* ------------------------------------------------------------ A/B */}
          <Panel title={t.measure.abTitle}>
            <div className="flex flex-col gap-4 px-4 py-4">
              <p className="text-xs leading-relaxed text-[var(--color-muted)]">
                {t.measure.abSubtitle}
              </p>

              {ab.arms.every((arm) => arm.videos === 0) ? (
                <EmptyState>{t.measure.abEmpty}</EmptyState>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {ab.arms.map((arm) => {
                      const isWinner = ab.winner === arm.variant;
                      const label =
                        arm.variant === "A"
                          ? t.measure.variantA
                          : arm.variant === "B"
                            ? t.measure.variantB
                            : fmt(t.measure.variantN, { v: arm.variant });
                      return (
                        <div
                          key={arm.variant}
                          className="rounded-lg border p-4"
                          style={{
                            borderColor: isWinner
                              ? "var(--color-ok)"
                              : "var(--color-border)",
                            background: "var(--color-panel-2)",
                          }}
                        >
                          <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                            {label}
                          </div>
                          <div
                            className="mono mt-1 text-2xl font-semibold tabular-nums"
                            style={{ color: isWinner ? "var(--color-ok)" : "var(--color-fg)" }}
                          >
                            {pct(arm.meanCtr, 2)}
                          </div>
                          <div className="mono mt-1 text-[11px] text-[var(--color-muted)]">
                            {num(arm.videos)} {t.measure.abVideos} · {num(arm.impressions)}{" "}
                            {t.measure.impressionsLabel}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <StatusPill
                      tone={ab.winner ? "ok" : "idle"}
                      label={
                        ab.winner
                          ? fmt(t.measure.winnerIs, { variant: ab.winner })
                          : t.measure.noVerdict
                      }
                    />
                    <span className="text-xs text-[var(--color-muted)]">{abReason}</span>
                  </div>
                </>
              )}
            </div>
          </Panel>

          {/* ------------------------------------------------------ retention */}
          <Panel title={t.measure.retentionTitle}>
            <div className="flex flex-col gap-4 px-4 py-4">
              <p className="text-xs leading-relaxed text-[var(--color-muted)]">
                {t.measure.retentionSubtitle}
              </p>

              {curve.points.length === 0 ? (
                <EmptyState>{t.measure.retentionEmpty}</EmptyState>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <StatCard
                      label={t.measure.hookRetention}
                      value={pct(curve.hookRetention, 0)}
                      tone={
                        curve.hookRetention !== null && curve.hookRetention < 0.7 ? "warn" : "ok"
                      }
                      sub={fmt(t.measure.hookWindow, { pct: pct(HOOK_RATIO, 0) })}
                    />
                    <StatCard label={t.measure.cliffAt} value={pct(curve.cliffAt, 0)} />
                    <StatCard label={t.measure.cliffDrop} value={pct(curve.cliffDrop, 0)} />
                    <StatCard label={t.measure.curveVideos} value={num(curve.videos)} />
                  </div>

                  <RetentionCurveChart
                    points={curve.points}
                    cliffAt={curve.cliffAt}
                    hookRatio={HOOK_RATIO}
                  />

                  {!curve.enough && (
                    <p className="text-xs text-[var(--color-warn)]">
                      {fmt(t.measure.retentionThin, {
                        min: String(MIN_CURVES),
                        n: String(curve.videos),
                      })}
                    </p>
                  )}
                  {curve.cliffAt === null && (
                    <p className="text-xs text-[var(--color-muted)]">{t.measure.noCliff}</p>
                  )}
                </>
              )}
            </div>
          </Panel>

          {/* ----------------------------------------------------------- gate */}
          <Panel title={t.measure.gateTitle}>
            <div className="px-4 pt-3">
              <p className="text-xs leading-relaxed text-[var(--color-muted)]">
                {t.measure.gateSubtitle}
              </p>
            </div>
            {gateEvents.length === 0 ? (
              <EmptyState>{t.measure.gateEmpty}</EmptyState>
            ) : (
              <ul className="mt-2 divide-y divide-[var(--color-border)]">
                {gateEvents.map((e) => {
                  const blocked = e.event === "publish.blocked";
                  // Reasons are the gate's own strings (see publish_gate.to_metadata);
                  // no script or claim text is ever carried in an event.
                  const reasons = [
                    ...((e.metadata?.blocks as string[] | undefined) ?? []),
                    ...((e.metadata?.warnings as string[] | undefined) ?? []),
                  ];
                  return (
                    <li key={e.event_key} className="flex items-start gap-3 px-4 py-3">
                      <StatusPill
                        tone={blocked ? "fail" : "ok"}
                        label={blocked ? t.measure.gateBlocked : t.measure.gateAllowed}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="mono text-[11px] text-[var(--color-muted)]">
                          {relativeTime(e.ts)}
                          {e.channel_id ? ` · ${e.channel_id}` : ""}
                        </div>
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {reasons.length === 0 ? (
                            <li className="text-xs text-[var(--color-muted)]">{t.common.dash}</li>
                          ) : (
                            reasons.map((reason, i) => (
                              <li key={i} className="text-xs text-[var(--color-fg)]">
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
            <div className="px-4 py-3">
              <p className="mono text-[10px] text-[var(--color-muted)]">{t.measure.gateNote}</p>
            </div>
          </Panel>

          <p className="mono text-[10px] text-[var(--color-muted)]">{t.measure.note}</p>
        </>
      )}
    </div>
  );
}
