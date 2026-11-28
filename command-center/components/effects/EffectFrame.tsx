"use client";

import type { CSSProperties } from "react";
import type { EffectFace } from "@/lib/effects/shared";
import { ShowcaseClip } from "@/components/site/ShowcaseClip";
import { EffectArt } from "@/components/effects/EffectArt";
import { sampleKeepsShape } from "@/components/effects/effect-sample";

const RATIO: Record<EffectFace["aspect"], string> = { "16:9": "16 / 9", "9:16": "9 / 16", "1:1": "1 / 1" };

/**
 * The card's picture: the sample's first frame with its loop (components/site/LoopClip rules: in view only, one at a time, never
 * under reduced motion or Save-Data, the page's pause switch), or the drawing. The badge says which one it is, in words.
 *
 * It takes an effect's face (lib/effects/catalog.ts effectFace): the sample was found on the server, so the effect's models and
 * prompt, which finding it needs, never reach this Client Component.
 */
export function EffectFrame({
  effect,
  label,
  className = "fx-frame",
  badgeId,
}: {
  effect: EffectFace;
  /** `noSample` or `sample` from the dictionary, chosen by the caller from the same `sample` it passes. */
  label: { noSample: string; sample: string };
  className?: string;
  /** An id for the badge, so a card's link can say in its description whether this is a real result or a drawing. */
  badgeId?: string;
}) {
  const sample = effect.sample;
  // A sample of another shape than its effect's is cut to the effect's shape from the centre (effect-sample.ts sampleKeepsShape).
  const own = sample && sampleKeepsShape(effect, sample.entry);
  const style: CSSProperties = { aspectRatio: own ? `${sample.entry.width} / ${sample.entry.height}` : RATIO[effect.aspect] };
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
      <span id={badgeId} className="fx-badge">{sample ? label.sample : label.noSample}</span>
    </div>
  );
}
