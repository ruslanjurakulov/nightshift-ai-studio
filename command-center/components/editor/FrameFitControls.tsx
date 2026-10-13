"use client";

import { useId } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  FRAME_PRESETS,
  framePresetOf,
  type Fit,
  type FramePresetId,
} from "@/lib/editorFrame";

/**
 * The frame (9:16 / 16:9 / 1:1) and a clip's fit (bars / crop). Both are native
 * radio groups drawn as the editor's chips (same markup as the speed buttons),
 * so a keyboard and a screen reader get a real radio group; the chip is 44px
 * tall on a phone or a touch screen (.ns-chip[data-radio]).
 */

export function FramePicker({
  width,
  height,
  onChange,
}: {
  width: number;
  height: number;
  onChange: (id: FramePresetId) => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const id = useId();
  const current = framePresetOf({ width, height });
  const names: Record<FramePresetId, string> = {
    "9:16": te.frameVertical,
    "16:9": te.frameWide,
    "1:1": te.frameSquare,
  };
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
      aria-describedby={`${id}-hint`}
    >
      <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">
        {te.frame}
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {FRAME_PRESETS.map((p) => (
          <label
            key={p.id}
            className="ns-chip"
            data-radio=""
            data-on={current === p.id ? "true" : undefined}
          >
            <input
              type="radio"
              name={`${id}-frame`}
              value={p.id}
              checked={current === p.id}
              onChange={() => onChange(p.id)}
              className="sr-only"
            />
            {p.id} {names[p.id]}
          </label>
        ))}
      </div>
      <p id={`${id}-hint`} className="m-0 text-xs text-[var(--color-muted)]">
        {fmt(current ? te.frameHint : te.frameCustom, { w: width, h: height })}
      </p>
    </fieldset>
  );
}

export function FitPicker({
  fit,
  still,
  onChange,
}: {
  fit: Fit;
  /** A picture always fills the frame in the export, so it has no choice. */
  still: boolean;
  onChange: (fit: Fit) => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const id = useId();
  const options: { value: Fit; label: string }[] = [
    { value: "contain", label: te.fitContain },
    { value: "cover", label: te.fitCover },
  ];
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
      aria-describedby={`${id}-hint`}
    >
      <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">
        {te.fit}
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = !still && fit === o.value;
          return (
            <label
              key={o.value}
              className="ns-chip"
              data-radio=""
              data-on={on ? "true" : undefined}
              data-disabled={still ? "true" : undefined}
            >
              <input
                type="radio"
                name={`${id}-fit`}
                value={o.value}
                checked={on}
                disabled={still}
                onChange={() => onChange(o.value)}
                className="sr-only"
              />
              {o.label}
            </label>
          );
        })}
      </div>
      <p id={`${id}-hint`} className="m-0 text-xs text-[var(--color-muted)]">
        {still ? te.fitStill : te.fitHint}
      </p>
    </fieldset>
  );
}
