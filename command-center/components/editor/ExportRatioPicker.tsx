"use client";

import { useId } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  isExportPresetId,
  isLongForPreset,
} from "@/lib/editorExportPresets";
import { formatClock } from "@/lib/editorExportStatus";
import {
  MAX_EXPORT_FRAMES,
  PROJECT_FRAME,
  framePresetById,
  type ExportFrameChoice,
  type FramePresetId,
} from "@/lib/multiRatioExport/frames";
import { HIRES_MAX_FPS, hiresTier, isHiresPresetId } from "@/lib/hiresExport/limits";

/**
 * Which sizes the next export makes (migration 0129, NIGHTSHIFT_MULTI_RATIO_EXPORT; not mounted while that is off):
 * this project's own size, and any of the other export formats. Each ticked size is ONE export request when the
 * person presses Export: free, counted against the same limits as any export, and a separate video in the library.
 *
 * Unlike the format picker beside it this is NOT a document edit: nothing is saved, nothing is undone, and the
 * project keeps its size. It renders, spends and publishes nothing by itself.
 *
 * A native <details> with a native group of checkboxes: Tab reaches the summary and every box, Space ticks, and a
 * chip is 44px tall on a phone or a touch screen (the same chip the format picker uses). A box that cannot be
 * ticked (three are ticked already, or the edit is over a limit at that size) is disabled AND the reason is written
 * under the group, in a polite live region.
 *
 * Paid sizes (1440p and 4K, migration 0132): offered only when the editor passes them in `choices`
 * (NIGHTSHIFT_HIRES_EXPORT on), marked "paid", and disabled with a sentence when the video is longer than that size
 * allows (`overCap`) or the project is faster than it allows (`tooFast`: 4K is 30 fps at most). Their price is not
 * here: HiresExportQuote shows the server's quote under the group.
 */
export function ExportRatioPicker({
  width,
  height,
  totalS,
  choices,
  selected,
  blocked,
  overCap = [],
  tooFast = [],
  fps,
  onChange,
}: {
  /** The project's own frame, for the first box's label. */
  width: number;
  height: number;
  /** The video's length in seconds, for the advice line. */
  totalS: number;
  /** The formats offered beside the project's own size (lib/multiRatioExport/frames.ts `otherFrames`). */
  choices: readonly FramePresetId[];
  selected: readonly ExportFrameChoice[];
  /** Formats the edit cannot be exported in as it is (`frameProblems` is not empty). */
  blocked: readonly FramePresetId[];
  /** Paid formats this video is too long for (lib/hiresExport/limits.ts `overHiresCap`). */
  overCap?: readonly FramePresetId[];
  /** Paid formats this project's frame rate is too fast for (`overHiresFps`: 4K is 30 at most), and that rate. */
  tooFast?: readonly FramePresetId[];
  fps?: number;
  onChange: (next: ExportFrameChoice[]) => void;
}) {
  const { t } = useI18n();
  const er = t.editor.exportRatios;
  const hx = t.editor.exportHires;
  const name = (c: FramePresetId) => (isHiresPresetId(c) ? hx.names[c] : isExportPresetId(c) ? t.editor.exportPreset.names[c] : c);
  const id = useId();
  const on = (c: ExportFrameChoice) => selected.includes(c);
  const full = selected.length >= MAX_EXPORT_FRAMES;
  const isBlocked = (c: ExportFrameChoice) =>
    (blocked as readonly string[]).includes(c) ||
    (overCap as readonly string[]).includes(c) ||
    (tooFast as readonly string[]).includes(c);
  // The rule lives here, not only in the `disabled` attribute: a box that may not be ticked is not ticked however the event arrives.
  const toggle = (c: ExportFrameChoice) => {
    if (on(c)) onChange(selected.filter((x) => x !== c));
    else if (!full && !isBlocked(c)) onChange([...selected, c]);
  };
  const onlyOwn = selected.length === 1 && selected[0] === PROJECT_FRAME;
  const sizeOf = (w: number, h: number) => fmt(er.size, { w, h });

  const notes: string[] = [];
  if (selected.length === 0) notes.push(er.none);
  if (full) notes.push(fmt(er.atLimit, { max: MAX_EXPORT_FRAMES }));
  for (const c of choices) {
    if (blocked.includes(c)) notes.push(fmt(er.blocked, { name: name(c) }));
    else if (overCap.includes(c)) {
      const p = framePresetById(c);
      if (p) notes.push(fmt(hx.tooLong, { name: name(c), max: formatClock(p.maxDurationS), length: formatClock(totalS) }));
    } else if (tooFast.includes(c) && isHiresPresetId(c)) {
      const tier = hiresTier(framePresetById(c)?.width, framePresetById(c)?.height);
      if (tier) notes.push(fmt(hx.tooFast, { name: name(c), max: HIRES_MAX_FPS[tier], fps: fps ?? "?" }));
    } else if (on(c) && isExportPresetId(c) && isLongForPreset(c, totalS)) {
      const p = framePresetById(c);
      if (p)
        notes.push(
          fmt(er.longFor, {
            name: name(c),
            length: formatClock(totalS),
            max: formatClock(p.maxDurationS),
          }),
        );
    }
  }

  const chip = (
    c: ExportFrameChoice,
    label: string,
    size: string,
    off: boolean,
  ) => (
    // The format picker's chip (data-radio is only its look); the control inside is a real checkbox.
    <label
      key={c}
      className="ns-chip"
      data-radio=""
      data-on={on(c) ? "true" : undefined}
      data-disabled={off ? "true" : undefined}
    >
      <input
        type="checkbox"
        value={c}
        checked={on(c)}
        disabled={off}
        onChange={() => toggle(c)}
        className="sr-only"
      />
      <span>
        {label} <span className="text-[var(--color-muted)]">{size}</span>
        {c !== PROJECT_FRAME && isHiresPresetId(c) ? (
          <span className="text-[var(--color-muted)]"> · {hx.paidTag}</span>
        ) : null}
      </span>
    </label>
  );

  return (
    <details className="min-w-0 text-sm" data-export-ratios="">
      <summary className="min-h-11 cursor-pointer list-none py-2 text-[var(--color-muted)] hover:text-[var(--color-fg)] [&::-webkit-details-marker]:hidden">
        {onlyOwn ? er.summaryOwn : fmt(er.summaryCount, { count: selected.length })}
      </summary>
      <fieldset
        className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0 pb-1"
        aria-describedby={`${id}-hint`}
      >
        <legend className="sr-only">{er.legend}</legend>
        <div className="flex flex-wrap gap-1.5">
          {chip(PROJECT_FRAME, er.own, sizeOf(width, height), full && !on(PROJECT_FRAME))}
          {choices.map((c) => {
            const p = framePresetById(c);
            if (!p) return null;
            // A ticked box can always be unticked; an unticked one is off at the limit, when the edit does not fit, or
            // (a paid size) when the video is longer or faster than that size allows.
            const off = !on(c) && (full || isBlocked(c));
            return chip(c, name(c), sizeOf(p.width, p.height), off);
          })}
        </div>
        <p id={`${id}-hint`} className="m-0 text-xs text-[var(--color-muted)]">
          {fmt(er.hint, { max: MAX_EXPORT_FRAMES })}
        </p>
        {/* Always in the page, so a screen reader hears a sentence when it appears. */}
        <div aria-live="polite" className="flex flex-col gap-1 text-xs text-[var(--color-warn)]">
          {notes.map((n) => (
            <p key={n} className="m-0 break-words">
              {n}
            </p>
          ))}
        </div>
      </fieldset>
    </details>
  );
}
