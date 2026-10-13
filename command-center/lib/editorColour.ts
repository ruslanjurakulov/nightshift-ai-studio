/**
 * A clip's colour grade (brightness, contrast, saturation) and the ONE place
 * the preview takes its look from the document.
 *
 * The document holds `color: { brightness, contrast, saturation }` on a V clip
 * (modules/timeline.py COLOR_RANGES; no field = no change). The export applies
 * the three numbers with ffmpeg `eq` (modules/render_backend.py
 * `colour_grade`): brightness is ADDED to the luma, contrast scales the luma
 * around mid-grey, saturation scales the chroma. The preview draws the same
 * three numbers as an SVG `feColorMatrix` used as a CSS `filter`, built below
 * from the same arithmetic, so a browser shows what `eq` computes rather than
 * what CSS `brightness()` / `contrast()` mean (those multiply / stretch RGB:
 * a different look). tests/editor-colour.test.ts pins the matrix to a shared
 * fixture (samples/clip_colour_preview.json) and tests/test_editor_colour.py
 * measures a real ffmpeg export against the same fixture.
 *
 * Preview and export stay two renderers: this module is the contract between
 * them, not a guarantee of identical pixels (see the parity test's tolerance).
 */
import type { CSSProperties } from "react";
import type { EditorModel, VideoClip } from "@/lib/editor";

export interface ClipColour {
  brightness: number;
  contrast: number;
  saturation: number;
}

export type ColourKey = keyof ClipColour;

/** The valid range of each number (modules/timeline.py COLOR_RANGES), its
 *  "no change" value, and the editor's slider step. */
export const COLOUR_RANGES: Record<
  ColourKey,
  { min: number; max: number; neutral: number; step: number }
> = {
  brightness: { min: -1, max: 1, neutral: 0, step: 0.05 },
  contrast: { min: 0, max: 2, neutral: 1, step: 0.05 },
  saturation: { min: 0, max: 3, neutral: 1, step: 0.05 },
};

export const COLOUR_KEYS = ["brightness", "contrast", "saturation"] as const;

export const NEUTRAL_COLOUR: ClipColour = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
};

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function clampTo(key: ColourKey, v: number): number {
  const r = COLOUR_RANGES[key];
  const n = Number.isFinite(v) ? v : r.neutral;
  return round3(Math.min(r.max, Math.max(r.min, n)));
}

export function isNeutralColour(c: ClipColour): boolean {
  return COLOUR_KEYS.every((k) => c[k] === COLOUR_RANGES[k].neutral);
}

/** A clip's colour; the neutral grade when it has none. */
export function colourOf(clip: Pick<VideoClip, "color">): ClipColour {
  return clip.color ? { ...NEUTRAL_COLOUR, ...clip.color } : NEUTRAL_COLOUR;
}

/**
 * The model with one number of one clip's colour changed (clamped to its
 * range, to 3 decimals as the document keeps them). A grade that is back at
 * "no change" REMOVES the field, so a project that never used the control
 * keeps exactly the document it had, and Reset returns to it byte for byte.
 * The same model back when nothing changes (not an undo step).
 */
export function setClipColour(
  model: EditorModel,
  id: string,
  patch: Partial<ClipColour>,
): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  if (!at) return model;
  const now = colourOf(at);
  const next: ClipColour = { ...now };
  for (const k of COLOUR_KEYS)
    if (patch[k] !== undefined) next[k] = clampTo(k, patch[k] as number);
  if (COLOUR_KEYS.every((k) => next[k] === now[k])) return model;
  return {
    ...model,
    clips: model.clips.map((c) => {
      if (c.id !== id) return c;
      const { color: _old, ...rest } = c;
      void _old;
      return isNeutralColour(next) ? rest : { ...rest, color: next };
    }),
  };
}

/** Back to "no change" (removes the field). */
export function resetClipColour(model: EditorModel, id: string): EditorModel {
  return setClipColour(model, id, NEUTRAL_COLOUR);
}

// ── the preview ─────────────────────────────────────────────────────────────

/** Luma weights. A still is converted to YUV by ffmpeg's default (BT.601)
 *  before `eq`; footage is taken as HD (BT.709). The weights only matter when
 *  contrast and saturation differ (the luma term `(contrast - saturation) * Y`). */
export const LUMA_601 = [0.299, 0.587, 0.114] as const;
export const LUMA_709 = [0.2126, 0.7152, 0.0722] as const;

/** `eq` works on 8-bit codes of limited-range video (luma 16..235): its
 *  brightness (added in 0..1 of the 0..255 code) is worth 255/219 of a
 *  full-range level, and its contrast pivot is code 127.5, i.e. 0.509 of the
 *  range a display shows. */
export const EQ_BRIGHTNESS_GAIN = 255 / 219;
export const EQ_CONTRAST_PIVOT = (127.5 - 16) / 219;

/**
 * The 4x5 `feColorMatrix` (20 numbers, row-major, offsets in 0..1) that does
 * to RGB what `eq=brightness:contrast:saturation` does to YUV:
 *   luma'   = contrast * luma + (1 - contrast) * pivot + gain * brightness
 *   chroma' = saturation * chroma          (chroma = rgb - luma)
 * so  out = saturation * rgb + (contrast - saturation) * luma + offset.
 */
export function colourMatrix(c: ClipColour, still: boolean): number[] {
  const w = still ? LUMA_601 : LUMA_709;
  const k =
    (1 - c.contrast) * EQ_CONTRAST_PIVOT + EQ_BRIGHTNESS_GAIN * c.brightness;
  const rows: number[] = [];
  for (let ch = 0; ch < 3; ch += 1) {
    for (let j = 0; j < 3; j += 1)
      rows.push(
        (ch === j ? c.saturation : 0) + (c.contrast - c.saturation) * w[j],
      );
    rows.push(0, k);
  }
  rows.push(0, 0, 0, 1, 0);
  return rows;
}

/** The id of the one `<filter>` the preview defines (one clip is on screen). */
export const COLOUR_FILTER_ID = "ns-clip-colour";

/** The `values` attribute of the preview's feColorMatrix. */
export function colourMatrixValues(c: ClipColour, still: boolean): string {
  return colourMatrix(c, still)
    .map((v) => String(Math.round(v * 1e6) / 1e6))
    .join(" ");
}

/** The style the preview's picture takes for a clip: a CSS `filter` onto the
 *  SVG filter below, or nothing at all for a clip without a grade (then the
 *  element is exactly what it was before colour existed). */
export function previewColourStyle(
  clip: Pick<VideoClip, "color"> | null | undefined,
): CSSProperties {
  return clip && !isNeutralColour(colourOf(clip))
    ? { filter: `url(#${COLOUR_FILTER_ID})` }
    : {};
}
