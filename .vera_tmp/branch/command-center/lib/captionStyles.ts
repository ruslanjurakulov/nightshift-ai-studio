/**
 * Applying and tweaking an animated caption style on a project's captions.
 *
 * A style is only data: applying one writes the captions' style fields
 * (`preset` and the look it starts from, lib/captionStyleTable.ts) and nothing
 * else — the cues, their words and times are the person's own. Because it is
 * data, saving, undo and the export need nothing special, and a style that is
 * tweaked afterwards is simply the same style with other numbers. Every number
 * a tweak can set is clamped here to what the export draws.
 */
import type { EditorModel } from "@/lib/editor";
import {
  DEFAULT_PRESET,
  captionsOf,
  setCaptionStyle,
  styleFor,
  type CaptionStyle,
} from "@/lib/captions";
import {
  CAPTION_SIZE_MAX,
  CAPTION_SIZE_MIN,
  CAPTION_Y_MAX,
  CAPTION_Y_MIN,
  isCaptionStyleId,
  styleDefaults,
  type CaptionStyleId,
  type CaptionTweak,
} from "@/lib/captionStyleTable";

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The animated style the project's captions use, or null (plain captions, or none). */
export function activeCaptionStyle(model: Pick<EditorModel, "captions">): CaptionStyleId | null {
  const preset = captionsOf(model)?.style.preset;
  return isCaptionStyleId(preset) ? preset : null;
}

/** Puts a style on the captions: its look replaces the current one, the cues stay. */
export function applyCaptionStyle(model: EditorModel, id: CaptionStyleId): EditorModel {
  return setCaptionStyle(model, styleDefaults(id, model.width, model.height) as CaptionStyle);
}

/** Back to the plain caption (no animation): the default look, the cues stay. */
export function clearCaptionStyle(model: EditorModel): EditorModel {
  return setCaptionStyle(model, styleFor(DEFAULT_PRESET, model.width, model.height));
}

/** The value of a tweak on the captions' style, defended. */
export function tweakValue(model: Pick<EditorModel, "captions">, tweak: CaptionTweak): string | number | null {
  const st = captionsOf(model)?.style;
  if (!st) return null;
  const v = st[tweak];
  return typeof v === "string" || typeof v === "number" ? v : null;
}

/**
 * Changes one tweak of the style in use. A colour must be #RRGGBB (anything
 * else changes nothing), a size is a whole number from CAPTION_SIZE_MIN to
 * CAPTION_SIZE_MAX, a height keeps the caption inside the picture. The same
 * model comes back when nothing changed, so history gets no empty step.
 */
export function setCaptionTweak(model: EditorModel, tweak: CaptionTweak, value: string | number): EditorModel {
  const cur = captionsOf(model);
  if (!cur || !isCaptionStyleId(cur.style.preset)) return model;
  let next: string | number;
  if (tweak === "color" || tweak === "highlight_color") {
    if (typeof value !== "string" || !HEX.test(value)) return model;
    next = value.toUpperCase();
  } else {
    const n = Number(value);
    if (!Number.isFinite(n)) return model;
    next =
      tweak === "size"
        ? Math.min(CAPTION_SIZE_MAX, Math.max(CAPTION_SIZE_MIN, Math.round(n)))
        : Math.round(Math.min(CAPTION_Y_MAX, Math.max(CAPTION_Y_MIN, n)) * 1000) / 1000;
  }
  const had = cur.style[tweak];
  if (typeof had === "string" && typeof next === "string" ? had.toUpperCase() === next : had === next) return model;
  return setCaptionStyle(model, { ...cur.style, [tweak]: next });
}
