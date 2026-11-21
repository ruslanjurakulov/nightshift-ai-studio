"use client";

import { useI18n } from "@/lib/i18n/context";
import { PIPELINE_ORDER, type PipelineStageKey } from "@/lib/intelligence";
import type { Dictionary } from "@/lib/i18n";
import "@/app/(app)/app-pages-g5.css";

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

/** A stage is a lamp and its word: done is lit green, running amber, failed red, nothing recorded an unlit ring. */
const LAMP: Record<StageTone, "ok" | "run" | "fail" | "idle"> = { done: "ok", run: "run", fail: "fail", idle: "idle" };

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
    <div className="g5-strip">
      {PIPELINE_ORDER.map((stage) => (
        <span key={stage} className="g5-strip-stage" style={{ color: tones[stage] === "idle" ? "var(--color-muted)" : "var(--color-fg)" }}>
          <span aria-hidden className="ns-lamp" data-tone={LAMP[tones[stage]]} />
          {t.pipeline[LABEL_KEY[stage]]}
        </span>
      ))}
      <span className="g5-strip-end">{right ?? t.dashboard.stripIdle}</span>
    </div>
  );
}
