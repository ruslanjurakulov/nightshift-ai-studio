"use client";

import { useI18n } from "@/lib/i18n/context";
import { PIPELINE_ORDER, type PipelineStageKey } from "@/lib/intelligence";
import type { Dictionary } from "@/lib/i18n";

export type StageTone = "done" | "run" | "fail" | "idle";

const LABEL_KEY: Record<PipelineStageKey, keyof Dictionary["pipeline"]> = {
  topic: "sTopic",
  research: "sResearch",
  script: "sScript",
  voice: "sVoice",
  media: "sMedia",
  thumbnail: "sThumbnail",
  render: "sRender",
  upload: "sUpload",
  publish: "sPublish",
};

const TONE_COLOR: Record<StageTone, string> = {
  done: "var(--color-primary)",
  run: "var(--color-warn)",
  fail: "var(--color-fail)",
  // Used for label text, so the idle tone takes muted (idle is for dots).
  idle: "var(--color-muted)",
};

/**
 * The run as one line, the way the approved direction closes its screen: every
 * stage named in order, coloured by what actually happened, and the elapsed
 * figure sitting right.
 *
 * Every tone comes from real events. A stage nothing has been recorded for is
 * "idle" and reads grey — it is not claimed as done, and it is not invented as
 * running.
 */
export function PipelineStrip({
  tones,
  right,
}: {
  tones: Record<PipelineStageKey, StageTone>;
  right?: string | null;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-x-7 gap-y-3 border-t border-[var(--color-border)] pt-6">
      {PIPELINE_ORDER.map((stage) => (
        <span
          key={stage}
          className="text-xs font-medium"
          style={{ color: TONE_COLOR[tones[stage]] }}
        >
          {t.pipeline[LABEL_KEY[stage]]}
        </span>
      ))}
      <span className="tnum ml-auto text-xs text-[var(--color-muted)]">
        {right ?? t.dashboard.stripIdle}
      </span>
    </div>
  );
}
