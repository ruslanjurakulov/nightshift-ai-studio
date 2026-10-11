"use client";

import { AnimatedNumber } from "@/components/AnimatedNumber";
import { useI18n } from "@/lib/i18n/context";
import "@/app/(app)/app-pages-g5.css";

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
    { label: t.ops.missionPublished, value: publishedToday, tone: undefined },
    { label: t.ops.missionAnalytics, value: analyticsToday, tone: undefined },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="g5-figs" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        {rows.map((r) => (
          <div key={r.label}>
            <div className="g5-k">{r.label}</div>
            {r.value === null ? (
              <div className="g5-fig-v" style={{ color: "var(--color-muted)" }}>
                {t.common.unknown}
              </div>
            ) : (
              <div className="g5-fig-v" style={{ color: r.tone }}>
                <AnimatedNumber value={r.value} />
              </div>
            )}
          </div>
        ))}
      </div>
      <ul className="g5-tiles">
        <li className="g5-tile">
          <span className="g5-tile-name">{t.ops.missionLearning}</span>
          <span className="g5-v" style={{ color: learningActive ? "var(--color-ok)" : "var(--color-muted)" }}>
            {learningToday === null ? t.common.unknown : learningActive ? t.ops.missionActive : t.ops.missionIdle}
          </span>
        </li>
      </ul>
      <p className="g5-note">
        {t.ops.missionToday} · {t.ops.missionTargetNa}
      </p>
    </div>
  );
}
