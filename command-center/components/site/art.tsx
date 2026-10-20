import heroNight from "@/components/site/art/hero-night.webp";
import heroNightSm from "@/components/site/art/hero-night-sm.webp";
import artStep1 from "@/components/site/art/step-1.webp";
import artStep2 from "@/components/site/art/step-2.webp";
import artStep3 from "@/components/site/art/step-3.webp";
import artToolImage from "@/components/site/art/tool-image.webp";
import artToolVideo from "@/components/site/art/tool-video.webp";
import artToolVoice from "@/components/site/art/tool-voice.webp";
import artToolEdit from "@/components/site/art/tool-edit.webp";
import artToolAnimate from "@/components/site/art/tool-animate.webp";
import artToolUpscale from "@/components/site/art/tool-upscale.webp";
import artToolCutout from "@/components/site/art/tool-cutout.webp";
import artToolStyles from "@/components/site/art/tool-styles.webp";
import thumbSilkroad from "@/components/site/art/thumb-silkroad.webp";
import { ART_SIZE, SLOT_DEFS, type SlotSlug, type THUMB_ART } from "@/lib/site/art";

/**
 * The AI-generated pictures (lib/site/art.ts says which stands where and what they are). Imported statically, like the stock
 * stills in samples.tsx: each is a hashed file served from this origin (img-src 'self' already allows it), with its width and
 * height declared so the box is reserved before the file arrives.
 */
type Img = { src: string } | string;
/** Next hands an imported image over as { src, width, height }; a plain bundler (the test runner's) as the URL. */
const urlOf = (m: Img) => (typeof m === "string" ? m : m.src);

/** The sample thumbnail's background. Lazy: it is not on the first screen. */
export function ArtImg({ id, alt, className }: { id: typeof THUMB_ART; alt: string; className?: string }) {
  const { width, height } = ART_SIZE[id];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={urlOf(thumbSilkroad)} width={width} height={height} alt={alt} className={className} loading="lazy" decoding="async" data-art-id={id} />
  );
}

/**
 * THE SLOTS: the one list of the pictures the steps and the tool tiles can show: transparent-background WebPs (3D objects), one per
 * step of "How it works" (a square) and one per tool tile of the capability wall (4:3). `src` is the imported file, or null: then
 * the step is text and the tile shows its icon, so a slot can be emptied (or one picture swapped) by changing one line here.
 * To replace the pictures: run scripts/make-site-art.py on the new PNGs, and the files land under the same names. If any slot
 * is emptied or filled, the footer's and the wall's wording (`site.credits.lead`, `site.wall.label`, `site.wall.note`, en, ru
 * and uz) says what is AI-made and what is an icon: tests/site-art.test.tsx fails until it agrees, and `site.art.alts` has to
 * describe the real picture.
 */
export interface SlotArt {
  slug: SlotSlug;
  kind: "step" | "tool";
  target: string;
  src: Img | null;
  w: number;
  h: number;
  altKey: SlotSlug;
}
const SLOT_FILES: Record<SlotSlug, Img | null> = {
  "step-1": artStep1,
  "step-2": artStep2,
  "step-3": artStep3,
  "tool-image": artToolImage,
  "tool-video": artToolVideo,
  "tool-voice": artToolVoice,
  "tool-edit": artToolEdit,
  "tool-animate": artToolAnimate,
  "tool-upscale": artToolUpscale,
  "tool-cutout": artToolCutout,
  "tool-styles": artToolStyles,
};
export const SLOT_ART: readonly SlotArt[] = SLOT_DEFS.map((d) => ({ ...d, src: SLOT_FILES[d.slug] }));

/** The configured picture of a step or a tool, or null (then the step is text and the tile an icon). */
export function slotArt(kind: "step" | "tool", target: string): SlotArt | null {
  const s = SLOT_ART.find((x) => x.kind === kind && x.target === target);
  return s && s.src ? s : null;
}

/** A slot's picture, with its own width and height (CSS sizes it; the attributes reserve the aspect ratio). Lazy: neither the steps nor the tiles are on the first screen. */
export function ArtSlotImg({ slot, alt, className }: { slot: SlotArt; alt: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={slot.src ? urlOf(slot.src) : ""} width={slot.w} height={slot.h} alt={alt} className={className} loading="lazy" decoding="async" data-art-id={slot.slug} />
  );
}

/** A 1 x 1 transparent GIF: what a backdrop's img holds where its picture is not wanted (see HeroBackdrop). */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * The hero's backdrop: a dark studio at night whose left 40% is empty, behind the headline. Decorative (an empty alt: assistive tech
 * skips it); the page's words never depend on it, they sit on a dark base and, where the picture is bright, on a scrim of their own
 * (site-next.css, "The hero's backdrop"). It is printed twice and each copy fetches only in its own range of widths:
 *
 * - "wide" (a child of the hero, from 1024 px up): the 1672 px picture across the whole hero;
 * - "phone" (a child of the hero's dark panel, below 1024 px): a 630 px portrait cut of it, sharp at a phone's own pixels.
 *
 * The <source> is the whole trick: an image that is merely `display: none` is still fetched, so the copy that is not wanted holds
 * the blank GIF and never asks for its picture. Eager and high priority (the largest paint of the first screen at every width).
 */
export function HeroBackdrop({ variant }: { variant: "wide" | "phone" }) {
  const wide = variant === "wide";
  const size = ART_SIZE[wide ? "hero-night" : "hero-night-sm"];
  return (
    <picture className={`nx-hero-bg nx-hero-bg-${variant}`}>
      <source media={wide ? "(min-width: 1024px)" : "(max-width: 1023px)"} srcSet={urlOf(wide ? heroNight : heroNightSm)} type="image/webp" />
      <img src={BLANK} width={size.width} height={size.height} alt="" loading="eager" decoding="async" fetchPriority="high" data-art-id={wide ? "hero-night" : "hero-night-sm"} />
    </picture>
  );
}
