"use client";

import { relativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { signalMetric, type DecisionSignal } from "@/lib/decisions";
import type { TopicIntel } from "@/lib/memory";
import { ConfidenceBadge, TopicStateBadge, useMetricLabel } from "@/components/intel/Badges";
import { EmptyState } from "@/components/ui";
import { Section } from "@/components/g4/Section";
import { DataList } from "@/components/g4/DataList";

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
  const { t, locale } = useI18n();
  const metricLabel = useMetricLabel();

  return (
    <div className="g4-stack">
      <Section title={t.intel.learningTitle}>
        {signals.length === 0 ? (
          <EmptyState>{t.intel.noSignals}</EmptyState>
        ) : (
          <DataList
            caption={t.intel.learningTitle}
            rows={signals}
            rowKey={(s, i) => `${s.signal}-${s.videoId}-${i}`}
            columns={[
              { key: "metric", label: t.intel.sigMetric, render: (s) => metricLabel(signalMetric(s.signal)) },
              {
                key: "dir",
                label: t.intel.sigDirection,
                render: (s) => (
                  <span style={{ color: s.direction === "up" ? "var(--color-ok)" : "var(--color-fail)" }}>
                    {s.direction === "up" ? `↑ ${t.intel.dirUp}` : `↓ ${t.intel.dirDown}`}
                  </span>
                ),
              },
              { key: "topic", label: t.intel.sigTopic, render: (s) => <span className="g4-muted">{s.signal}</span> },
              { key: "value", label: t.intel.sigValue, align: "end", render: (s) => num(s.value) },
              { key: "base", label: t.intel.sigBaseline, align: "end", render: (s) => <span className="g4-muted">{num(s.baseline)}</span> },
              { key: "detail", label: t.intel.sigDetail, render: (s) => <span className="g4-muted g4-small">{s.detail ?? t.common.dash}</span> },
              { key: "video", label: t.intel.sigVideo, render: (s) => <span className="mono g4-muted g4-small">{s.videoId}</span> },
              { key: "date", label: t.intel.sigDate, nowrap: true, render: (s) => <span className="g4-muted g4-small">{relativeTime(s.analyzedDate, locale)}</span> },
            ]}
          />
        )}
      </Section>

      <Section title={t.intel.topicIntelTitle}>
        {topics.length === 0 ? (
          <EmptyState>{t.intel.noTopicIntel}</EmptyState>
        ) : (
          <>
            <DataList
              caption={t.intel.topicIntelTitle}
              rows={topics}
              rowKey={(ti) => ti.topic}
              columns={[
                { key: "topic", label: t.intel.decTopic, render: (ti) => ti.topic },
                {
                  key: "score",
                  label: t.intel.decScore,
                  align: "end",
                  render: (ti) => (
                    <span className="font-semibold" style={{ color: ti.score == null ? "var(--color-muted)" : ti.score >= 50 ? "var(--color-ok)" : "var(--color-warn)" }}>
                      {ti.score == null ? t.common.na : ti.score.toFixed(0)}
                    </span>
                  ),
                },
                { key: "state", label: t.intel.tiState, render: (ti) => <TopicStateBadge state={ti.state} /> },
                { key: "conf", label: t.intel.decConfidence, render: (ti) => <ConfidenceBadge confidence={ti.confidence} /> },
                { key: "videos", label: t.intel.tiVideos, align: "end", render: (ti) => <span className="g4-muted">{ti.videosAnalyzed ?? t.common.na}</span> },
                { key: "signals", label: t.intel.tiSignals, align: "end", render: (ti) => <span className="g4-muted">{ti.signalCount}</span> },
                { key: "last", label: t.intel.tiLastUsed, nowrap: true, render: (ti) => <span className="g4-muted g4-small">{ti.lastUsed ? relativeTime(ti.lastUsed, locale) : t.common.na}</span> },
              ]}
            />
            <p className="g4-note tnum mt-4">{t.intel.trendNote}</p>
          </>
        )}
      </Section>
    </div>
  );
}
