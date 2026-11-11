"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  COLOR_CURVES,
  MASK_SHAPES,
  MAX_EDITOR_CLIPS,
  formatTime,
  type ColorCurve,
  type EditorAsset,
  type EditorModel,
  type MaskShape,
  type VideoClip,
} from "@/lib/editor";
import {
  COLOR_RANGES,
  MASK_RANGES,
  colorValue,
  hasColor,
  lookCheck,
  maskOf,
  resetClipColor,
  setClipColor,
  setClipCurve,
  setClipMaskInvert,
  setClipMaskShape,
  setClipMaskValue,
  type ColorKey,
  type MaskNumber,
} from "@/lib/editorLook";
import {
  SILENCE_DB_DEFAULT,
  SILENCE_DB_MAX,
  SILENCE_DB_MIN,
  SILENCE_MIN_S_DEFAULT,
  SILENCE_MIN_S_MAX,
  SILENCE_MIN_S_MIN,
  applyCuts,
  countForm,
  cutSeconds,
  cutTimes,
  detectSilences,
  proposeCuts,
  silenceEnvelopeFor,
  silenceProblem,
  type EnvelopeResult,
  type Span,
} from "@/lib/editorSilence";
import { Disclosure, RadioChips, SliderRow, ToggleRow } from "./FxControls";

/**
 * The selected clip's advanced colour, its mask and "remove silences": three sections of the clip
 * inspector (rendered by ClipFxSections). Every change goes through `apply` as a new model (one undo
 * step, one per slider gesture). A change that adds colour or a mask is checked against the export's
 * time allowance first and is not made when it would not fit, with the reason shown.
 */

type Apply = (next: EditorModel, group?: string) => void;

const quiet =
  "btn-quiet inline-flex min-h-11 items-center gap-1.5 self-start px-3 py-1.5 text-xs aria-disabled:cursor-default aria-disabled:opacity-50";

function useBudgetedApply(apply: Apply, showClip: (id: string) => void, id: string) {
  const [refused, setRefused] = useState<string | null>(null);
  const { t } = useI18n();
  const edit = (next: EditorModel, group?: string) => {
    const check = lookCheck(next);
    if (!check.ok) {
      setRefused(
        fmt(t.editor.parity2.budget, {
          work: Math.round(check.render.work),
          length: Math.round(check.render.length),
          allowed: Math.round(check.render.allowed),
        }),
      );
      return;
    }
    setRefused(null);
    apply(next, group);
    showClip(id);
  };
  return { edit, refused };
}

function Refused({ text }: { text: string | null }) {
  return text ? (
    <p role="status" className="m-0 text-xs text-[var(--color-warn)]" data-testid="look-budget">
      {text}
    </p>
  ) : null;
}

export function ClipColorSection({
  model,
  clip,
  apply,
  showClip,
}: {
  model: EditorModel;
  clip: VideoClip;
  apply: Apply;
  showClip: (id: string) => void;
}) {
  const { t } = useI18n();
  const s = t.editor.parity2.color;
  const id = clip.id;
  const { edit, refused } = useBudgetedApply(apply, showClip, id);
  const slider = (k: ColorKey, label: string) => {
    const r = COLOR_RANGES[k];
    const v = colorValue(clip, k);
    return (
      <SliderRow
        key={k}
        label={label}
        value={v}
        min={r.min}
        max={r.max}
        step={r.step}
        text={fmt(k === "hue" ? s.hueValue : s.value, { v })}
        onChange={(n, group) => edit(setClipColor(model, id, k, n), group)}
      />
    );
  };
  return (
    <Disclosure title={s.title} active={hasColor(clip)} testId="clip-color" lazy>
      {slider("temperature", s.temperature)}
      {slider("tint", s.tint)}
      {slider("hue", s.hue)}
      <RadioChips
        legend={s.curveLegend}
        options={[
          { value: "none", label: s.curveNone },
          ...COLOR_CURVES.map((c) => ({ value: c as string, label: s.curves[c] })),
        ]}
        value={clip.color?.curve ?? "none"}
        onChange={(v) => edit(setClipCurve(model, id, v === "none" ? null : (v as ColorCurve)))}
        columns="8.5rem"
        testId="clip-curve"
      />
      <Refused text={refused} />
      <p className="m-0 text-xs text-[var(--color-muted)]">{s.hint}</p>
      {hasColor(clip) ? <p className="m-0 text-xs text-[var(--color-muted)]">{s.previewNote}</p> : null}
      <button
        type="button"
        className={quiet}
        aria-disabled={!hasColor(clip) || undefined}
        onClick={() => {
          if (hasColor(clip)) edit(resetClipColor(model, id));
        }}
      >
        {s.reset}
      </button>
    </Disclosure>
  );
}

export function ClipMaskSection({
  model,
  clip,
  apply,
  showClip,
}: {
  model: EditorModel;
  clip: VideoClip;
  apply: Apply;
  showClip: (id: string) => void;
}) {
  const { t } = useI18n();
  const s = t.editor.parity2.mask;
  const id = clip.id;
  const { edit, refused } = useBudgetedApply(apply, showClip, id);
  const m = clip.mask ? maskOf(clip.mask) : null;
  const slider = (k: MaskNumber, label: string) => {
    if (!m) return null;
    const r = MASK_RANGES[k];
    return (
      <SliderRow
        key={k}
        label={label}
        value={m[k]}
        min={r.min}
        max={r.max}
        step={0.01}
        text={fmt(s.percent, { v: Math.round(m[k] * 100) })}
        onChange={(n, group) => edit(setClipMaskValue(model, id, k, n), group)}
      />
    );
  };
  return (
    <Disclosure title={s.title} active={Boolean(clip.mask)} testId="clip-mask" lazy>
      <RadioChips
        legend={s.legend}
        options={[
          { value: "none", label: s.none },
          ...MASK_SHAPES.map((x) => ({ value: x as string, label: s.shapes[x] })),
        ]}
        value={clip.mask?.shape ?? "none"}
        onChange={(v) => edit(setClipMaskShape(model, id, v === "none" ? null : (v as MaskShape)))}
        testId="clip-mask-shape"
      />
      {m ? (
        <>
          {slider("x", s.x)}
          {slider("y", s.y)}
          {slider("w", s.w)}
          {slider("h", s.h)}
          {slider("feather", s.feather)}
          {m.shape === "rounded" ? slider("radius", s.radius) : null}
          <ToggleRow
            label={s.invert}
            checked={m.invert}
            onChange={(on) => edit(setClipMaskInvert(model, id, on))}
            testId="clip-mask-invert"
          />
          <p className="m-0 text-xs text-[var(--color-muted)]">{s.previewNote}</p>
        </>
      ) : null}
      <Refused text={refused} />
      <p className="m-0 text-xs text-[var(--color-muted)]">{s.hint}</p>
    </Disclosure>
  );
}

export function ClipSilenceSection({
  model,
  clip,
  asset,
  apply,
}: {
  model: EditorModel;
  clip: VideoClip;
  asset: Partial<Pick<EditorAsset, "id" | "kind" | "viewUrl" | "durationS">> | null;
  apply: Apply;
}) {
  const { t, locale } = useI18n();
  const s = t.editor.parity2.silence;
  const [db, setDb] = useState(SILENCE_DB_DEFAULT);
  const [minS, setMinS] = useState(SILENCE_MIN_S_DEFAULT);
  const [result, setResult] = useState<EnvelopeResult | "working" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    setResult(null);
    setDone(null);
  }, [clip.id]);
  const problem = silenceProblem(model, clip, asset?.kind);
  const cuts: Span[] =
    result && result !== "working" && result.status === "ready"
      ? proposeCuts(clip, detectSilences(result.env, db, minS, result.blockS))
      : [];
  const find = () => {
    if (!asset?.id || !asset.viewUrl) {
      setResult({ status: "unavailable" });
      return;
    }
    setDone(null);
    setResult("working");
    void silenceEnvelopeFor(asset.id, asset.viewUrl, asset.durationS ?? null).then(setResult);
  };
  const status =
    result === "working"
      ? s.working
      : result && result.status !== "ready"
        ? s[result.status]
        : result
          ? cuts.length
            ? fmt(s.found[countForm(cuts.length, locale)], { n: cuts.length, s: cutSeconds(clip, cuts).toFixed(1) })
            : s.none
          : null;
  return (
    <Disclosure title={s.title} active={false} testId="clip-silence" lazy>
      <SliderRow
        label={s.threshold}
        value={db}
        min={SILENCE_DB_MIN}
        max={SILENCE_DB_MAX}
        step={1}
        text={fmt(s.thresholdValue, { v: db })}
        onChange={(n) => setDb(n)}
      />
      <SliderRow
        label={s.minLength}
        value={minS}
        min={SILENCE_MIN_S_MIN}
        max={SILENCE_MIN_S_MAX}
        step={0.1}
        text={fmt(s.minValue, { v: minS.toFixed(1) })}
        onChange={(n) => setMinS(n)}
      />
      {problem ? (
        <p className="m-0 text-xs text-[var(--color-muted)]" data-testid="silence-problem">
          {fmt(s[problem], { max: MAX_EDITOR_CLIPS })}
        </p>
      ) : (
        <button type="button" className={quiet} onClick={find} aria-disabled={result === "working" || undefined}>
          {s.find}
        </button>
      )}
      {status ? (
        <p role="status" className="m-0 text-xs" data-testid="silence-status">
          {status}
        </p>
      ) : null}
      {cuts.length && !problem ? (
        <>
          <ul className="m-0 flex flex-wrap gap-1.5 p-0 text-xs tabular-nums" data-testid="silence-cuts">
            {cutTimes(clip, cuts).map(([a, b]) => (
              <li key={`${a}-${b}`} className="list-none">
                {fmt(s.cut, { a: formatTime(a), b: formatTime(b) })}
              </li>
            ))}
          </ul>
          <p className="m-0 text-xs text-[var(--color-muted)]" data-testid="silence-keep-times">
            {s.keepTimes}
          </p>
          <button
            type="button"
            className="btn-primary inline-flex min-h-11 items-center self-start px-3 py-1.5 text-xs"
            onClick={() => {
              const r = applyCuts(model, clip.id, cuts);
              if (!r.applied) return;
              const applied = cuts.slice(cuts.length - r.applied);
              apply(r.model);
              setResult(null);
              setDone(
                r.applied < cuts.length
                  ? fmt(s.partial, { n: r.applied, total: cuts.length, max: MAX_EDITOR_CLIPS })
                  : fmt(s.applied[countForm(r.applied, locale)], { n: r.applied, s: cutSeconds(clip, applied).toFixed(1) }),
              );
            }}
          >
            {fmt(s.apply[countForm(cuts.length, locale)], { n: cuts.length })}
          </button>
        </>
      ) : null}
      {done ? (
        <p role="status" className="m-0 text-xs" data-testid="silence-done">
          {done}
        </p>
      ) : null}
      <p className="m-0 text-xs text-[var(--color-muted)]">{s.hint}</p>
    </Disclosure>
  );
}
