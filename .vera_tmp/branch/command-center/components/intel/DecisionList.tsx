"use client";

import { useId, useState } from "react";
import { relativeTime, ownerTimeOfDay } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import {
  CONFIDENCE_HIGH_EVIDENCE,
  CONFIDENCE_MEDIUM_EVIDENCE,
  CONFIDENCE_MIN_EVIDENCE,
  signalMetric,
  type Decision,
  type DecisionOutcome,
  type LineageRow,
} from "@/lib/decisions";
import { ConfidenceBadge, useMetricLabel } from "@/components/intel/Badges";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";

const OUTCOME_KEY: Record<DecisionOutcome, keyof Dictionary["intel"]> = {
  PUBLISHED: "outcomePublished",
  FAILED: "outcomeFailed",
  IN_PROGRESS: "outcomeInProgress",
  UNKNOWN: "outcomeUnknown",
};
const OUTCOME_TONE: Record<DecisionOutcome, LampTone> = {
  PUBLISHED: "ok",
  FAILED: "fail",
  IN_PROGRESS: "run",
  UNKNOWN: "idle",
};

function num(v: number | null): string {
  return v == null ? "N/A" : v.toFixed(2);
}

/**
 * The decision list. Every field shown comes from a real row; a decision whose
 * topic was never scored shows N/A and says plainly that it cannot be
 * explained, rather than inventing a rationale.
 */
export function DecisionList({
  decisions,
  lineage,
}: {
  decisions: Decision[];
  lineage: Record<string, LineageRow[]>;
}) {
  const { t, locale } = useI18n();
  const metricLabel = useMetricLabel();
  const [open, setOpen] = useState<string | null>(null);
  const uid = useId();

  return (
    <ul className="g3-decs">
      {decisions.map((d, n) => {
        const isOpen = open === d.id;
        const rows = d.topic ? lineage[d.topic] ?? [] : [];
        return (
          <li key={d.id} className="g3-dec">
            <div className="g3-dec-row">
              <span className="g3-edge-no" aria-hidden>{String(n + 1).padStart(2, "0")}</span>
              <div className="g3-dec-main">
                <div className="g3-dec-title">{d.topic ?? t.common.na}</div>
                <div className="g3-sub tnum">
                  {t.intel.decType} · {ownerTimeOfDay(d.ts)} · {relativeTime(d.ts, locale)}
                </div>
              </div>
              <div className="g3-dec-facts">
                <span className="ns-tc g3-dec-score" data-unknown={d.score == null ? "true" : undefined} style={{ color: d.score == null ? "var(--color-muted)" : d.score >= 50 ? "var(--color-ok)" : "var(--color-warn)" }}>
                  {d.score == null ? t.common.na : d.score.toFixed(0)}
                </span>
                <ConfidenceBadge confidence={d.confidence} />
                <StatusLamp tone={OUTCOME_TONE[d.outcome]} label={String(t.intel[OUTCOME_KEY[d.outcome]])} />
              </div>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : d.id)}
                aria-expanded={isOpen}
                aria-controls={`${uid}-${d.id}`}
                className="btn-sky is-quiet pill g3-dec-btn px-4 py-2 text-sm"
              >
                {t.ops.explainWhy}
              </button>
            </div>

            {isOpen && (
              <div id={`${uid}-${d.id}`} className="reveal g3-well">
                {!d.explainable ? (
                  <p className="tnum text-sm text-[var(--color-muted)]">{t.intel.notExplainable}</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {d.reason && (
                      <div>
                        <div className="text-sm text-[var(--color-muted)]">{t.intel.decReason}</div>
                        <div className="text-sm text-[var(--color-fg)]">{d.reason}</div>
                      </div>
                    )}

                    {d.signals.length > 0 && (
                      <div className="overflow-x-auto">
                        <div className="mb-1 text-sm text-[var(--color-muted)]">{t.intel.decSignals}</div>
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-sm text-[var(--color-muted)]">
                              <th className="py-1 pr-3">{t.intel.sigMetric}</th>
                              <th className="py-1 pr-3">{t.intel.sigDirection}</th>
                              <th className="py-1 pr-3 text-right">{t.intel.sigValue}</th>
                              <th className="py-1 pr-3 text-right">{t.intel.sigBaseline}</th>
                              <th className="py-1">{t.intel.sigDetail}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.signals.map((s, i) => (
                              <tr key={`${s.signal}-${s.videoId}-${i}`} className="border-t border-[var(--color-border)]/60">
                                <td className="py-1 pr-3 text-[var(--color-fg)]">{metricLabel(signalMetric(s.signal))}</td>
                                <td className="py-1 pr-3 tnum" style={{ color: s.direction === "up" ? "var(--color-ok)" : "var(--color-fail)" }}>
                                  {s.direction === "up" ? `↑ ${t.intel.dirUp}` : `↓ ${t.intel.dirDown}`}
                                </td>
                                <td className="py-1 pr-3 text-right tnum tabular-nums">{num(s.value)}</td>
                                <td className="py-1 pr-3 text-right tnum tabular-nums text-[var(--color-muted)]">{num(s.baseline)}</td>
                                <td className="py-1 tnum text-[var(--color-muted)]">{s.detail ?? t.common.dash}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {rows.length > 0 && (
                      <div className="overflow-x-auto">
                        <div className="mb-1 text-sm text-[var(--color-muted)]">{t.intel.lineageTitle}</div>
                        <table className="w-full text-sm">
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r.label} className="border-t border-[var(--color-border)]/60">
                                <td className="py-1 pr-3 tnum text-[var(--color-muted)]">{r.label}</td>
                                <td className="py-1 pr-3 text-[var(--color-fg)]">{r.value}</td>
                                <td className="py-1 tnum text-sm text-[var(--color-muted)]">← {r.source}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                <p className="tnum mt-3 text-sm text-[var(--color-muted)]">
                  {t.intel.decId}: {d.id} · {t.intel.outcomeNote}
                </p>
                <p className="tnum mt-1 text-sm text-[var(--color-muted)]">
                  {fmt(t.intel.confHow, {
                    min: CONFIDENCE_MIN_EVIDENCE,
                    med: CONFIDENCE_MEDIUM_EVIDENCE,
                    high: CONFIDENCE_HIGH_EVIDENCE,
                  })}
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
