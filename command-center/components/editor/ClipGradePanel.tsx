"use client";

import { useId, useRef } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { VideoClip } from "@/lib/editor";
import {
  GRADE_FILTER_ID,
  GRADE_KEYS,
  GRADE_RANGES,
  gradeMatrixValues,
  gradeOf,
  isNeutralGrade,
  type ClipGrade,
  type GradeKey,
} from "@/lib/editorGrade";

/**
 * The selected clip's colour: brightness, contrast, saturation as three native
 * range inputs (a keyboard moves each by its step with the arrow keys, Home /
 * End jump to the ends; a slider row is 44px tall) and a Reset. Moving a
 * slider changes the clip live; one drag (or one key press) is ONE undo step:
 * the panel names each gesture with a group the editor's history coalesces.
 */

/** The number as a person reads it: brightness as a signed percentage added,
 *  contrast and saturation as a percentage of the original (100% = no change). */
export function gradeText(key: GradeKey, v: number): string {
  if (key === "brightness") {
    const p = Math.round(v * 100);
    return `${p > 0 ? "+" : ""}${p}%`;
  }
  return `${Math.round(v * 100)}%`;
}

export function ClipGradePanel({
  grade,
  onChange,
  onReset,
}: {
  grade: ClipGrade;
  /** `group` is the same for every change of one gesture. */
  onChange: (patch: Partial<ClipGrade>, group: string) => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const id = useId();
  const gesture = useRef(0);
  const names: Record<GradeKey, string> = {
    brightness: te.gradeBrightness,
    contrast: te.gradeContrast,
    saturation: te.gradeSaturation,
  };
  const next = () => {
    gesture.current += 1;
  };
  const neutral = isNeutralGrade(grade);
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0"
      aria-describedby={`${id}-hint`}
      data-testid="clip-grade"
    >
      <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">
        {te.grade}
      </legend>
      {GRADE_KEYS.map((k) => {
        const r = GRADE_RANGES[k];
        return (
          <label
            key={k}
            className="flex min-w-0 flex-col text-xs text-[var(--color-muted)]"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span>{names[k]}</span>
              <span className="tabular-nums text-[var(--color-fg)]" aria-hidden>
                {gradeText(k, grade[k])}
              </span>
            </span>
            <input
              type="range"
              min={r.min}
              max={r.max}
              step={r.step}
              value={grade[k]}
              aria-valuetext={gradeText(k, grade[k])}
              onPointerDown={next}
              onKeyDown={(e) => {
                if (!e.repeat) next();
              }}
              onChange={(e) =>
                onChange(
                  { [k]: Number(e.target.value) },
                  `${id}-${gesture.current}`,
                )
              }
              className="h-11 w-full min-w-0 accent-[var(--color-primary)]"
            />
          </label>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-quiet inline-flex min-h-11 items-center px-3 text-xs aria-disabled:cursor-default aria-disabled:opacity-50"
          // aria-disabled, not disabled: pressing Reset makes the grade neutral,
          // and a disabled button would drop the keyboard's focus with it.
          aria-disabled={neutral || undefined}
          onClick={() => {
            if (!neutral) onReset();
          }}
        >
          {te.gradeReset}
        </button>
      </div>
      <p id={`${id}-hint`} className="m-0 text-xs text-[var(--color-muted)]">
        {te.gradeHint}
      </p>
    </fieldset>
  );
}

/** The SVG filter the preview's picture points at (CSS `filter:
 *  url(#ns-clip-grade)`), drawn only while the clip on screen has a grade. A
 *  zero-size, hidden-from-everyone SVG: `display: none` would stop browsers
 *  from resolving the reference. */
export function GradeFilterDefs({
  clip,
  still,
}: {
  clip: Pick<VideoClip, "grade"> | null | undefined;
  still: boolean;
}) {
  if (!clip) return null;
  const c = gradeOf(clip);
  if (isNeutralGrade(c)) return null;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
      className="pointer-events-none absolute"
    >
      <filter
        id={GRADE_FILTER_ID}
        colorInterpolationFilters="sRGB"
        x="0"
        y="0"
        width="100%"
        height="100%"
      >
        <feColorMatrix type="matrix" values={gradeMatrixValues(c, still)} />
      </filter>
    </svg>
  );
}
