"use client";

import { useId, useState } from "react";
import { ArrowLeftToLine, ArrowRightToLine, ClipboardPaste, Eraser, Scissors, SquareDashed, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { countForm } from "@/lib/editorSilence";
import { formatTime, MAX_EDITOR_SOUNDS, type EditorAsset, type EditorModel, type SourceLength } from "@/lib/editor";
import { splitEdit, type Marks, type SplitEditKind } from "@/lib/editorRange";
import {
  ACTION_SAFE,
  GUIDE_APPS,
  TITLE_SAFE,
  appAreas,
  isVerticalNineSixteen,
  safeRect,
  type GuideApp,
  type GuideChoice,
} from "@/lib/editorGuides";

const quietBtn = "btn-quiet inline-flex items-center gap-1.5 px-3 py-1.5 text-xs";
const note = "m-0 text-xs text-[var(--color-muted)]";

/** The timeline's tools: trim (the default: an edge, the clips after it ripple), roll, slip and slide. */
export const EDIT_TOOLS = ["trim", "roll", "slip", "slide"] as const;
export type EditTool = (typeof EDIT_TOOLS)[number];

/** The tool picker: a radio group (the arrow keys move inside it; V, N, Y and U pick a tool from anywhere). */
export function ToolPicker({ tool, onTool }: { tool: EditTool; onTool: (t: EditTool) => void }) {
  const { t } = useI18n();
  const ct = t.editor.core.tools;
  const hintId = useId();
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0" aria-describedby={hintId} data-testid="tool-picker" data-editor-timeline="">
      <legend className="sr-only">{ct.label}</legend>
      <div className="flex flex-wrap items-center gap-1.5">
        <span aria-hidden className="text-xs text-[var(--color-muted)]">
          {ct.label}
        </span>
        {EDIT_TOOLS.map((k) => (
          <label key={k} className="ns-chip cursor-pointer has-[:checked]:border-[var(--color-primary)] has-[:checked]:text-[var(--color-fg)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-primary)]">
            <input
              type="radio"
              name="editor-tool"
              value={k}
              checked={tool === k}
              onChange={() => onTool(k)}
              className="sr-only"
            />
            {ct[k]}
          </label>
        ))}
      </div>
      <p id={hintId} className={note}>
        {ct.hint[tool]}
      </p>
    </fieldset>
  );
}

/**
 * The in / out marks and what they are for: ripple delete, lift, and insert of the copied clip at the playhead.
 * Every button is the same action as its key (I, O, ', ;, ,); a result or a refusal is said in the status line.
 */
export function MarksBar({
  range,
  marks,
  canInsert,
  status,
  onMark,
  onClear,
  onExtract,
  onLift,
  onInsert,
}: {
  range: [number, number] | null;
  marks: Marks;
  canInsert: boolean;
  status: string | null;
  onMark: (which: "in" | "out") => void;
  onClear: () => void;
  onExtract: () => void;
  onLift: () => void;
  onInsert: () => void;
}) {
  const { t } = useI18n();
  const cm = t.editor.core.marks;
  const id = useId();
  const any = marks.in !== null || marks.out !== null;
  return (
    <div role="group" aria-label={cm.group} className="flex flex-col gap-1.5" data-testid="marks-bar" data-editor-timeline="">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={quietBtn} onClick={() => onMark("in")} aria-keyshortcuts="I">
          <ArrowRightToLine className="size-3.5" aria-hidden />
          {cm.markIn}
        </button>
        <button type="button" className={quietBtn} onClick={() => onMark("out")} aria-keyshortcuts="O">
          <ArrowLeftToLine className="size-3.5" aria-hidden />
          {cm.markOut}
        </button>
        {any ? (
          <button type="button" className={quietBtn} onClick={onClear}>
            <X className="size-3.5" aria-hidden />
            {cm.clear}
          </button>
        ) : null}
        <button
          type="button"
          className={quietBtn}
          aria-disabled={!range || undefined}
          aria-describedby={`${id}-extract`}
          aria-keyshortcuts="'"
          onClick={onExtract}
        >
          <Scissors className="size-3.5" aria-hidden />
          {cm.extract}
        </button>
        <button
          type="button"
          className={quietBtn}
          aria-disabled={!range || undefined}
          aria-describedby={`${id}-lift`}
          aria-keyshortcuts=";"
          onClick={onLift}
        >
          <Eraser className="size-3.5" aria-hidden />
          {cm.lift}
        </button>
        <button
          type="button"
          className={quietBtn}
          aria-disabled={!canInsert || undefined}
          aria-describedby={`${id}-insert`}
          aria-keyshortcuts=","
          onClick={onInsert}
        >
          <ClipboardPaste className="size-3.5" aria-hidden />
          {cm.insert}
        </button>
      </div>
      <p className={note} data-testid="marks-range">
        {range
          ? fmt(cm.range, { from: formatTime(range[0]), to: formatTime(range[1]), length: formatTime(range[1] - range[0]) })
          : cm.none}
      </p>
      <p id={`${id}-extract`} className="sr-only">
        {cm.extractHint}
      </p>
      <p id={`${id}-lift`} className={note}>
        {cm.liftHint}
      </p>
      <p id={`${id}-insert`} className="sr-only">
        {cm.insertHint}
      </p>
      <p aria-live="polite" className={note} data-testid="core-status">
        {status}
      </p>
    </div>
  );
}

/** The frames a J / L cut offers (a half second at 24-30 fps is about 12-15 frames). */
const SPLIT_FRAMES = [6, 12, 24] as const;

/**
 * One-click J or L cut at the cut into the selected clip (lib/editorRange.ts `splitEdit`): one undo step; the new
 * sound becomes the selection, as after Detach audio.
 */
export function SplitEditTools({
  model,
  clipId,
  sourceOf,
  kindOf,
  apply,
  onDone,
}: {
  model: EditorModel;
  clipId: string;
  sourceOf: SourceLength;
  kindOf: (assetId: string) => EditorAsset["kind"] | undefined;
  apply: (next: EditorModel) => void;
  onDone: (soundId: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const cj = t.editor.core.jl;
  const id = useId();
  const [frames, setFrames] = useState<number>(12);
  const [said, setSaid] = useState<string | null>(null);
  const run = (kind: SplitEditKind) => {
    const out = splitEdit(model, clipId, kind, frames, sourceOf, kindOf);
    if ("problem" in out) {
      setSaid(
        out.problem === "sounds_full" ? fmt(cj.problem.sounds_full, { max: MAX_EDITOR_SOUNDS }) : cj.problem[out.problem],
      );
      return;
    }
    apply(out.model);
    setSaid(fmt(cj.done[countForm(out.frames, locale)], { n: out.frames }));
    onDone(out.sounds[0] ?? null);
  };
  return (
    <div role="group" aria-labelledby={`${id}-t`} className="flex flex-col gap-1.5" data-testid="split-edit">
      <p id={`${id}-t`} className="m-0 text-xs font-medium text-[var(--color-fg)]">
        {cj.title}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
          {cj.frames}
          <select
            value={frames}
            onChange={(e) => setFrames(Number(e.target.value))}
            className="rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-base text-[var(--color-fg)] sm:text-xs"
          >
            {SPLIT_FRAMES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={quietBtn} aria-describedby={`${id}-h`} onClick={() => run("j")}>
          {cj.j}
        </button>
        <button type="button" className={quietBtn} aria-describedby={`${id}-h`} onClick={() => run("l")}>
          {cj.l}
        </button>
      </div>
      <p id={`${id}-h`} className={note}>
        {cj.hint}
      </p>
      <p aria-live="polite" className={note}>
        {said}
      </p>
    </div>
  );
}

/** The guides' switches, under the frame picker. */
export function GuidesControls({
  frame,
  value,
  onChange,
}: {
  frame: Pick<EditorModel, "width" | "height">;
  value: GuideChoice;
  onChange: (g: GuideChoice) => void;
}) {
  const { t } = useI18n();
  const cg = t.editor.core.guides;
  const id = useId();
  const vertical = isVerticalNineSixteen(frame);
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0" aria-describedby={`${id}-n`} data-testid="guides-controls">
      <legend className="mb-1 text-xs font-medium text-[var(--color-fg)]">
        <SquareDashed className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
        {cg.title}
      </legend>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-[var(--color-muted)]">
        <label className="flex items-center gap-1.5">
          {cg.app}
          <select
            value={value.app ?? ""}
            disabled={!vertical}
            aria-describedby={vertical ? undefined : `${id}-v`}
            onChange={(e) => onChange({ ...value, app: (e.target.value || null) as GuideApp | null })}
            className="rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-base text-[var(--color-fg)] disabled:opacity-60 sm:text-xs"
          >
            <option value="">{cg.appNone}</option>
            {GUIDE_APPS.map((a) => (
              <option key={a} value={a}>
                {cg.apps[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-1.5 sm:min-h-0">
          <input type="checkbox" checked={value.safe} onChange={(e) => onChange({ ...value, safe: e.target.checked })} />
          {cg.safe}
        </label>
        <label className="flex min-h-11 items-center gap-1.5 sm:min-h-0">
          <input type="checkbox" checked={value.grid} onChange={(e) => onChange({ ...value, grid: e.target.checked })} />
          {cg.grid}
        </label>
      </div>
      {vertical ? null : (
        <p id={`${id}-v`} className={note}>
          {cg.verticalOnly}
        </p>
      )}
      <p id={`${id}-n`} className={note}>
        {cg.note}
      </p>
    </fieldset>
  );
}

/** The guides over the preview box: display only (aria-hidden, no pointer events), never part of the export. */
export function PreviewGuides({ frame, value }: { frame: Pick<EditorModel, "width" | "height">; value: GuideChoice }) {
  const areas = appAreas(frame, value.app);
  if (!areas.length && !value.safe && !value.grid) return null;
  const P = (v: number) => v * 1000;
  const action = safeRect(ACTION_SAFE);
  const title = safeRect(TITLE_SAFE);
  const line = { stroke: "rgba(255,255,255,0.7)", strokeWidth: 1, vectorEffect: "non-scaling-stroke" as const };
  return (
    <svg
      aria-hidden
      data-testid="preview-guides"
      className="pointer-events-none absolute inset-0 z-20 size-full"
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
    >
      {areas.map((r, i) => (
        <rect key={i} data-guide="app" x={P(r.x)} y={P(r.y)} width={P(r.w)} height={P(r.h)} fill="rgba(255,64,64,0.22)" />
      ))}
      {value.safe ? (
        <>
          <rect data-guide="action" x={P(action.x)} y={P(action.y)} width={P(action.w)} height={P(action.h)} fill="none" {...line} strokeDasharray="6 4" />
          <rect data-guide="title" x={P(title.x)} y={P(title.y)} width={P(title.w)} height={P(title.h)} fill="none" {...line} />
        </>
      ) : null}
      {value.grid ? (
        <g data-guide="grid">
          {[1 / 3, 2 / 3].map((f) => (
            <g key={f}>
              <line x1={P(f)} y1={0} x2={P(f)} y2={1000} {...line} strokeOpacity={0.5} />
              <line x1={0} y1={P(f)} x2={1000} y2={P(f)} {...line} strokeOpacity={0.5} />
            </g>
          ))}
          <line x1={480} y1={500} x2={520} y2={500} {...line} />
          <line x1={500} y1={480} x2={500} y2={520} {...line} />
        </g>
      ) : null}
    </svg>
  );
}

