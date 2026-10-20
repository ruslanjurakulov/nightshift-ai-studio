/**
 * The public site's AI-generated illustrations, and which one stands where. They are NOT stock photographs (those are
 * lib/site/media.ts, with a photographer's credit each) and NOT screenshots of the product: they are renders made for Nightshift
 * and used as decoration, and every place that shows one is worded that way (lib/i18n/site/*.ts, site.art, site.wall and
 * site.credits; the alt text of each says "Illustration" or "AI-generated image"). The files are components/site/art/NAME.webp,
 * derivatives only (scripts/make-site-art.py): the PNG originals are not in the repository.
 *
 * Kept free of image imports (the files are imported in components/site/art.tsx), so the footer and the tests can read it.
 */
export const HERO_ART = "hero-night";

/** The three steps of "How it works", by the step's id in `site.how.simple.steps`. */
export const STEP_ART = { topic: "step-1", price: "step-2", approve: "step-3" } as const;

/** The eight tool tiles of the capability wall, by the tool's id in `site.studio.tools`. They stand for the tool; they are not what it makes. */
export const TOOL_ART = {
  image: "tool-image",
  video: "tool-video",
  voice: "tool-voice",
  edit: "tool-edit",
  animate: "tool-animate",
  upscale: "tool-upscale",
  cutout: "tool-cutout",
  styles: "tool-styles",
} as const;

/** The sample thumbnail behind the Silk Road example on the landing's plan demo. */
export const THUMB_ART = "thumb-silkroad";

/** The size of each file, as scripts/make-site-art.py writes it (tests/site-art.test.tsx reads it back from the files): the <img> carries it so its box is reserved before the file arrives. */
export const ART_SIZE = {
  "hero-night": { width: 1672, height: 941 },
  "step-1": { width: 800, height: 800 },
  "step-2": { width: 800, height: 800 },
  "step-3": { width: 800, height: 800 },
  "tool-image": { width: 800, height: 600 },
  "tool-video": { width: 800, height: 600 },
  "tool-voice": { width: 800, height: 600 },
  "tool-edit": { width: 800, height: 600 },
  "tool-animate": { width: 800, height: 600 },
  "tool-upscale": { width: 800, height: 600 },
  "tool-cutout": { width: 800, height: 600 },
  "tool-styles": { width: 800, height: 600 },
  "thumb-silkroad": { width: 960, height: 540 },
} as const;

/** Every illustration that needs a description: the hero's backdrop is decorative (an empty alt), so it has none. */
export type ArtId = (typeof STEP_ART)[keyof typeof STEP_ART] | (typeof TOOL_ART)[keyof typeof TOOL_ART] | typeof THUMB_ART;
export const ART_IDS: ArtId[] = [...Object.values(STEP_ART), ...Object.values(TOOL_ART), THUMB_ART];
