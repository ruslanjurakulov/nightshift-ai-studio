"use client";

import { useEffect, useId, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import {
  INTERP_MAX_FRAMES,
  INTERP_MAX_FRAMES_DOC,
  MOVE_ZOOM_MAX,
  MOVE_ZOOM_MIN,
  OVERLAY_W_MAX,
  OVERLAY_W_MIN,
  RAMP_MAX_POINTS,
  RAMP_MIN_GAP,
  RAMP_MIN_POINTS,
  SPEEDS,
  SPEED_MAX,
  SPEED_MIN,
  clipLength,
  formatTime,
  type EditorModel,
  type PictureOverlay,
  type SpeedPoint,
  type VideoClip,
} from "@/lib/editor";
import {
  CURVE_PRESETS,
  FREEZE_HOLD_S,
  MOVE_PRESETS,
  OVERLAY_END_KEYS,
  addCurvePoint,
  canAddCurvePoint,
  centreHeld,
  centreRange,
  clearOverlayMove,
  curveFromSpeeds,
  curveOf,
  freezeAtPlayhead,
  interpolateCheck,
  interpolateFrames,
  interpolateUsedByOthers,
  movePresetOf,
  moveOf,
  overlayEndOf,
  removeCurvePoint,
  reverseCheck,
  reverseLimit,
  setClipCurve,
  setClipFreeze,
  setClipInterpolate,
  setClipMove,
  setClipReverse,
  setClipSpeed,
  setCurvePoint,
  setMovePoint,
  setOverlayEnd,
  slowOpacityMove,
  sourceRange,
  startOverlayMove,
  type CurvePresetId,
  type MovePresetId,
  type MoveWindow,
  type OverlayKeyframeKey,
} from "@/lib/editorMotion";
import { Disclosure, RadioChips, SliderRow, ToggleRow } from "./FxControls";

/**
 * The motion panels of the inspector: Zoom and pan of a clip, the end position
 * of an overlay, and the clip's speed, direction, freeze, speed curve and
 * slow-motion smoothing. Each reads from the model and reports a new model
 * through `apply` (one undo step per change, one per slider drag). Whatever the
 * document refuses is made impossible here and the reason is on the screen, with
 * the number that decides it.
 */

type Apply = (next: EditorModel, group?: string) => void;
const pct = (v: number) => Math.round(v * 100);
/** A limit as it is said: rounded DOWN to a tenth, so it is never more than it is. */
const shownSeconds = (v: number) => Math.floor(v * 10) / 10;
const quiet =
  "btn-quiet inline-flex min-h-11 items-center gap-1.5 self-start px-3 py-1.5 text-xs aria-disabled:cursor-default aria-disabled:opacity-50";
const note = "m-0 text-xs text-[var(--color-muted)]";

// ── zoom and pan ────────────────────────────────────────────────────────────

/** The two zoom windows over the whole picture, as a small drawing: dashed at
 *  the start of the clip, solid at the end. */
function MoveMap({
  aspect,
  from,
  to,
}: {
  aspect: number;
  from: MoveWindow;
  to: MoveWindow;
}) {
  const { t } = useI18n();
  const m = t.editor.fx.move;
  const rect = (w: MoveWindow) => {
    const r = centreRange(w.zoom);
    const cx = Math.min(r.max, Math.max(r.min, w.x));
    const cy = Math.min(r.max, Math.max(r.min, w.y));
    return {
      left: `${(cx - 0.5 / w.zoom) * 100}%`,
      top: `${(cy - 0.5 / w.zoom) * 100}%`,
      width: `${100 / w.zoom}%`,
      height: `${100 / w.zoom}%`,
    };
  };
  return (
    <div
      role="img"
      data-testid="move-map"
      aria-label={fmt(m.map, {
        z1: from.zoom,
        x1: pct(from.x),
        y1: pct(from.y),
        z2: to.zoom,
        x2: pct(to.x),
        y2: pct(to.y),
      })}
      className="relative mx-auto w-full max-w-40 overflow-hidden rounded-[var(--ns-r-chip)] border border-[var(--color-border)] bg-[var(--ns-key)]"
      style={{ aspectRatio: String(aspect) }}
    >
      <div
        aria-hidden
        className="absolute border-2 border-dashed border-[var(--color-muted)]"
        style={rect(from)}
      />
      <div
        aria-hidden
        className="absolute border-2 border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)]"
        style={rect(to)}
      />
    </div>
  );
}

export function ClipMoveSection({
  model,
  clip,
  still,
  apply,
  showClip,
}: {
  model: EditorModel;
  clip: VideoClip;
  still: boolean;
  apply: Apply;
  showClip: (id: string) => void;
}) {
  const { t } = useI18n();
  const fx = t.editor.fx;
  const m = fx.move;
  const id = clip.id;
  const edit = (next: EditorModel, group?: string) => {
    apply(next, group);
    showClip(id);
  };
  const mv = moveOf(clip);
  const preset = movePresetOf(clip);
  const presets = (Object.keys(MOVE_PRESETS) as MovePresetId[]).filter(
    (k) => k !== "hold" || still,
  );
  const end = (which: "from" | "to", legend: string) => {
    if (!mv) return null;
    const w = mv[which];
    const r = centreRange(w.zoom);
    return (
      <fieldset
        key={which}
        className="m-0 flex min-w-0 flex-col gap-0 border-0 p-0"
        data-testid={`move-${which}`}
      >
        <legend className="mb-1 p-0 text-xs font-semibold text-[var(--color-fg)]">
          {legend}
        </legend>
        <SliderRow
          label={m.zoom}
          value={w.zoom}
          min={MOVE_ZOOM_MIN}
          max={MOVE_ZOOM_MAX}
          step={0.05}
          text={fmt(m.zoomValue, { v: w.zoom })}
          onChange={(v, g) => edit(setMovePoint(model, id, which, { zoom: v }), g)}
        />
        <SliderRow
          label={m.centreX}
          value={w.x}
          min={0}
          max={1}
          step={0.01}
          text={fmt(fx.percent, { v: pct(w.x) })}
          onChange={(v, g) => edit(setMovePoint(model, id, which, { x: v }), g)}
        />
        <SliderRow
          label={m.centreY}
          value={w.y}
          min={0}
          max={1}
          step={0.01}
          text={fmt(fx.percent, { v: pct(w.y) })}
          onChange={(v, g) => edit(setMovePoint(model, id, which, { y: v }), g)}
        />
        {w.zoom === 1 ? (
          <p className={note}>{m.wholePicture}</p>
        ) : centreHeld(w) ? (
          <p className={note}>
            {m.held} ({fmt(fx.percent, { v: pct(r.min) })}–{fmt(fx.percent, { v: pct(r.max) })})
          </p>
        ) : null}
      </fieldset>
    );
  };
  return (
    <Disclosure title={m.title} active={Boolean(clip.move)} testId="clip-move-section">
      <RadioChips
        legend={m.legend}
        options={[
          { value: "none", label: m.none },
          ...presets.map((k) => ({ value: k as string, label: m.presets[k] })),
        ]}
        value={clip.move ? (preset ?? null) : "none"}
        onChange={(v) =>
          edit(
            setClipMove(model, id, v === "none" ? null : MOVE_PRESETS[v as MovePresetId]),
          )
        }
        hint={clip.move && !preset ? m.custom : undefined}
        columns="9rem"
        testId="move-preset"
      />
      {mv ? (
        <>
          <MoveMap aspect={model.width / model.height} from={mv.from} to={mv.to} />
          {end("from", m.startLegend)}
          {end("to", m.endLegend)}
        </>
      ) : null}
      {still ? <p className={note}>{m.stillAuto}</p> : null}
      <p className={note}>{m.hint}</p>
    </Disclosure>
  );
}

// ── an overlay's end position ───────────────────────────────────────────────

export function OverlayMoveSection({
  model,
  overlay,
  apply,
}: {
  model: EditorModel;
  overlay: PictureOverlay;
  apply: Apply;
}) {
  const { t } = useI18n();
  const fx = t.editor.fx;
  const m = fx.overlayMove;
  const id = overlay.id;
  const end = overlayEndOf(overlay);
  const labels: Record<OverlayKeyframeKey, string> = {
    x: m.endX,
    y: m.endY,
    w: m.endW,
    opacity: m.endOpacity,
  };
  return (
    <Disclosure title={m.title} active={Boolean(overlay.move)} testId="overlay-move-section">
      <ToggleRow
        label={m.toggle}
        checked={Boolean(overlay.move)}
        onChange={(on) =>
          apply(on ? startOverlayMove(model, id) : clearOverlayMove(model, id))
        }
      />
      {overlay.move ? (
        <>
          {OVERLAY_END_KEYS.map((k) => {
            const same = overlay.move?.to[k] === undefined;
            return (
              <SliderRow
                key={k}
                label={labels[k]}
                value={end[k]}
                min={k === "w" ? OVERLAY_W_MIN : 0}
                max={k === "w" ? OVERLAY_W_MAX : 1}
                step={0.01}
                text={`${fmt(fx.percent, { v: pct(end[k]) })}${same ? ` · ${m.sameAsStart}` : ""}`}
                onChange={(v, g) => apply(setOverlayEnd(model, id, k, v), g)}
              />
            );
          })}
          {slowOpacityMove(overlay) ? <p className={note}>{m.slowOpacity}</p> : null}
        </>
      ) : null}
      <p className={note}>{m.hint}</p>
    </Disclosure>
  );
}

// ── speed, direction, freeze, curve, slow motion ────────────────────────────

/** The speed in the number box: commits on Enter or leaving the box, brought into range. */
function SpeedBox({
  value,
  label,
  disabled,
  onCommit,
}: {
  value: number;
  label: string;
  disabled: boolean;
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
      min={SPEED_MIN}
      max={SPEED_MAX}
      step={0.05}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      className="min-h-11 w-28 rounded-[var(--ns-r-key)] border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)] disabled:opacity-50 sm:text-[13px]"
    />
  );
}

/** Speed over the clip as a small line drawing (speed on a log scale from the
 *  slowest to the fastest the document allows). The point rows are the control. */
function CurvePlot({ points }: { points: readonly SpeedPoint[] }) {
  const { t } = useI18n();
  const c = t.editor.fx.speed.curve;
  const y = (s: number) =>
    36 - (36 * Math.log(s / SPEED_MIN)) / Math.log(SPEED_MAX / SPEED_MIN);
  const path = points.map((p) => `${p.at * 100},${y(p.speed).toFixed(2)}`).join(" ");
  const label = fmt(c.graph, {
    points: points
      .map((p) => fmt(c.graphPoint, { at: pct(p.at), speed: p.speed }))
      .join("; "),
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="-2 -2 104 40"
      className="h-24 w-full rounded-[var(--ns-r-chip)] border border-[var(--color-border)] bg-[var(--ns-key)]"
      data-testid="curve-plot"
    >
      <line
        x1="0"
        x2="100"
        y1={y(1)}
        y2={y(1)}
        stroke="var(--color-muted)"
        strokeDasharray="2 2"
        strokeWidth="0.5"
      />
      <polyline
        points={path}
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {points.map((p, i) => (
        <circle key={i} cx={p.at * 100} cy={y(p.speed)} r="1.8" fill="var(--color-primary)" />
      ))}
    </svg>
  );
}

function CurveEditor({
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
  const c = fx.speed.curve;
  const id = clip.id;
  const curve = curveOf(clip);
  const edit = (next: EditorModel, group?: string) => {
    apply(next, group);
    showClip(id);
  };
  const presetNow = curve
    ? ((Object.keys(CURVE_PRESETS) as CurvePresetId[]).find(
        (k) =>
          JSON.stringify(curveFromSpeeds(CURVE_PRESETS[k])) === JSON.stringify(curve),
      ) ?? null)
    : null;
  return (
    <Disclosure title={c.title} active={Boolean(curve)} testId="speed-curve">
      <ToggleRow
        label={c.toggle}
        checked={Boolean(curve)}
        onChange={(on) =>
          edit(
            on
              ? setClipCurve(model, id, curveFromSpeeds(CURVE_PRESETS.slowEnd))
              : setClipCurve(model, id, null),
          )
        }
        hint={c.replaces}
      />
      {curve ? (
        <>
          <RadioChips
            legend={c.presetsLegend}
            options={(Object.keys(CURVE_PRESETS) as CurvePresetId[]).map((k) => ({
              value: k as string,
              label: c.presets[k],
            }))}
            value={presetNow}
            onChange={(k) =>
              edit(setClipCurve(model, id, curveFromSpeeds(CURVE_PRESETS[k as CurvePresetId])))
            }
            columns="9rem"
            testId="curve-presets"
          />
          <CurvePlot points={curve} />
          {curve.map((p, i) => {
            const edge = i === 0 || i === curve.length - 1;
            const lo = i === 0 ? 0 : curve[i - 1].at + RAMP_MIN_GAP;
            const hi = i === curve.length - 1 ? 1 : curve[i + 1].at - RAMP_MIN_GAP;
            return (
              <fieldset
                key={i}
                className="m-0 flex min-w-0 flex-col gap-0 border-0 p-0"
                data-testid={`curve-point-${i}`}
              >
                <legend className="mb-1 p-0 text-xs font-semibold text-[var(--color-fg)]">
                  {i === 0 ? c.atStart : i === curve.length - 1 ? c.atEnd : fmt(c.point, { n: i + 1 })}
                </legend>
                {edge ? null : (
                  <SliderRow
                    label={`${c.at} (${fmt(c.point, { n: i + 1 })})`}
                    value={p.at}
                    min={Math.round(lo * 1000) / 1000}
                    max={Math.round(hi * 1000) / 1000}
                    step={0.01}
                    text={fmt(fx.percent, { v: pct(p.at) })}
                    onChange={(v, g) => edit(setCurvePoint(model, id, i, { at: v }), g)}
                  />
                )}
                <SliderRow
                  label={`${c.speed} (${
                    i === 0 ? c.atStart : i === curve.length - 1 ? c.atEnd : fmt(c.point, { n: i + 1 })
                  })`}
                  value={p.speed}
                  min={SPEED_MIN}
                  max={SPEED_MAX}
                  step={0.05}
                  text={fmt(t.editor.speedValue, { x: p.speed })}
                  onChange={(v, g) => edit(setCurvePoint(model, id, i, { speed: v }), g)}
                />
                {!edge ? (
                  <button
                    type="button"
                    className={quiet}
                    aria-disabled={curve.length <= RAMP_MIN_POINTS || undefined}
                    onClick={() => {
                      if (curve.length > RAMP_MIN_POINTS) edit(removeCurvePoint(model, id, i));
                    }}
                  >
                    {fmt(c.remove, { n: i + 1 })}
                  </button>
                ) : null}
              </fieldset>
            );
          })}
          <button
            type="button"
            className={quiet}
            aria-disabled={!canAddCurvePoint(clip) || undefined}
            onClick={() => {
              if (canAddCurvePoint(clip)) edit(addCurvePoint(model, id));
            }}
          >
            {c.add}
          </button>
          {!canAddCurvePoint(clip) ? (
            <p className={note}>{fmt(c.maxPoints, { max: RAMP_MAX_POINTS })}</p>
          ) : null}
          <p className={note} data-testid="curve-length">
            {fmt(c.length, {
              len: formatTime(clipLength(clip)),
              range: formatTime(sourceRange(clip)),
            })}
          </p>
        </>
      ) : null}
      <p className={note}>
        {fmt(c.hint, {
          min: RAMP_MIN_POINTS,
          max: RAMP_MAX_POINTS,
          smin: SPEED_MIN,
          smax: SPEED_MAX,
        })}
      </p>
    </Disclosure>
  );
}

export function ClipSpeedSection({
  model,
  clip,
  still,
  playhead,
  apply,
  showClip,
  onFrozen,
}: {
  model: EditorModel;
  clip: VideoClip;
  /** A photo has a constant speed only; the rest is for video. */
  still: boolean;
  playhead: number;
  apply: Apply;
  showClip: (id: string) => void;
  /** The clip made by "Freeze the frame at the playhead". */
  onFrozen: (newId: string) => void;
}) {
  const { t } = useI18n();
  const te = t.editor;
  const fx = te.fx;
  const s = fx.speed;
  const uid = useId();
  const id = clip.id;
  const edit = (next: EditorModel, group?: string) => {
    apply(next, group);
    showClip(id);
  };
  const curve = curveOf(clip);
  const rev = reverseCheck(model, clip);
  const interp = interpolateCheck(model, clip);
  const used = interpolateUsedByOthers(model, id);
  const freezeHere = freezeAtPlayhead(model, id, playhead);
  const speedChips = (
    <RadioChips
      legend={te.speed}
      options={SPEEDS.map((v) => ({
        value: v,
        label: fmt(te.speedValue, { x: v }),
        disabled: Boolean(clip.freeze),
      }))}
      value={curve || clip.freeze ? null : clip.speed}
      onChange={(v) => edit(setClipSpeed(model, id, v))}
      hint={
        clip.freeze ? s.frozenNoSpeed : curve ? s.curveReplaces : undefined
      }
      testId="speed-chips"
    />
  );
  if (still)
    return (
      <>
        {speedChips}
        <p className={note}>{s.photoNote}</p>
      </>
    );
  return (
    <>
      {speedChips}
      <label className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-muted)]">
        <span className="min-w-0">{fmt(s.custom, { min: SPEED_MIN, max: SPEED_MAX })}</span>
        <SpeedBox
          value={curve ? 1 : clip.speed}
          label={fmt(s.custom, { min: SPEED_MIN, max: SPEED_MAX })}
          disabled={Boolean(clip.freeze)}
          onCommit={(v) => edit(setClipSpeed(model, id, v))}
        />
      </label>
      <Disclosure
        title={s.more}
        active={Boolean(clip.reverse || clip.freeze || curve || clip.interpolate)}
        testId="speed-more"
      >
      <ToggleRow
        label={s.reverse}
        checked={Boolean(clip.reverse)}
        disabled={!clip.reverse && !rev.ok}
        onChange={(on) => edit(setClipReverse(model, id, on))}
        testId="reverse"
        hint={
          <>
            {s.reverseHint}{" "}
            {fmt(s.reverseLimit, {
              max: shownSeconds(reverseLimit(model)),
              w: model.width,
              h: model.height,
              fps: model.fps,
            })}
            {!clip.reverse && !rev.ok ? (
              <span className="mt-1 block text-[var(--color-warn)]">
                {fmt(s.reverseTooLong, { range: sourceRange(clip), max: shownSeconds(rev.max) })}
              </span>
            ) : null}
          </>
        }
      />
      <ToggleRow
        label={s.freeze}
        checked={Boolean(clip.freeze)}
        onChange={(on) => edit(setClipFreeze(model, id, on))}
        hint={s.freezeHint}
        testId="freeze"
      />
      <div className="flex flex-col gap-1">
        <button
          type="button"
          className={quiet}
          aria-disabled={!freezeHere || undefined}
          aria-describedby={`${uid}-fh`}
          onClick={() => {
            if (!freezeHere) return;
            apply(freezeHere.model);
            onFrozen(freezeHere.newId);
          }}
        >
          {s.freezeHere}
        </button>
        <p id={`${uid}-fh`} className={note}>
          {freezeHere
            ? fmt(s.freezeHereHint, { s: FREEZE_HOLD_S })
            : s.freezeHereWhy}
        </p>
      </div>
      <CurveEditor model={model} clip={clip} apply={apply} showClip={showClip} />
      <ToggleRow
        label={s.interpolate.toggle}
        checked={Boolean(clip.interpolate)}
        disabled={!clip.interpolate && !interp.ok}
        onChange={(on) => edit(setClipInterpolate(model, id, on))}
        testId="interpolate"
        hint={
          <>
            {fmt(s.interpolate.hint, {
              clipMax: INTERP_MAX_FRAMES,
              docMax: INTERP_MAX_FRAMES_DOC,
            })}{" "}
            {clip.interpolate
              ? fmt(s.interpolate.used, {
                  frames: Math.round(interpolateFrames(model, clip)),
                  clipMax: INTERP_MAX_FRAMES,
                  total: Math.round(used + interpolateFrames(model, clip)),
                  docMax: INTERP_MAX_FRAMES_DOC,
                })
              : null}
            {!clip.interpolate && !interp.ok ? (
              <span className="mt-1 block text-[var(--color-warn)]">
                {interp.reason === "not_slow"
                  ? s.interpolate.notSlow
                  : interp.reason === "direction"
                    ? s.interpolate.direction
                    : interp.reason === "clip_budget"
                      ? fmt(s.interpolate.clipBudget, {
                          frames: Math.round(interp.frames),
                          max: INTERP_MAX_FRAMES,
                          sec: interp.maxS,
                        })
                      : fmt(s.interpolate.docBudget, { docMax: INTERP_MAX_FRAMES_DOC })}
              </span>
            ) : null}
          </>
        }
      />
      </Disclosure>
    </>
  );
}
