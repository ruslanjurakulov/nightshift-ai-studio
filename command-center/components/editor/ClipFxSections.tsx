"use client";

import { useEffect, useId, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  ANGLE_MAX,
  CROP_MIN,
  FILTERS,
  ROTATIONS,
  type EditorAsset,
  type EditorModel,
  type VideoClip,
} from "@/lib/editor";
import {
  CROP_STEP,
  EFFECT_RANGES,
  STRENGTH_STEP,
  angleOf,
  cropForAspect,
  cropOf,
  effectOf,
  hasEffects,
  isWholePicture,
  resetClipCrop,
  resetClipEffects,
  setClipAngle,
  setClipCrop,
  setClipCropShape,
  setClipEffect,
  setClipFilter,
  setClipFilterStrength,
  setClipFlip,
  setClipRotate,
  strengthOf,
  turnedAspect,
  type EffectKey,
} from "@/lib/editorFx";
import { Disclosure, RadioChips, SliderRow, ToggleRow } from "./FxControls";
import { ClipMoveSection } from "./ClipMotionSections";

/**
 * The selected clip's look and effects, and its crop and tilt, as two native
 * sections of the inspector. They read the clip from the model and report every
 * change as a new model through `apply` (one undo step per change, one per
 * slider drag), so undo, the local draft and Save carry them with no extra
 * wiring. `showClip` moves the playhead onto the clip when it is not on screen,
 * so the change is seen.
 */

const quiet =
  "btn-quiet inline-flex min-h-11 items-center gap-1.5 self-start px-3 py-1.5 text-xs aria-disabled:cursor-default aria-disabled:opacity-50";

type Apply = (next: EditorModel, group?: string) => void;

export function ClipEffectsSection({
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
  const fx = t.editor.fx;
  const e = fx.effects;
  const id = clip.id;
  const edit = (next: EditorModel, group?: string) => {
    apply(next, group);
    showClip(id);
  };
  const active = hasEffects(clip);
  const slider = (key: EffectKey, label: string) => {
    const r = EFFECT_RANGES[key];
    const v = effectOf(clip, key);
    return (
      <SliderRow
        key={key}
        label={label}
        value={v}
        min={r.min}
        max={r.max}
        step={r.step}
        text={
          key === "blur"
            ? fmt(e.blurValue, { v })
            : fmt(fx.percent, { v: Math.round(v * 100) })
        }
        onChange={(n, group) => edit(setClipEffect(model, id, key, n), group)}
      />
    );
  };
  return (
    <Disclosure title={e.title} active={active} testId="clip-effects">
      <RadioChips
        legend={e.lookLegend}
        options={[
          { value: "none", label: e.lookNone },
          ...FILTERS.map((f) => ({ value: f as string, label: e.looks[f] })),
        ]}
        value={clip.filter ?? "none"}
        onChange={(v) =>
          edit(setClipFilter(model, id, v === "none" ? null : (v as (typeof FILTERS)[number])))
        }
        columns="8.5rem"
        testId="clip-look"
      />
      {clip.filter ? (
        <SliderRow
          label={e.strength}
          value={strengthOf(clip)}
          min={0}
          max={1}
          step={STRENGTH_STEP}
          text={fmt(fx.percent, { v: Math.round(strengthOf(clip) * 100) })}
          onChange={(n, group) => edit(setClipFilterStrength(model, id, n), group)}
        />
      ) : null}
      {slider("vignette", e.vignette)}
      {slider("blur", e.blur)}
      {slider("sharpen", e.sharpen)}
      {slider("grain", e.grain)}
      {effectOf(clip, "sharpen") > 0 || effectOf(clip, "grain") > 0 ? (
        <p className="m-0 text-xs text-[var(--color-muted)]">{e.notDrawn}</p>
      ) : null}
      <fieldset className="m-0 flex min-w-0 flex-col gap-0 border-0 p-0">
        <legend className="mb-1 p-0 text-xs text-[var(--color-muted)]">
          {e.mirrorLegend}
        </legend>
        <ToggleRow
          label={e.flipH}
          checked={Boolean(clip.flip_h)}
          onChange={(on) => edit(setClipFlip(model, id, "h", on))}
        />
        <ToggleRow
          label={e.flipV}
          checked={Boolean(clip.flip_v)}
          onChange={(on) => edit(setClipFlip(model, id, "v", on))}
        />
      </fieldset>
      <RadioChips
        legend={e.turnLegend}
        options={ROTATIONS.map((r) => ({ value: r, label: e.turns[String(r) as keyof typeof e.turns] }))}
        value={clip.rotate ?? 0}
        onChange={(r) => edit(setClipRotate(model, id, r))}
        hint={e.turnHint}
        testId="clip-rotate"
      />
      <button
        type="button"
        className={quiet}
        aria-disabled={!active || undefined}
        onClick={() => {
          if (active) edit(resetClipEffects(model, id));
        }}
      >
        {e.reset}
      </button>
      <p className="m-0 text-xs text-[var(--color-muted)]">{e.hint}</p>
    </Disclosure>
  );
}

// ── crop and tilt ───────────────────────────────────────────────────────────

/** The part of the picture that is kept, as a small drawing: a box of the
 *  turned picture's shape with the kept rectangle lit. */
function CropMap({ aspect, rect }: { aspect: number; rect: ReturnType<typeof cropOf> }) {
  const { t } = useI18n();
  const c = t.editor.fx.crop;
  const p = (v: number) => Math.round(v * 100);
  return (
    <div
      role="img"
      aria-label={fmt(c.map, { x: p(rect.x), y: p(rect.y), w: p(rect.w), h: p(rect.h) })}
      data-testid="crop-map"
      className="relative mx-auto w-full max-w-40 overflow-hidden rounded-[var(--ns-r-chip)] border border-[var(--color-border)] bg-[var(--ns-key)]"
      style={{ aspectRatio: String(aspect) }}
    >
      <div
        aria-hidden
        className="absolute border-2 border-dashed border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_18%,transparent)]"
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.w * 100}%`,
          height: `${rect.h * 100}%`,
        }}
      />
    </div>
  );
}

/** The tilt's number box: type an angle; commits on Enter or leaving the box. */
function AngleBox({
  value,
  label,
  onCommit,
}: {
  value: number;
  label: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const v = Number(draft.replace(",", "."));
    if (draft.trim() !== "" && Number.isFinite(v) && v !== value) onCommit(v);
    else setDraft(String(value));
  };
  return (
    <input
      type="number"
      inputMode="decimal"
      value={draft}
      min={-ANGLE_MAX}
      max={ANGLE_MAX}
      step={1}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      className="min-h-11 w-24 rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] sm:text-[13px]"
    />
  );
}

/** The shapes the crop can be set to, as width / height (the frame's own shape first). */
const SHAPES = [
  ["square", 1],
  ["tall", 9 / 16],
  ["wide", 16 / 9],
  ["portrait", 4 / 5],
] as const;

export function ClipCropSection({
  model,
  clip,
  source,
  apply,
  showClip,
}: {
  model: EditorModel;
  clip: VideoClip;
  source: Pick<EditorAsset, "width" | "height"> | null;
  apply: Apply;
  showClip: (id: string) => void;
}) {
  const { t } = useI18n();
  const fx = t.editor.fx;
  const c = fx.crop;
  const uid = useId();
  const id = clip.id;
  const edit = (next: EditorModel, group?: string) => {
    apply(next, group);
    showClip(id);
  };
  const rect = cropOf(clip);
  const picture = turnedAspect(clip, source);
  const frameAspect = model.width / model.height;
  const shapes: [string, number | null][] = [
    ["whole", null],
    ["frame", frameAspect],
    ...SHAPES.map(([k, a]) => [k, a] as [string, number]),
  ];
  // The lit shape is the one the crop is exactly (a hand-set crop lights none).
  const lit = isWholePicture(rect)
    ? "whole"
    : picture === null
      ? null
      : (shapes.find(([, a]) => {
          if (a === null) return false;
          const want = cropForAspect(a, picture);
          return (
            want.x === rect.x && want.y === rect.y && want.w === rect.w && want.h === rect.h
          );
        })?.[0] ?? null);
  const angle = angleOf(clip);
  const pctText = (v: number) => fmt(fx.percent, { v: Math.round(v * 100) });
  const row = (
    key: "x" | "y" | "w" | "h",
    label: string,
    min: number,
    max: number,
  ) => (
    <SliderRow
      key={key}
      label={label}
      value={rect[key]}
      min={min}
      max={max}
      step={CROP_STEP}
      text={pctText(rect[key])}
      onChange={(n, group) => edit(setClipCrop(model, id, { [key]: n }), group)}
    />
  );
  return (
    <Disclosure
      title={c.title}
      active={!isWholePicture(rect) || angle !== 0}
      testId="clip-crop"
    >
      <CropMap aspect={picture ?? frameAspect} rect={rect} />
      <RadioChips
        legend={c.shapeLegend}
        options={shapes.map(([k, a]) => ({
          value: k,
          label: c.shapes[k as keyof typeof c.shapes],
          disabled: a !== null && picture === null,
        }))}
        value={lit}
        onChange={(k) => {
          const a = shapes.find(([name]) => name === k)?.[1] ?? null;
          edit(setClipCropShape(model, id, a, picture));
        }}
        hint={picture === null ? c.unknownSize : undefined}
        columns="8rem"
        testId="crop-shape"
      />
      {row("x", c.left, 0, Math.max(0, Math.round((1 - rect.w) * 1000) / 1000))}
      {row("y", c.top, 0, Math.max(0, Math.round((1 - rect.h) * 1000) / 1000))}
      {row("w", c.width, CROP_MIN, 1)}
      {row("h", c.height, CROP_MIN, 1)}
      <button
        type="button"
        className={quiet}
        aria-disabled={isWholePicture(rect) || undefined}
        onClick={() => {
          if (!isWholePicture(rect)) edit(resetClipCrop(model, id));
        }}
      >
        {c.reset}
      </button>
      <p className="m-0 text-xs text-[var(--color-muted)]">{c.hint}</p>
      <div className="flex min-w-0 items-end gap-2">
        <div className="min-w-0 flex-1">
          <SliderRow
            label={c.angle}
            value={angle}
            min={-ANGLE_MAX}
            max={ANGLE_MAX}
            step={1}
            text={fmt(fx.degrees, { v: angle })}
            describedBy={`${uid}-angle`}
            onChange={(n, group) => edit(setClipAngle(model, id, n), group)}
          />
        </div>
        <AngleBox
          value={angle}
          label={c.angle}
          onCommit={(v) => edit(setClipAngle(model, id, v))}
        />
      </div>
      <button
        type="button"
        className={quiet}
        aria-disabled={angle === 0 || undefined}
        onClick={() => {
          if (angle !== 0) edit(setClipAngle(model, id, 0));
        }}
      >
        {c.angleReset}
      </button>
      <p id={`${uid}-angle`} className="m-0 text-xs text-[var(--color-muted)]">
        {c.angleHint}
      </p>
    </Disclosure>
  );
}

/** Every effect section of the clip inspector, in order. */
export function ClipFxSections({
  model,
  clip,
  source,
  still,
  apply,
  showClip,
}: {
  model: EditorModel;
  clip: VideoClip;
  source: Pick<EditorAsset, "width" | "height"> | null;
  /** A photo: some moves differ (it has an automatic slow zoom). */
  still: boolean;
  apply: Apply;
  showClip: (id: string) => void;
}) {
  return (
    <>
      <ClipEffectsSection model={model} clip={clip} apply={apply} showClip={showClip} />
      <ClipCropSection
        model={model}
        clip={clip}
        source={source}
        apply={apply}
        showClip={showClip}
      />
      <ClipMoveSection
        model={model}
        clip={clip}
        still={still}
        apply={apply}
        showClip={showClip}
      />
    </>
  );
}
