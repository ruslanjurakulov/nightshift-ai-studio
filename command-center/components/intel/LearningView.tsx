"use client";

import { relativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { signalMetric, type DecisionSignal } from "@/lib/decisions";
import type { TopicIntel } from "@/lib/memory";
import { ConfidenceBadge, TopicStateBadge, useMetricLabel } from "@/components/intel/Badges";
import { EmptyState, Panel } from "@/components/ui";

function num(v: number | null): string {
  return v == null ? "N/A" : v.toFixed(2);
}

/** Learning signals and topic intelligence — both read straight from the
 *  feedback engine's own output, with no derived claims beyond what it wrote. */
export function LearningView({
  signals,
  topics,
}: {
  signals: DecisionSignal[];
  topics: TopicIntel[];
}) {
  const { t } = useI18n();
  const metricLabel = useMetricLabel();

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t.intel.learningTitle}>
        {signals.length === 0 ? (
          <EmptyState>{t.intel.noSignals}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted)]">
                  <th className="px-4 py-2 font-semibold">{t.intel.sigMetric}</th>
                  <th className="px-4 py-2 font-semibold">{t.intel.sigDirection}</th>
                  <th className="px-4 py-2 font-semibold">{t.intel.sigTopic}</th>
                  <th className="px-4 py-2 text-right font-semibold">{t.intel.sigValue}</th>
                  <th className="px-4 py-2 text-right font-semibold">{t.intel.sigBaseline}</th>
                  <th className="px-4 py-2 font-semibold">{t.intel.sigDetail}</th>
                  <th className="px-4 py-2 font-semibold">{t.intel.sigVideo}</th>
                  <th className="px-4 py-2 font-semibold">{t.intel.sigDate}</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s, i) => (
                  <tr key={`${s.signal}-${s.videoId}-${i}`} className="border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-panel-2)]">
                    <td className="px-4 py-2 text-[var(--color-fg)]">{metricLabel(signalMetric(s.signal))}</td>
                    <td className="px-4 py-2 tnum text-xs" style={{ color: s.direction === "up" ? "var(--color-ok)" : "var(--color-fail)" }}>
                      {s.direction === "up" ? `↑ ${t.intel.dirUp}` : `↓ ${t.intel.dirDown}`}
                    </td>
                    <td className="px-4 py-2 text-[var(--color-muted)]">{s.signal}</td>
                    <td className="px-4 py-2 text-right tnum tabular-nums text-[var(--color-fg)]">{num(s.value)}</td>
                    <td className="px-4 py-2 text-right tnum tabular-nums text-[var(--color-muted)]">{num(s.baseline)}</td>
                    <td className="px-4 py-2 tnum text-xs text-[var(--color-muted)]">{s.detail ?? t.common.dash}</td>
                    <td className="px-4 py-2 mono text-xs text-[var(--color-muted)]">{s.videoId}</td>
                    <td className="px-4 py-2 tnum text-xs text-[var(--color-muted)]">{relativeTime(s.analyzedDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={t.intel.topicIntelTitle}>
        {topics.length === 0 ? (
          <EmptyState>{t.intel.noTopicIntel}</EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted)]">
                    <th className="px-4 py-2 font-semibold">{t.intel.decTopic}</th>
                    <th className="px-4 py-2 text-right font-semibold">{t.intel.decScore}</th>
                    <th className="px-4 py-2 font-semibold">{t.intel.tiState}</th>
                    <th className="px-4 py-2 font-semibold">{t.intel.decConfidence}</th>
                    <th className="px-4 py-2 text-right font-semibold">{t.intel.tiVideos}</th>
                    <th className="px-4 py-2 text-right font-semibold">{t.intel.tiSignals}</th>
                    <th className="px-4 py-2 font-semibold">{t.intel.tiLastUsed}</th>
                  </tr>
                </thead>
                <tbody>
                  {topics.map((ti) => (
                    <tr key={ti.topic} className="border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-panel-2)]">
                      <td className="px-4 py-2 text-[var(--color-fg)]">{ti.topic}</td>
                      <td className="px-4 py-2 text-right tnum font-bold tabular-nums" style={{ color: (ti.score ?? 0) >= 50 ? "var(--color-ok)" : "var(--color-warn)" }}>
                        {ti.score == null ? t.common.na : ti.score.toFixed(0)}
                      </td>
                      <td className="px-4 py-2"><TopicStateBadge state={ti.state} /></td>
                      <td className="px-4 py-2"><ConfidenceBadge confidence={ti.confidence} /></td>
                      <td className="px-4 py-2 text-right tnum tabular-nums text-[var(--color-muted)]">{ti.videosAnalyzed ?? t.common.na}</td>
                      <td className="px-4 py-2 text-right tnum tabular-nums text-[var(--color-muted)]">{ti.signalCount}</td>
                      <td className="px-4 py-2 tnum text-xs text-[var(--color-muted)]">{ti.lastUsed ? relativeTime(ti.lastUsed) : t.common.na}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-[var(--color-border)] px-4 py-2 tnum text-xs text-[var(--color-muted)]">
              {t.intel.trendNote}
            </p>
          </>
        )}
      </Panel>
    </div>
  );
}
