/**
 * What a credit_prices unit MEANS, in plain words, for the operator's price
 * list — only where the unit's name settles it.
 *
 * The names are a contract (modules/cost_ledger.py, migration 0020 / 0030 /
 * 0076 / 0080 / 0081, model_registry.credit_unit_for), so a gloss is read off
 * the name and nothing else: a fixed table for the product-level units, and
 * the measure word at the end of a registry unit (`model_<id>_second`,
 * `_image`, `_character`, `_request`, with the priced variant after it).
 * A unit that matches none of these gets no gloss at all — never a guess.
 * Pure and client-safe; tests/credit-units.test.ts pins it.
 */

import { fmt } from "@/lib/i18n/core";

/** The dictionary slice the gloss reads (t.credits.unitMeaning). */
export interface UnitMeaningText {
  videoMinute: string;
  jobMinimum: string;
  usd: string;
  downloadMinute: string;
  downloadMinimum: string;
  sceneRegenerate: string;
  sceneRegenerateClip: string;
  repurposeClip: string;
  replyDraft: string;
  tokens: string;
  characters: string;
  renderSeconds: string;
  requests: string;
  bytes: string;
  generatedClips: string;
  generatedImages: string;
  calls: string;
  perSecond: string;
  perImage: string;
  perCharacter: string;
  perRequest: string;
  atResolution: string;
  silent: string;
  withSound: string;
  quality: Record<"low" | "medium" | "high", string>;
}

const FIXED: Record<string, keyof UnitMeaningText> = {
  video_minute: "videoMinute",
  job_minimum: "jobMinimum",
  usd: "usd",
  download_minimum: "downloadMinimum",
  scene_regenerate: "sceneRegenerate",
  repurpose_clip: "repurposeClip",
  reply_draft: "replyDraft",
  gemini_input_tokens: "tokens",
  gemini_output_tokens: "tokens",
  tts_characters: "characters",
  render_seconds: "renderSeconds",
  pexels_requests: "requests",
  upload_bytes: "bytes",
  video_gen_clips: "generatedClips",
  image_generations: "generatedImages",
  vision_calls: "calls",
};

const MEASURES: Record<string, "perSecond" | "perImage" | "perCharacter" | "perRequest"> = {
  second: "perSecond",
  image: "perImage",
  character: "perCharacter",
  request: "perRequest",
};

const RESOLUTION = /^\d{3,4}p$|^[1-9]k$/;

/** The priced variant after the measure word (0060 / 0070), or null when the
 *  tokens are not one the registry produces — then the unit is not glossed. */
function variantText(tokens: string[], t: UnitMeaningText): string[] | null {
  if (tokens.length === 0) return [];
  const [first, second] = tokens;
  const sound = (w: string | undefined) => (w === "silent" ? t.silent : w === "audio" ? t.withSound : null);
  if (tokens.length === 1) {
    if (RESOLUTION.test(first)) return [fmt(t.atResolution, { v: first })];
    const s = sound(first);
    if (s) return [s];
    if (first === "low" || first === "medium" || first === "high") return [t.quality[first]];
    return null;
  }
  if (tokens.length === 2 && RESOLUTION.test(first)) {
    const s = sound(second);
    if (s) return [fmt(t.atResolution, { v: first }), s];
  }
  return null;
}

/**
 * The plain-words meaning of a unit, or null when its name does not settle it.
 *   download_1080p_minute            → "per minute of video, downloaded at 1080p"
 *   model_wan_2_7_second_720p        → "per second, at 720p"
 *   model_openai_gpt_image_2_image   → "per image"
 */
export function unitMeaning(unit: string, t: UnitMeaningText): string | null {
  const fixed = FIXED[unit];
  if (fixed) return t[fixed] as string;

  const dl = /^download_(720p|1080p)_minute$/.exec(unit);
  if (dl) return fmt(t.downloadMinute, { q: dl[1] });

  if (/^scene_regenerate_clip_[a-z0-9]+$/.test(unit)) return t.sceneRegenerateClip;

  if (unit.startsWith("model_")) {
    const tokens = unit.split("_");
    // The last measure word whose tail is a variant the registry produces:
    // `model_…_gpt_image_2_image` ends in the measure, not at the first "image".
    for (let i = tokens.length - 1; i >= 2; i--) {
      const measure = MEASURES[tokens[i]];
      if (!measure) continue;
      const variant = variantText(tokens.slice(i + 1), t);
      if (variant === null) continue;
      return [t[measure], ...variant].join(", ");
    }
  }
  return null;
}
