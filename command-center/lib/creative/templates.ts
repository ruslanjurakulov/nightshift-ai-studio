/**
 * Studio templates: ready starting points for the generate panel (a YouTube
 * thumbnail, a Shorts clip, a product cutout…). Picking one only FILLS the
 * panel — the kind, the shape, the length and a starter description with
 * [brackets] to replace. Nothing is priced or spent until Generate is pressed.
 *
 * The starter descriptions are English in every language on purpose: the
 * image and video models follow English best. Titles and the "for whom" line
 * are translated (lib/i18n `studioTemplates`).
 */
import type { UPSCALE_FACTORS } from "@/lib/creative/operations";
import type { AspectRatio, StudioCapability, StudioPrefill, VideoDuration } from "@/lib/creative/studio";

export interface StudioTemplate {
  id: TemplateId;
  capability: StudioCapability;
  aspect?: AspectRatio;
  duration?: VideoDuration;
  factor?: (typeof UPSCALE_FACTORS)[number];
  /** Starter description ("" for tools that take none). */
  prompt: string;
  /** Two colours for the card's tile. */
  hues: readonly [string, string];
}

export const TEMPLATE_IDS = [
  "yt_thumbnail",
  "shorts_cover",
  "story_scene",
  "product_shot",
  "broll",
  "shorts_clip",
  "voice_intro",
  "new_background",
  "animate_photo",
  "sharpen",
  "cutout",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const STUDIO_TEMPLATES: readonly StudioTemplate[] = [
  {
    id: "yt_thumbnail",
    capability: "t2i",
    aspect: "16:9",
    prompt:
      "Bold YouTube thumbnail: [subject] in close-up, dramatic rim light, high contrast, saturated colours, clean empty space on the left for a big title",
    hues: ["#ff4d4d", "#ffb347"],
  },
  {
    id: "shorts_cover",
    capability: "t2i",
    aspect: "9:16",
    prompt: "Vertical cover for a short video about [topic], one striking subject in the centre, bright, simple background, eye-catching",
    hues: ["#7f5cff", "#ff5ca8"],
  },
  {
    id: "story_scene",
    capability: "t2i",
    aspect: "16:9",
    prompt: "Cinematic illustration for a narrated story: [scene], warm light, painterly detail, wide shot, no text",
    hues: ["#3a7bd5", "#00d2ff"],
  },
  {
    id: "product_shot",
    capability: "t2i",
    aspect: "1:1",
    prompt: "Clean studio photo of [product] on a soft gradient background, gentle shadow, sharp focus, catalogue style",
    hues: ["#11998e", "#38ef7d"],
  },
  {
    id: "broll",
    capability: "t2v",
    aspect: "16:9",
    duration: 5,
    prompt: "Slow aerial shot over [place] at golden hour, smooth camera, cinematic, no people in focus",
    hues: ["#f7971e", "#ffd200"],
  },
  {
    id: "shorts_clip",
    capability: "t2v",
    aspect: "9:16",
    duration: 5,
    prompt: "Vertical clip: [subject] moving toward the camera, dynamic light, energetic, loopable",
    hues: ["#ee0979", "#ff6a00"],
  },
  {
    id: "voice_intro",
    capability: "tts",
    prompt: "Welcome back to the channel! Today we are looking at [topic] — stay to the end, there is a surprise.",
    hues: ["#4568dc", "#b06ab3"],
  },
  {
    id: "new_background",
    capability: "edit",
    prompt: "Replace the background with [setting]; keep the subject, its pose and its colours exactly as they are",
    hues: ["#00b09b", "#96c93d"],
  },
  {
    id: "animate_photo",
    capability: "i2v",
    duration: 5,
    prompt: "Gentle camera push-in, subtle natural motion, keep the picture's look",
    hues: ["#c471f5", "#fa71cd"],
  },
  { id: "sharpen", capability: "upscale", factor: 2, prompt: "", hues: ["#2193b0", "#6dd5ed"] },
  { id: "cutout", capability: "remove_bg", prompt: "", hues: ["#636fa4", "#e8cbc0"] },
];

/** What picking a template puts into the panel. */
export function templatePrefill(tpl: StudioTemplate): StudioPrefill {
  return {
    capability: tpl.capability,
    model: "",
    prompt: tpl.prompt,
    aspect: tpl.aspect ?? "16:9",
    duration: tpl.duration ?? 5,
    sourceId: null,
    factor: tpl.factor ?? 2,
  };
}

export function templateGradient(tpl: StudioTemplate): string {
  return `linear-gradient(135deg, ${tpl.hues[0]} 0%, ${tpl.hues[1]} 100%)`;
}
