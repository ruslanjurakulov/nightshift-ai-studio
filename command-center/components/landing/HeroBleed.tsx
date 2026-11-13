import type { CSSProperties } from "react";
import type { Dictionary } from "@/lib/i18n";
import { ClipPause } from "@/components/site/ClipPause";
import { slotMedia, type SlotId } from "@/components/site/samples";
import { PlaceFill, placeBox } from "@/components/site/PlaceFill";

/**
 * A picture edge to edge behind a page's first words: the /mcp header panel (slot "mcp.hero", `className` "nx-mcp-bleed", its
 * own framing in `position`). It is whatever the slot shows (components/site/samples.tsx slotMedia): one of our generations with
 * its model's credit and "Try this prompt", or the stock fallback with its "Example" badges and its contributor's credit. An
 * atmosphere behind the page's words, never a picture of the product at work. A Server Component; the clip is the usual
 * LoopClip, so nothing is fetched under reduced motion, Save-Data or a slow link.
 */
export function HeroBleed({ t, slot = "hero", position, className = "nx-hero-bleed" }: { t: Dictionary; slot?: SlotId; position?: string; className?: string }) {
  const m = slotMedia(slot);
  const moving = m.kind === "ai" ? m.moving : m.clip !== null;
  // A phone's panel asks for the wide file (200vw): a still shown larger than its own pixels counts for less in the browser's LCP, and the clip's first frame (not scaled that way) would then be the larger paint and become the page's LCP.
  const sizes = className === "nx-hero-bleed" ? "(min-width: 1024px) 1px, 200vw" : "(min-width: 1024px) 720px, 200vw";
  return (
    <div className={`nx-bleed ${className}`} {...placeBox(m)} style={position ? ({ "--bleed-pos": position } as CSSProperties) : undefined}>
      <PlaceFill media={m} s={t.site} eager early sizes={sizes} />
      {moving && <ClipPause label={t.site.fx.pause} />}
    </div>
  );
}
