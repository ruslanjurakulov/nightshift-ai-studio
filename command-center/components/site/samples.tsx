import silkroad from "@/components/site/samples/silkroad.webp";
import library from "@/components/site/samples/library.webp";
import moon from "@/components/site/samples/moon.webp";
import nightmarket from "@/components/site/samples/nightmarket.webp";
import valley from "@/components/site/samples/valley.webp";
import lighthouse from "@/components/site/samples/lighthouse.webp";
import { CLIPS, type ClipId } from "@/components/site/clip-assets";

/**
 * The example frames on the public pages: six AI-generated stills, made on
 * 2026-10-05 for demonstration (see docs/design/SITE_ENGAGE.md for their
 * provenance). They stand in where a finished result would be, and every place
 * that shows one says "Example" next to it; none is output of a real account,
 * a customer's work or a claim about what the product produces.
 *
 * Imported statically, so each is a hashed file served from this origin
 * (img-src 'self' already allows it) with its real width and height.
 */
export const SAMPLES = { silkroad, library, moon, nightmarket, valley, lighthouse } as const;
export type SampleId = keyof typeof SAMPLES;

/**
 * The clips: slow camera moves (a push-in and a drift) over three of the stills, 8 seconds, seamless, no sound
 * (scripts/render-site-clips.py). Two renditions of each: 1280 x 720 (250 to 410 KB) for a screen of 860 px or more,
 * and 640 x 360 (75 to 125 KB) for a phone, each in MP4 and WebM. Frame 0 of every clip is its still, which is also the
 * poster. They are the stills, moved, and are labelled as such wherever they play.
 */
export { CLIPS, type ClipId };

/**
 * One example frame as an <img> that fills its aspect-ratio box (the box, not
 * the picture, decides the layout, so nothing shifts when it loads). Lazy by
 * default; the one on the first screen is eager (the hero card). `alt` is empty when
 * the surrounding picture is hidden from assistive tech and already described.
 */
export type SampleCrop = "a" | "b" | "c" | "d";

/**
 * `crop` frames the same still differently (a zoomed region, see .nx-art[data-crop] in site-next.css), so the page's
 * six frames do not read as the same picture repeated: the capability examples and the demo's thumbnail are crops,
 * the hero and the gallery are the whole frames.
 */
export function SampleImg({ id, alt = "", className, eager = false, crop, position }: { id: SampleId; alt?: string; className?: string; eager?: boolean; crop?: SampleCrop; position?: string }) {
  const s = SAMPLES[id];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={s.src} width={s.width} height={s.height} alt={alt} className={className} loading={eager ? "eager" : "lazy"} decoding="async" data-sample={id} data-crop={crop} style={position ? { objectPosition: position } : undefined} {...(eager ? { fetchPriority: "high" as const } : {})} />
  );
}

/**
 * THE MEDIA SLOTS: which still goes where. Every page asks for a slot by name (<SlotImg slot="hero" />), never for a
 * file, so swapping a picture, or putting a new one in a place, is one line here. At most one still per section, and a
 * page uses a different scene in each slot, and no scene twice on one page: where a place would repeat one, the site draws
 * (components/site/BrandArt.tsx) or shows the product itself instead of a recoloured copy.
 *
 * To add a still: put the WebP in ./samples/ (900 px wide, under 60 KB), import it above and add it to SAMPLES, give it
 * an alt in lib/i18n/site/{en,ru,uz}.ts (site.samples.alts), then point a slot at it. Nothing else changes.
 */
export const SLOTS = {
  /** The landing's first screen (the chat card). */
  hero: { id: "silkroad", clip: "silkroad" },
  /** The landing's three showcases. */
  "show.video": { id: "library", clip: "library" },
  "show.studio": { id: "valley", clip: "valley" },
  "show.approvals": { id: "moon" },
  /** The chat card on /pricing. (/mcp, /solutions, /login and /signup show drawn art and product pictures, not stills.) */
  "pricing.card": { id: "nightmarket" },
} as const satisfies Record<string, { id: SampleId; crop?: SampleCrop; position?: string; clip?: ClipId }>;
export type SlotId = keyof typeof SLOTS;

/** A slot's still. `alt` is the description for where the picture stands alone; empty where it is decorative. */
export function SlotImg({ slot, alt = "", className, eager = false }: { slot: SlotId; alt?: string; className?: string; eager?: boolean }) {
  const s: { id: SampleId; crop?: SampleCrop; position?: string } = SLOTS[slot];
  return <SampleImg id={s.id} alt={alt} className={className} eager={eager} crop={s.crop} position={s.position} />;
}

/** The description of a slot's still, from the dictionary's six. */
export function slotAlt(alts: Record<SampleId, string>, slot: SlotId): string {
  return alts[SLOTS[slot].id];
}

/** The clip a slot plays, if it has one. */
export function slotClip(slot: SlotId): ClipId | null {
  const s: { id: SampleId; clip?: ClipId } = SLOTS[slot];
  return s.clip ?? null;
}
