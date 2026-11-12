"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  ALIGNS,
  MAX_BLEEPS,
  TRACKING_MAX,
  TRACKING_MIN,
  type BleepMode,
  type EditorModel,
  type TextAlign,
  type TextClip,
} from "@/lib/editor";
import { bleepOver, cueWords, removeBleep, setBleepMode, toggleWordBleep } from "@/lib/editorBleeps";
import { setTextAlign, setTextItalic, setTextTracking } from "@/lib/editorTextProps";
import type { Cue } from "@/lib/captions";
import { Disclosure, RadioChips, SliderRow, ToggleRow } from "./FxControls";

/**
 * The talking-head pack's controls (docs/editor-render-fields.md section 18): a text's letter spacing, italic and
 * line alignment (the inspector), and "Mute or bleep words" (the captions panel). Each reads the model and reports a
 * new one through `apply`: one undo step per change, one per slider drag. Clean voice lives with the other sound
 * clean-up switches (CleanSections).
 */

type Apply = (next: EditorModel, group?: string) => void;
const note = "m-0 text-xs text-[var(--color-muted)]";
const secs = (v: number) => v.toFixed(2);

export function TextPropsSection({
  model,
  text,
  apply,
}: {
  model: EditorModel;
  text: TextClip;
  apply: Apply;
}) {
  const { t } = useI18n();
  const p = t.editor.parity4.text;
  const tracking = text.tracking ?? 0;
  return (
    <Disclosure
      title={p.title}
      active={Boolean(tracking || text.italic || text.align)}
      testId="text-props"
    >
      <SliderRow
        label={p.tracking}
        value={tracking}
        min={TRACKING_MIN}
        max={TRACKING_MAX}
        step={10}
        text={fmt(p.trackingValue, { v: tracking })}
        onChange={(v, g) => apply(setTextTracking(model, text.id, v), g)}
      />
      <ToggleRow
        label={p.italic}
        checked={Boolean(text.italic)}
        onChange={(on) => apply(setTextItalic(model, text.id, on))}
        testId="text-italic"
      />
      <RadioChips<TextAlign | "auto">
        legend={p.alignLegend}
        options={[
          { value: "auto", label: p.alignAuto },
          ...ALIGNS.map((a) => ({ value: a, label: p.aligns[a] })),
        ]}
        value={text.align ?? "auto"}
        onChange={(v) => apply(setTextAlign(model, text.id, v === "auto" ? null : v))}
        hint={p.alignHint}
        testId="text-align"
      />
      <p className={note}>{p.previewNote}</p>
      <p className={note}>{p.emoji}</p>
    </Disclosure>
  );
}

/** How many captions the word list shows at first (and adds per press). */
const BLEEP_CUES_SHOWN = 20;

export function BleepPanel({
  model,
  cues,
  onChange,
}: {
  model: EditorModel;
  cues: readonly Cue[];
  onChange: (next: EditorModel) => void;
}) {
  const { t } = useI18n();
  const b = t.editor.parity4.bleeps;
  const [mode, setMode] = useState<BleepMode>("tone");
  const [shown, setShown] = useState(BLEEP_CUES_SHOWN);
  const [notice, setNotice] = useState<string | null>(null);
  const bleeps = model.bleeps ?? [];
  return (
    <Disclosure title={b.title} active={bleeps.length > 0} testId="bleeps">
      <p className={note}>{b.hint}</p>
      <RadioChips<BleepMode>
        legend={b.modeLegend}
        options={[
          { value: "tone", label: b.modes.tone },
          { value: "mute", label: b.modes.mute },
        ]}
        value={mode}
        onChange={setMode}
        testId="bleep-mode"
      />
      <ul className="m-0 flex max-h-[360px] list-none flex-col gap-2 overflow-y-auto p-0 pr-1">
        {cues.slice(0, shown).map((c, n) => (
          <li key={c.id} className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-[var(--color-muted)]">{fmt(b.caption, { n: n + 1 })}</span>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {cueWords(c).map((w) => {
                const on = bleepOver(bleeps, w.start_s, w.end_s) >= 0;
                return (
                  <button
                    key={w.index}
                    type="button"
                    aria-pressed={on}
                    aria-label={fmt(b.wordAria, { word: w.text, start: secs(w.start_s) })}
                    data-testid="bleep-word"
                    onClick={() => {
                      const r = toggleWordBleep(model, w, mode);
                      if (r.ok) {
                        setNotice(null);
                        onChange(r.model);
                      } else setNotice(r.reason === "full" ? fmt(b.full, { max: MAX_BLEEPS }) : b.noRoom);
                    }}
                    className="ns-chip min-h-11 min-w-0 break-all"
                    data-on={on ? "true" : undefined}
                  >
                    {w.text}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      {cues.length > shown ? (
        <button
          type="button"
          onClick={() => setShown((v) => v + BLEEP_CUES_SHOWN)}
          className="btn-quiet inline-flex min-h-11 items-center self-start px-3 py-1.5 text-xs"
        >
          {b.more}
        </button>
      ) : null}
      {notice ? (
        <p role="status" className="m-0 text-xs text-[var(--color-warn)]">
          {notice}
        </p>
      ) : null}
      <h4 className="m-0 text-xs font-semibold">{fmt(b.listHeading, { n: bleeps.length, max: MAX_BLEEPS })}</h4>
      {bleeps.length === 0 ? (
        <p className={note}>{b.none}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="bleep-list">
          {bleeps.map((x, i) => (
            <li key={`${x.start_s}-${i}`} className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
              <span className="min-w-[7rem] tabular-nums">
                {fmt(b.range, { start: secs(x.start_s), end: secs(x.end_s) })}
              </span>
              <select
                value={x.mode}
                aria-label={fmt(b.modeAria, { start: secs(x.start_s) })}
                onChange={(e) => onChange(setBleepMode(model, i, e.target.value as BleepMode))}
                className="min-h-11 rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] px-2 text-base text-[var(--color-fg)] sm:text-[13px]"
              >
                <option value="tone">{b.modes.tone}</option>
                <option value="mute">{b.modes.mute}</option>
              </select>
              <button
                type="button"
                aria-label={fmt(b.removeAria, { start: secs(x.start_s) })}
                onClick={() => onChange(removeBleep(model, i))}
                className="btn-quiet inline-flex min-h-11 items-center px-3 py-1.5 text-xs"
              >
                {b.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className={note} data-testid="bleep-preview-note">
        {b.previewNote}
      </p>
    </Disclosure>
  );
}
