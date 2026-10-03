"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { FeedbackSignalRow } from "@/lib/types";

/**
 * "Why?" explainability for a learned topic score. Shows the model's real
 * reason string plus the real feedback signals (HIGH_/LOW_ with their metric vs
 * channel baseline) that fed the score. When neither exists, it says so —
 * never an invented justification.
 */
export function ExplainScore({
  score,
  reason,
  signals,
}: {
  score: number;
  reason: string | null;
  signals: FeedbackSignalRow[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hasData = Boolean(reason) || signals.length > 0;

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn-sky is-quiet pill px-3 py-1 text-xs font-light"
      >
        {t.ops.explainWhy}
      </button>

      {open && (
        <div className="drawer-enter absolute right-0 z-40 mt-3 w-72 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 text-left shadow-[var(--shadow-elevated)]">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold text-[var(--color-fg)]">{t.ops.explainTitle}</span>
            <span className="tnum text-sm font-bold tabular-nums" style={{ color: score >= 50 ? "var(--color-ok)" : "var(--color-warn)" }}>
              {score.toFixed(0)}
            </span>
          </div>

          {!hasData ? (
            <p className="tnum text-xs text-[var(--color-muted)]">{t.ops.explainNotEnough}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {reason && (
                <div>
                  <div className="text-xs text-[var(--color-muted)]">{t.ops.explainReason}</div>
                  <div className="text-xs text-[var(--color-fg)]">{reason}</div>
                </div>
              )}
              {signals.length > 0 && (
                <div>
                  <div className="text-xs text-[var(--color-muted)]">{t.ops.explainBasis}</div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {signals.slice(0, 6).map((s, i) => {
                      const up = s.signal?.startsWith("HIGH_");
                      const color = up ? "var(--color-ok)" : s.signal?.startsWith("LOW_") ? "var(--color-fail)" : "var(--color-muted)";
                      return (
                        <li key={`${s.video_id}-${s.signal}-${i}`} className="flex items-center justify-between gap-2">
                          <span className="tnum text-xs font-semibold" style={{ color }}>{s.signal}</span>
                          {s.metric_value != null && (
                            <span className="tnum text-xs text-[var(--color-muted)] tabular-nums">
                              {s.metric_value.toFixed(0)}
                              {s.channel_baseline != null ? ` / ${s.channel_baseline.toFixed(0)}` : ""}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
