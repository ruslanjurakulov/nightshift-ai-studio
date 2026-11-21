"use client";

import { useId } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  EXPORT_FPS,
  EXPORT_PRESETS,
  exportPresetById,
  exportPresetOf,
  isExportFps,
  isLongForPreset,
  type ExportFps,
  type ExportPresetId,
} from "@/lib/editorExportPresets";
import { formatClock } from "@/lib/editorExportStatus";

/**
 * The export format: YouTube wide, vertical (Shorts / Reels / TikTok), square, 4:5, and
 * the frame rate (24, 25, 30 or 60), chosen apart: the format is the frame, the rate is
 * the whole video's.
 *
 * Choosing one is the same undoable document edit the frame picker makes (frame size
 * and rate), so it is saved with the project and the export renders the saved version
 * as always. It renders, spends and publishes nothing, and it does not block anything:
 * a video longer than the format's recommended length only gets a sentence saying so.
 *
 * A native radio group inside a native <details> (no script, no menu): Tab reaches the
 * summary, Enter or Space opens it, the arrow keys move between formats, and the chip
 * is 44px tall on a phone or a touch screen (.ns-chip[data-radio]).
 */
export function ExportPresetPicker({
  width,
  height,
  fps,
  totalS,
  onChange,
  onFps,
}: {
  width: number;
  height: number;
  fps: number;
  /** The video's length in seconds, for the advice line. */
  totalS: number;
  onChange: (id: ExportPresetId) => void;
  onFps: (fps: ExportFps) => void;
}) {
  const { t } = useI18n();
  const ep = t.editor.exportPreset;
  const ct = t.editor.clipTools.fps;
  const id = useId();
  const current = exportPresetOf({ width, height });
  const preset = current ? exportPresetById(current) : null;
  const names: Record<ExportPresetId, string> = ep.names;
  const long = current !== null && isLongForPreset(current, totalS);
  return (
    <details className="min-w-0 text-sm">
      <summary className="min-h-11 cursor-pointer list-none py-2 text-[var(--color-muted)] hover:text-[var(--color-fg)] [&::-webkit-details-marker]:hidden">
        {current
          ? fmt(ep.summary, { name: names[current] })
          : ep.summaryCustom}
      </summary>
      <fieldset
        className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0 pb-1"
        aria-describedby={`${id}-hint`}
      >
        <legend className="sr-only">{ep.legend}</legend>
        <div className="flex flex-wrap gap-1.5">
          {EXPORT_PRESETS.map((p) => (
            <label
              key={p.id}
              className="ns-chip"
              data-radio=""
              data-on={current === p.id ? "true" : undefined}
            >
              <input
                type="radio"
                name={`${id}-preset`}
                value={p.id}
                checked={current === p.id}
                onChange={() => onChange(p.id)}
                className="sr-only"
              />
              {names[p.id]}
            </label>
          ))}
        </div>
        <p id={`${id}-hint`} className="m-0 text-xs text-[var(--color-muted)]">
          {preset
            ? fmt(ep.detail, {
                w: preset.width,
                h: preset.height,
                fps,
              })
            : fmt(ep.custom, { w: width, h: height, fps })}{" "}
          {ep.hint}
        </p>
        {/* Always in the page, so a screen reader hears the sentence when it appears. */}
        <p aria-live="polite" className="m-0 text-xs text-[var(--color-warn)]">
          {long && preset
            ? fmt(ep.longForFormat, {
                length: formatClock(totalS),
                max: formatClock(preset.maxDurationS),
              })
            : null}
        </p>
      </fieldset>
      <fieldset
        className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0 pb-1"
        aria-describedby={`${id}-fps-hint`}
      >
        <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">{ct.legend}</legend>
        <div className="flex flex-wrap gap-1.5">
          {EXPORT_FPS.map((r) => (
            <label
              key={r}
              className="ns-chip"
              data-radio=""
              data-on={fps === r ? "true" : undefined}
            >
              <input
                type="radio"
                name={`${id}-fps`}
                value={r}
                checked={fps === r}
                onChange={() => onFps(r)}
                className="sr-only"
              />
              {fmt(ct.value, { fps: r })}
            </label>
          ))}
        </div>
        <p id={`${id}-fps-hint`} className="m-0 text-xs text-[var(--color-muted)]">
          {isExportFps(fps) ? ct.hint : `${fmt(ct.other, { fps })} ${ct.hint}`}
        </p>
      </fieldset>
    </details>
  );
}
