import type { CSSProperties } from "react";
import type { Dictionary } from "@/lib/i18n";
import { ClipPause } from "@/components/site/ClipPause";
import { LoopClip } from "@/components/site/LoopClip";
import { SAMPLES, SLOTS, SlotImg, slotAlt, slotClip, slotSample, type SlotId } from "@/components/site/samples";
import { creditLine } from "@/lib/site/media";

/**
 * A phone's (and a tablet's) first screen is the picture: the hero's clip, edge to edge behind the pill, the headline and
 * the button, on a veil that is clear over the sky and heavier under the words. It is the same footage the desktop chat
 * card plays (one clip, never two on a page: the card's picture is hidden below 1024 px and this one is hidden above it),
 * its still is the clip's own first frame (the poster), and it carries the same labels as every picture on the site: the
 * "Example" badge, the courtesy credit, and (in the card under it) the sentence that says what the pictures are.
 *
 * The same markup is the header panel of /mcp (slot "mcp.hero", `className` "nx-mcp-bleed", its own framing in `position`):
 * an atmosphere behind the page's words, labelled an example like every picture, and not a picture of the product at work.
 * A Server Component; the clip is the usual LoopClip, so nothing is fetched under reduced motion, Save-Data or a slow link.
 */
export function HeroBleed({ t, slot = "hero", position, className = "nx-hero-bleed" }: { t: Dictionary; slot?: SlotId; position?: string; className?: string }) {
  const sm = t.site.samples;
  const clip = slotClip(slot);
  const sample = slotSample(slot);
  // A phone's panel asks for the wide file (200vw): a still shown larger than its own pixels counts for less in the browser's LCP, and the clip's first frame (not scaled that way) would then be the larger paint and become the page's LCP.
  const sizes = className === "nx-hero-bleed" ? "(min-width: 1024px) 1px, 200vw" : "(min-width: 1024px) 720px, 200vw";
  return (
    <div className={`nx-bleed ${className}`} data-clip={clip ?? undefined} style={position ? ({ "--bleed-pos": position } as CSSProperties) : undefined}>
      <SlotImg slot={slot} alt={slotAlt(sm.alts, slot)} className="nx-art" eager sizes={sizes} />
      {clip && <LoopClip clip={clip} poster={SAMPLES[SLOTS[slot].id].sm} early />}
      <span className="nx-result-badge" data-kind="still">
        {sample.footage ? sm.frameTag : sm.tag}
      </span>
      {clip && (
        <span className="nx-result-badge" data-kind="clip">
          {sm.clipTag}
        </span>
      )}
      <span className="nx-result-credit">{creditLine(sample.id, sm.credit)}</span>
      {clip && <ClipPause label={t.site.fx.pause} />}
    </div>
  );
}
