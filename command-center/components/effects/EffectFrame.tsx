"use client";

import type { CSSProperties } from "react";
import type { Effect } from "@/lib/effects/catalog";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { EffectArt } from "@/components/effects/EffectArt";
import { effectSample } from "@/components/effects/effect-sample";

export { effectSample };

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
