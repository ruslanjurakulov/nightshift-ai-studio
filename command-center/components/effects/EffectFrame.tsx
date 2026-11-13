"use client";

import type { CSSProperties } from "react";
import { isEffectPrompt, type Effect } from "@/lib/effects/catalog";
import { SHOWCASE_ENTRIES, type ShowcaseEntry, type ShowcaseFiles } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { EffectArt } from "@/components/effects/EffectArt";

/**
 * An effect's real sample: the showcase entry its `previewJobId` names, only when that entry is in lib/site/showcase.json (the
 * export checked it was the operator's own completed job, byte for byte), its files are in the repository, and it IS this
 * effect's output: a clip from the effect's tool, by one of the effect's models, given exactly the effect's words (with a subject
 * in the slot). Anything less is no sample, and the card draws its placeholder: a preview is never borrowed from another job.
 */
export function effectSample(
  effect: Pick<Effect, "previewJobId" | "capability" | "models" | "prompt">,
  entries: readonly ShowcaseEntry[] = SHOWCASE_ENTRIES,
  files: Readonly<Record<string, ShowcaseFiles>> = SHOWCASE_FILES,
): { entry: ShowcaseEntry; files: ShowcaseFiles } | null {
  if (!effect.previewJobId) return null;
  const entry = entries.find((e) => e.jobId === effect.previewJobId);
  const f = files[effect.previewJobId];
  if (!entry || !f || entry.kind !== "video" || !f.clip) return null;
  if (entry.capability !== effect.capability || !effect.models.includes(entry.modelId) || !isEffectPrompt(effect, entry.prompt)) return null;
  return { entry, files: f };
}

const RATIO: Record<Effect["aspect"], string> = { "16:9": "16 / 9", "9:16": "9 / 16", "1:1": "1 / 1" };

/**
 * The card's picture: the sample's first frame with its loop (components/site/LoopClip rules: in view only, one at a time, never
 * under reduced motion or Save-Data, the page's pause switch), or the drawing. The badge says which one it is, in words.
 */
export function EffectFrame({
  effect,
  label,
  className = "fx-frame",
  sample = effectSample(effect),
}: {
  effect: Effect;
  /** `noSample` or `sample` from the dictionary, chosen by the caller from the same `sample` it passes. */
  label: { noSample: string; sample: string };
  className?: string;
  sample?: ReturnType<typeof effectSample>;
}) {
  const style: CSSProperties = { aspectRatio: sample ? `${sample.entry.width} / ${sample.entry.height}` : RATIO[effect.aspect] };
  return (
    <div className={className} style={style} data-sample={sample ? sample.entry.jobId : undefined}>
      {sample ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sample.files.posterSm} width={sample.entry.width} height={sample.entry.height} alt="" loading="lazy" decoding="async" />
          {sample.files.clip && <ShowcaseClip jobId={sample.entry.jobId} />}
        </>
      ) : (
        <EffectArt motif={effect.motif} hues={effect.hues} />
      )}
      <span className="fx-badge">{sample ? label.sample : label.noSample}</span>
    </div>
  );
}
