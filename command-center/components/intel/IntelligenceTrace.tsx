"use client";

import { relativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import type { TraceStep } from "@/lib/decisions";
import type { Dictionary } from "@/lib/i18n";

const LABEL: Record<TraceStep["key"], keyof Dictionary["intel"]> = {
  decision: "trDecision",
  generation: "trGeneration",
  published: "trPublished",
  metrics: "trMetrics",
  signals: "trSignals",
  score: "trScore",
};

/**
 * The end-to-end chain for one video: decision -> generation -> publish ->
 * metrics -> learning signals -> topic score. A step is only lit when a real
 * row or event backs it, so an incomplete chain shows exactly how far the
 * loop actually got.
 */
export function IntelligenceTrace({ steps }: { steps: TraceStep[] }) {
  const { t } = useI18n();

  return (
    <ol className="flex flex-col p-4">
      {steps.map((s, i) => {
        const color = s.done ? "var(--color-primary)" : "var(--color-idle)";
        const last = i === steps.length - 1;
        return (
          <li key={s.key} className="flex items-stretch gap-3">
            <div className="flex flex-col items-center">
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  background: s.done ? color : "transparent",
                  border: `2px solid ${color}`,
                }}
              />
              {!last && (
                <span
                  className="w-[2px] flex-1"
                  style={{ background: s.done ? color : "var(--color-border)", opacity: s.done ? 0.5 : 1, minHeight: 20 }}
                />
              )}
            </div>
            <div className="flex flex-1 flex-wrap items-center justify-between gap-2 pb-3">
              <span className="text-sm" style={{ color: s.done ? "var(--color-fg)" : "var(--color-muted)" }}>
                {String(t.intel[LABEL[s.key]])}
                {s.detail && <span className="tnum ml-2 text-xs text-[var(--color-muted)]">{s.detail}</span>}
              </span>
              <span className="tnum text-xs text-[var(--color-muted)]">
                {s.done ? (s.at ? relativeTime(s.at) : "") : t.intel.trPending}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
