"use client";

import { AnimatedNumber } from "@/components/AnimatedNumber";
import { useI18n } from "@/lib/i18n/context";

/**
 * Today's real activity — published videos, analytics snapshots, and learning
 * signals recorded today (UTC). The backend defines no daily target, so no
 * ratio/percentage is shown; the counts are real and any goal is honestly N/A.
 */
export function DailyMission({
  publishedToday,
  analyticsToday,
  learningToday,
}: {
  /** null = the read behind it failed: shown as unknown, never as 0. */
  publishedToday: number | null;
  analyticsToday: number | null;
  learningToday: number | null;
}) {
  const { t } = useI18n();
  const learningActive = learningToday !== null && learningToday > 0;

  const rows = [
    { label: t.ops.missionPublished, value: publishedToday, tone: "var(--color-primary)" },
    { label: t.ops.missionAnalytics, value: analyticsToday, tone: "var(--color-secondary)" },
  ];

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="grid grid-cols-2 gap-3">
        {rows.map((r) => (
          <div key={r.label} className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">{r.label}</div>
            {r.value === null ? (
              <div className="mono text-2xl font-bold" style={{ color: "var(--color-muted)" }}>
                {t.common.unknown}
              </div>
            ) : (
              <div className="mono text-2xl font-bold tabular-nums" style={{ color: r.tone }}>
                <AnimatedNumber value={r.value} />
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">{t.ops.missionLearning}</span>
        <span
          className="mono text-[11px] font-semibold tracking-wider"
          style={{ color: learningActive ? "var(--color-ok)" : "var(--color-muted)" }}
        >
          {learningToday === null ? t.common.unknown : learningActive ? t.ops.missionActive : t.ops.missionIdle}
        </span>
      </div>
      <p className="mono text-[9px] text-[var(--color-muted)]">
        {t.ops.missionToday} · {t.ops.missionTargetNa}
      </p>
    </div>
  );
}
