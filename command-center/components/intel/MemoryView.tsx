"use client";

import { relativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import type { Memory, MemoryKind, Opportunity, OpportunityKind } from "@/lib/memory";
import { ConfidenceBadge, useMetricLabel } from "@/components/intel/Badges";
import { EmptyState, Panel } from "@/components/ui";

const MEM_KEY: Record<MemoryKind, keyof Dictionary["intel"]> = {
  topic_outperforms: "memOutperforms",
  topic_underperforms: "memUnderperforms",
  metric_consistent_up: "memConsistentUp",
  metric_consistent_down: "memConsistentDown",
};

const OPP_KEY: Record<OpportunityKind, keyof Dictionary["intel"]> = {
  topic_outperforming: "oppOutperforming",
  topic_declining: "oppDeclining",
  audience_demand: "oppDemand",
};
const OPP_ACTION: Record<OpportunityKind, keyof Dictionary["intel"]> = {
  topic_outperforming: "oppActionMore",
  topic_declining: "oppActionLess",
  audience_demand: "oppActionCover",
};

/** Nightshift Memory and Opportunities. Both lists are empty until real evidence
 *  exists — there is no seeded or illustrative content. */
export function MemoryView({
  memories,
  opportunities,
}: {
  memories: Memory[];
  opportunities: Opportunity[];
}) {
  const { t } = useI18n();
  const metricLabel = useMetricLabel();

  return (
    <div className="flex flex-col gap-4">
      <Panel title={t.intel.memoryTitle}>
        {memories.length === 0 ? (
          <EmptyState>{t.intel.noMemories}</EmptyState>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {memories.map((m) => (
              <li key={m.id} className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 text-sm text-[var(--color-fg)]">
                    {fmt(String(t.intel[MEM_KEY[m.kind]]), {
                      topic: m.topic,
                      metric: m.metric ? metricLabel(m.metric).toLowerCase() : "",
                    })}
                  </p>
                  <ConfidenceBadge confidence={m.confidence} />
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 tnum text-xs text-[var(--color-muted)]">
                  <span>
                    {t.intel.memEvidence}:{" "}
                    {m.kind === "topic_outperforms" || m.kind === "topic_underperforms"
                      ? fmt(t.intel.memVideos, { n: m.evidenceCount })
                      : fmt(t.intel.memSignals, { n: m.evidenceCount })}
                  </span>
                  {m.score != null && <span>{t.intel.decScore}: {m.score.toFixed(0)}</span>}
                  {m.updatedAt && <span>{t.intel.memUpdated}: {relativeTime(m.updatedAt)}</span>}
                  <span>{t.intel.memSources}: {m.sources.join(", ")}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={t.intel.oppTitle}>
        {opportunities.length === 0 ? (
          <EmptyState>{t.intel.noOpportunities}</EmptyState>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {opportunities.map((o) => (
              <li key={o.id} className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 text-sm text-[var(--color-fg)]">
                    {fmt(String(t.intel[OPP_KEY[o.kind]]), { subject: o.subject })}
                  </p>
                  <ConfidenceBadge confidence={o.confidence} />
                </div>
                <p className="tnum text-xs text-[var(--color-primary)]">
                  {t.intel.oppAction}: {String(t.intel[OPP_ACTION[o.kind]])}
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 tnum text-xs text-[var(--color-muted)]">
                  <span>{t.intel.oppEvidence}: {o.evidenceCount}</span>
                  {o.score != null && <span>{t.intel.decScore}: {o.score.toFixed(0)}</span>}
                  {o.ts && <span>{relativeTime(o.ts)}</span>}
                  <span>{t.intel.memSources}: {o.sources.join(", ")}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Honest foundations: the backend records neither experiments nor enough
          history for predictions, so both say so instead of showing anything. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={t.intel.experimentsTitle}>
          <EmptyState>{t.intel.experimentsNotConfigured}</EmptyState>
        </Panel>
        <Panel title={t.intel.predictionTitle}>
          <EmptyState>{t.intel.predictionInsufficient}</EmptyState>
        </Panel>
      </div>
    </div>
  );
}
