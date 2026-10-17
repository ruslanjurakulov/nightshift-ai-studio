"use client";

import { relativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import type { Memory, MemoryKind, Opportunity, OpportunityKind } from "@/lib/memory";
import { useMetricLabel } from "@/components/intel/Badges";
import { StatusLamp } from "@/components/ui/StatusLamp";
import type { Confidence } from "@/lib/decisions";

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

/** Confidence as evidence strength, said as a lamp with its word — never a fabricated percentage. */
function Confidence({ confidence }: { confidence: Confidence | null }) {
  const { t } = useI18n();
  if (!confidence) return <StatusLamp tone="idle" label={String(t.intel.confNone)} />;
  const key = confidence === "HIGH" ? "confHigh" : confidence === "MEDIUM" ? "confMedium" : "confLow";
  return <StatusLamp tone={confidence === "HIGH" ? "ok" : confidence === "MEDIUM" ? "info" : "warn"} label={String(t.intel[key])} />;
}

function None({ children }: { children: string }) {
  return <p className="g2-none">{children}</p>;
}

/** Nightshift Memory and Opportunities. Both lists are empty until real evidence
 *  exists — there is no seeded or illustrative content. */
export function MemoryView({
  memories,
  opportunities,
}: {
  memories: Memory[];
  opportunities: Opportunity[];
}) {
  const { t, locale } = useI18n();
  const metricLabel = useMetricLabel();

  return (
    <div className="rhythm">
      <section className="ns-desk g2-desk" aria-labelledby="memory-learned-title">
        <div className="g2-stack-lg">
          <h2 id="memory-learned-title" className="g2-h2">
            {t.intel.memoryTitle}
          </h2>
          {memories.length === 0 ? (
            <None>{t.intel.noMemories}</None>
          ) : (
            <ul className="g2-rows">
              {memories.map((m, i) => (
                <li key={m.id} className="g2-row">
                  <span aria-hidden className="g2-row-no">{String(i + 1).padStart(2, "0")}</span>
                  <div className="g2-row-main">
                    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                      <p className="g2-statement">
                        {fmt(String(t.intel[MEM_KEY[m.kind]]), {
                          topic: m.topic,
                          metric: m.metric ? metricLabel(m.metric).toLowerCase() : "",
                        })}
                      </p>
                      <Confidence confidence={m.confidence} />
                    </div>
                    <div className="g2-evidence tnum">
                      <span>
                        {t.intel.memEvidence}:{" "}
                        {m.kind === "topic_outperforms" || m.kind === "topic_underperforms"
                          ? fmt(t.intel.memVideos, { n: m.evidenceCount })
                          : fmt(t.intel.memSignals, { n: m.evidenceCount })}
                      </span>
                      {m.score != null && <span>{t.intel.decScore}: {m.score.toFixed(0)}</span>}
                      {m.updatedAt && <span>{t.intel.memUpdated}: {relativeTime(m.updatedAt, locale)}</span>}
                      <span>{t.intel.memSources}: {m.sources.join(", ")}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="g2-section" aria-labelledby="memory-opps-title">
        <h2 id="memory-opps-title" className="g2-h2">
          {t.intel.oppTitle}
        </h2>
        {opportunities.length === 0 ? (
          <None>{t.intel.noOpportunities}</None>
        ) : (
          <ul className="g2-rows">
            {opportunities.map((o, i) => (
              <li key={o.id} className="g2-row">
                <span aria-hidden className="g2-row-no">{String(i + 1).padStart(2, "0")}</span>
                <div className="g2-row-main">
                  <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
                    <p className="g2-statement">{fmt(String(t.intel[OPP_KEY[o.kind]]), { subject: o.subject })}</p>
                    <Confidence confidence={o.confidence} />
                  </div>
                  <p className="g2-action">
                    {t.intel.oppAction}: {String(t.intel[OPP_ACTION[o.kind]])}
                  </p>
                  <div className="g2-evidence tnum">
                    <span>{t.intel.oppEvidence}: {o.evidenceCount}</span>
                    {o.score != null && <span>{t.intel.decScore}: {o.score.toFixed(0)}</span>}
                    {o.ts && <span>{relativeTime(o.ts, locale)}</span>}
                    <span>{t.intel.memSources}: {o.sources.join(", ")}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Honest foundations: the backend records neither experiments nor enough
          history for predictions, so both say so instead of showing anything. */}
      <div className="g2-platforms">
        <section className="g2-platform" aria-labelledby="memory-exp-title">
          <h2 id="memory-exp-title" className="g2-h2">{t.intel.experimentsTitle}</h2>
          <None>{t.intel.experimentsNotConfigured}</None>
        </section>
        <section className="g2-platform" aria-labelledby="memory-pred-title">
          <h2 id="memory-pred-title" className="g2-h2">{t.intel.predictionTitle}</h2>
          <None>{t.intel.predictionInsufficient}</None>
        </section>
      </div>
    </div>
  );
}
