/**
 * A clip's colour grade (brightness, contrast, saturation) and the ONE place
 * the preview takes its look from the document.
 *
 * The document holds `grade: { brightness, contrast, saturation }` on a V clip
 * (modules/timeline.py GRADE_RANGES; no field = no change). The export applies
 * the three numbers with ffmpeg `eq` (modules/render_backend.py
 * `grade_filter`): brightness is ADDED to the luma, contrast scales the luma
 * around mid-grey, saturation scales the chroma. The preview draws the same
 * three numbers as an SVG `feColorMatrix` used as a CSS `filter`, built below
 * from the same arithmetic, so a browser shows what `eq` computes rather than
 * what CSS `brightness()` / `contrast()` mean (those multiply / stretch RGB:
 * a different look). tests/editor-grade.test.ts pins the matrix to a shared
 * fixture (samples/clip_grade_preview.json) and tests/test_editor_grade.py
 * measures a real ffmpeg export against the same fixture.
 *
 * Preview and export stay two renderers: this module is the contract between
 * them, not a guarantee of identical pixels (see the parity test's tolerance).
 */
import type { CSSProperties } from "react";
import type { EditorModel, VideoClip } from "@/lib/editor";

export interface ClipGrade {
  brightness: number;
  contrast: number;
  saturation: number;
}

export type GradeKey = keyof ClipGrade;

/** The valid range of each number (modules/timeline.py GRADE_RANGES), its
 *  "no change" value, and the editor's slider step. */
export const GRADE_RANGES: Record<
  GradeKey,
  { min: number; max: number; neutral: number; step: number }
> = {
  brightness: { min: -1, max: 1, neutral: 0, step: 0.05 },
  contrast: { min: 0, max: 2, neutral: 1, step: 0.05 },
  saturation: { min: 0, max: 3, neutral: 1, step: 0.05 },
};

export const GRADE_KEYS = ["brightness", "contrast", "saturation"] as const;

export const NEUTRAL_GRADE: ClipGrade = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
};

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function clampTo(key: GradeKey, v: number): number {
  const r = GRADE_RANGES[key];
  const n = Number.isFinite(v) ? v : r.neutral;
  return round3(Math.min(r.max, Math.max(r.min, n)));
}

export function isNeutralGrade(c: ClipGrade): boolean {
  return GRADE_KEYS.every((k) => c[k] === GRADE_RANGES[k].neutral);
}

/** A clip's colour; the neutral grade when it has none. */
export function gradeOf(clip: Pick<VideoClip, "grade">): ClipGrade {
  return clip.grade ? { ...NEUTRAL_GRADE, ...clip.grade } : NEUTRAL_GRADE;
}

/**
 * The model with one number of one clip's colour changed (clamped to its
 * range, to 3 decimals as the document keeps them). A grade that is back at
 * "no change" REMOVES the field, so a project that never used the control
 * keeps exactly the document it had, and Reset returns to it byte for byte.
 * The same model back when nothing changes (not an undo step).
 */
export function setClipGrade(
  model: EditorModel,
  id: string,
  patch: Partial<ClipGrade>,
): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  if (!at) return model;
  const now = gradeOf(at);
  const next: ClipGrade = { ...now };
  for (const k of GRADE_KEYS)
    if (patch[k] !== undefined) next[k] = clampTo(k, patch[k] as number);
  if (GRADE_KEYS.every((k) => next[k] === now[k])) return model;
  return {
    ...model,
    clips: model.clips.map((c) => {
      if (c.id !== id) return c;
      const { grade: _old, ...rest } = c;
      void _old;
      return isNeutralGrade(next) ? rest : { ...rest, grade: next };
    }),
  };
}

/** Back to "no change" (removes the field). */
export function resetClipGrade(model: EditorModel, id: string): EditorModel {
  return setClipGrade(model, id, NEUTRAL_GRADE);
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
export function gradeMatrix(c: ClipGrade, still: boolean): number[] {
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
export const GRADE_FILTER_ID = "ns-clip-grade";

/** The `values` attribute of the preview's feColorMatrix. */
export function gradeMatrixValues(c: ClipGrade, still: boolean): string {
  return gradeMatrix(c, still)
    .map((v) => String(Math.round(v * 1e6) / 1e6))
    .join(" ");
}

/** The style the preview's picture takes for a clip: a CSS `filter` onto the
 *  SVG filter below, or nothing at all for a clip without a grade (then the
 *  element is exactly what it was before colour existed). */
export function previewGradeStyle(
  clip: Pick<VideoClip, "grade"> | null | undefined,
): CSSProperties {
  return clip && !isNeutralGrade(gradeOf(clip))
    ? { filter: `url(#${GRADE_FILTER_ID})` }
    : {};
}
