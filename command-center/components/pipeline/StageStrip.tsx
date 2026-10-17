"use client";

import { ownerTimeOfDay } from "@/lib/format";
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

/**
 * One stage: its number on the rundown (edge print, amber), the lamp on the rail
 * and the time it reached that state. The state word is read aloud; the lamp is
 * never the only signal. On a phone the rail stands up and each stage is a row.
 */
function StageNode({ stage, index, words }: { stage: StageView; index: number; words: Record<StageState, string> }) {
  return (
    <li className="g3-stage" data-state={stage.state.toLowerCase()}>
      <span className="g3-stage-no ns-tc" aria-hidden>
        {String(index + 1).padStart(2, "0")}
      </span>
      <span className="g3-stage-lamp">
        <StatusLamp tone={STATE_TONE[stage.state]} label={words[stage.state]} live={stage.state === "RUNNING"} hideLabel size="md" />
      </span>
      <span className="g3-stage-name">{stage.label}</span>
      <span className="g3-stage-time ns-tc">{stage.ts ? ownerTimeOfDay(stage.ts) : "\u2014"}</span>
    </li>
  );
}

export function StageStrip({ stages }: { stages: StageView[] }) {
  const words = useStateWords();
  return (
    <div className="g3-stages">
      <ol className="g3-stage-list">
        {stages.map((s, i) => (
          <StageNode key={s.key} stage={s} index={i} words={words} />
        ))}
      </ol>
    </div>
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
