/**
 * The public site's AI-generated pictures, and which one stands where. They are NOT stock photographs (those are lib/site/media.ts,
 * with a photographer's credit each) and NOT screenshots of the product: they are renders made for Nightshift and used as
 * decoration, and the page says so (lib/i18n/site/*.ts, site.credits, site.try.thumbArtNote; the thumbnail's alt says "AI-generated
 * image"). The files are components/site/art/NAME.webp, derivatives only (scripts/make-site-art.py): the PNG originals are not in
 * the repository.
 *
 * Kept free of image imports (the files are imported in components/site/art.tsx), so the tests can read it.
 */

/** The hero's backdrop: a dark studio at night whose left 40% is empty, behind the headline. Wide, from 1024 px up. */
export const HERO_ART = "hero-night";
/** The same picture cut to a portrait (the mic, the plants, the curtain) for the phone panel below 1024 px, so a phone never fetches the wide file. */
export const HERO_ART_SM = "hero-night-sm";

/** The sample thumbnail behind the Silk Road example on the landing's plan demo. */
export const THUMB_ART = "thumb-silkroad";

/**
 * The eleven optional picture slots: one per step of "How it works" (a square) and one per tool tile of the capability wall (4:3).
 * No file is configured for them today (the steps are text, the tiles are icons); the slot list is here so that putting a picture
 * in is a small change (components/site/art.tsx, SLOT_ART: import the file, set `src`). `target` is the id of the step in
 * `site.how.simple.steps` or of the tool in `site.studio.tools`; `altKey` is the entry of `site.art.alts` that describes the picture.
 */
export const SLOT_DEFS = [
  { slug: "step-1", kind: "step", target: "topic", w: 800, h: 800, altKey: "step-1" },
  { slug: "step-2", kind: "step", target: "price", w: 800, h: 800, altKey: "step-2" },
  { slug: "step-3", kind: "step", target: "approve", w: 800, h: 800, altKey: "step-3" },
  { slug: "tool-image", kind: "tool", target: "image", w: 800, h: 600, altKey: "tool-image" },
  { slug: "tool-video", kind: "tool", target: "video", w: 800, h: 600, altKey: "tool-video" },
  { slug: "tool-voice", kind: "tool", target: "voice", w: 800, h: 600, altKey: "tool-voice" },
  { slug: "tool-edit", kind: "tool", target: "edit", w: 800, h: 600, altKey: "tool-edit" },
  { slug: "tool-animate", kind: "tool", target: "animate", w: 800, h: 600, altKey: "tool-animate" },
  { slug: "tool-upscale", kind: "tool", target: "upscale", w: 800, h: 600, altKey: "tool-upscale" },
  { slug: "tool-cutout", kind: "tool", target: "cutout", w: 800, h: 600, altKey: "tool-cutout" },
  { slug: "tool-styles", kind: "tool", target: "styles", w: 800, h: 600, altKey: "tool-styles" },
] as const;
export type SlotSlug = (typeof SLOT_DEFS)[number]["slug"];

/** The size of each fixed file, as scripts/make-site-art.py writes it (tests/site-art.test.tsx reads it back from the files): the img carries it so its box is reserved before the file arrives. */
export const ART_SIZE = {
  "hero-night": { width: 1672, height: 941 },
  "hero-night-sm": { width: 630, height: 941 },
  "thumb-silkroad": { width: 960, height: 540 },
} as const;

/** Every picture that has a description in `site.art.alts` (the hero's backdrop is decorative: an empty alt). */
export type ArtId = typeof THUMB_ART | SlotSlug;
export const ART_IDS: ArtId[] = [...SLOT_DEFS.map((d) => d.altKey), THUMB_ART];
