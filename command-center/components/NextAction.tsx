"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import type { PipelineStageKey } from "@/lib/intelligence";

const STAGE_KEY: Record<PipelineStageKey, keyof Dictionary["pipeline"]> = {
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

/**
 * The next expected pipeline stage, inferred strictly from a real in-flight
 * video (the stage after the most recent completed/running one). When nothing
 * is in progress, shows "No action in progress" — never a fabricated schedule.
 */
export function NextAction({
  next,
}: {
  next: { key: PipelineStageKey; after: PipelineStageKey } | null;
}) {
  const { t } = useI18n();

  if (!next) {
    return (
      <div className="flex items-center justify-between gap-3 p-4">
        <div>
          <div className="font-display text-sm font-semibold text-[var(--color-fg)]">{t.ops.nextNone}</div>
          <div className="mono text-[10px] text-[var(--color-muted)]">{t.ops.nextNoneSub}</div>
        </div>
        <span className="mono text-[10px] font-semibold tracking-wider text-[var(--color-muted)]">{t.ops.nextReady}</span>
      </div>
    );
  }

  const stage = String(t.pipeline[STAGE_KEY[next.key]]);
  const after = String(t.pipeline[STAGE_KEY[next.after]]);

  return (
    <div className="flex items-center justify-between gap-3 p-4">
      <div>
        <div className="font-display text-sm font-semibold text-[var(--color-primary)]">
          {fmt(t.ops.nextStage, { s: stage })}
        </div>
        <div className="mono text-[10px] text-[var(--color-muted)]">{fmt(t.ops.nextAfter, { s: after })}</div>
      </div>
      <span className="mono text-[10px] font-semibold tracking-wider text-[var(--color-warn)]">{t.ops.nextWaiting}</span>
    </div>
  );
}
