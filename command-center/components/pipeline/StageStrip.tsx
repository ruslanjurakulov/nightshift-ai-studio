"use client";

import { timeOfDay } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";

export type StageState = "WAITING" | "COMPLETED" | "RUNNING" | "FAILED";

export interface StageView {
  key: string;
  label: string;
  state: StageState;
  ts: string | null;
}

const STATE_TONE: Record<StageState, LampTone> = {
  WAITING: "idle",
  COMPLETED: "ok",
  RUNNING: "run",
  FAILED: "fail",
};

/** The state in words, from the legend's own copy. */
function useStateWords(): Record<StageState, string> {
  const { t } = useI18n();
  return {
    WAITING: t.pipeline.legendWaiting,
    RUNNING: t.pipeline.legendRunning,
    COMPLETED: t.pipeline.legendCompleted,
    FAILED: t.pipeline.legendFailed,
  };
}

/** One stage lamp + the rundown line into the next stage. The state word is read aloud; the lamp is never the only signal. */
function StageNode({ stage, last, words }: { stage: StageView; last: boolean; words: Record<StageState, string> }) {
  const filled = stage.state !== "WAITING";
  return (
    <li className="flex min-w-0 flex-1 items-start">
      <div className="flex min-w-0 flex-col items-center gap-1">
        <StatusLamp tone={STATE_TONE[stage.state]} label={words[stage.state]} live={stage.state === "RUNNING"} hideLabel size="md" />
        <span className="tnum text-center text-xs leading-tight" style={{ color: filled ? "var(--color-fg)" : "var(--color-muted)" }}>
          {stage.label}
        </span>
        <span className="ns-tc text-center text-xs text-[var(--color-muted)]">
          {stage.ts ? timeOfDay(stage.ts) : "—"}
        </span>
      </div>
      {!last && (
        <span
          aria-hidden
          className="mt-[9px] h-px flex-1"
          style={{ background: filled ? "var(--ns-rule-strong)" : "var(--color-border)" }}
        />
      )}
    </li>
  );
}

export function StageStrip({ stages }: { stages: StageView[] }) {
  const words = useStateWords();
  return (
    <ol className="flex items-start gap-1">
      {stages.map((s, i) => (
        <StageNode key={s.key} stage={s} last={i === stages.length - 1} words={words} />
      ))}
    </ol>
  );
}

export function StageLegend() {
  const words = useStateWords();
  const order: StageState[] = ["WAITING", "RUNNING", "COMPLETED", "FAILED"];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {order.map((state) => (
        <StatusLamp key={state} tone={STATE_TONE[state]} label={words[state]} />
      ))}
    </div>
  );
}
