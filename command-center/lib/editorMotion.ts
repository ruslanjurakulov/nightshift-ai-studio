/**
 * Moves, speed and playback direction: the pure model edits behind the Zoom
 * and pan, overlay move, Speed, reverse, freeze, speed curve and slow-motion
 * panels (docs/editor-render-fields.md sections 4, 6 and 9).
 *
 * The document refuses many combinations; here each is made impossible and the
 * reason is decidable from numbers a panel can show:
 *
 *   * a frozen clip has speed 1, no sound, no reverse, no curve, nothing to
 *     interpolate or stabilise; a reversed clip has no freeze, curve or
 *     interpolation; a speed curve replaces the constant speed and excludes
 *     reverse and freeze; interpolation needs a part that plays below speed 1;
 *   * reverse holds its whole range in memory: `reverseLimit`;
 *   * interpolation has a frame budget per clip and per project: `interpolateCheck`.
 *
 * Every function returns the SAME model when nothing changes (not an undo
 * step) and clamps to the document's own limits, imported from lib/editor.ts.
 */
import { shapeWorkSeconds } from "@/lib/editorShapes";
import {
  INTERP_MAX_FRAMES,
  INTERP_MAX_FRAMES_DOC,
  INTERP_MAX_PIXELS,
  INTERP_SECONDS_PER_FRAME,
  MAX_EDITOR_CLIPS,
  MAX_PARTIAL_OPACITY_MOVES,
  MIN_CLIP_S,
  MOVE_POINT_DEFAULTS,
  MOVE_ZOOM_MAX,
  MOVE_ZOOM_MIN,
  OVERLAY_W_MAX,
  OVERLAY_W_MIN,
  RAMP_MAX_POINTS,
  RAMP_MIN_GAP,
  RAMP_MIN_POINTS,
  RENDER_PLAIN_FACTOR,
  SPEED_MAX,
  SPEED_MIN,
  STABILIZE_MAX_DOC_S,
  STABILIZE_MAX_S,
  XFADE_LARGE_ZOOM_MAX,
  clamp,
  freshId,
  interpolatedFrames,
  layout,
  modelDuration,
  ms,
  partialOpacityMove,
  renderTimeoutS,
  reverseMaxSeconds,
  setSpeed,
  splitClip,
  stabilizeSeconds,
  toDoc,
  trimClip,
  validateTimeline,
  type ClipMove,
  type EditorModel,
  type MovePoint,
  type OverlayMoveTo,
  type PictureOverlay,
  type SpeedPoint,
  type VideoClip,
} from "@/lib/editor";

import { isCrossfaded, isLargeFrame } from "@/lib/editorFx";

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const finite = (v: number, d: number) => (Number.isFinite(v) ? v : d);

function withClip(
  model: EditorModel,
  id: string,
  f: (c: VideoClip) => VideoClip,
  relayout = false,
): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  if (!at) return model;
  const next = f(at);
  if (next === at) return model;
  const clips = model.clips.map((c) => (c.id === id ? next : c));
  return { ...model, clips: relayout ? layout(clips) : clips };
}

function drop(c: VideoClip, ...keys: (keyof VideoClip)[]): VideoClip {
  const out = { ...c };
  for (const k of keys) delete out[k];
  return out;
}

// ── zoom and pan of a clip (Ken Burns) ──────────────────────────────────────

export type MoveWindow = { zoom: number; x: number; y: number };
export type ClipMoveFull = { from: MoveWindow; to: MoveWindow };

export function windowOf(p: MovePoint | undefined): MoveWindow {
  return { ...MOVE_POINT_DEFAULTS, ...(p ?? {}) } as MoveWindow;
}

/** The clip's move with the document's defaults filled in, or null. */
export function moveOf(clip: Pick<VideoClip, "move">): ClipMoveFull | null {
  return clip.move
    ? { from: windowOf(clip.move.from), to: windowOf(clip.move.to) }
    : null;
}

/** The centre range a window of this zoom can have and stay inside the picture. */
export function centreRange(zoom: number): { min: number; max: number } {
  const half = 0.5 / Math.max(1, zoom);
  return { min: half, max: 1 - half };
}

/** Is the window's centre somewhere the export will move it (it holds a window
 *  inside the picture)? Zoom 1 shows the whole picture whatever the centre. */
export function centreHeld(w: MoveWindow): boolean {
  const r = centreRange(w.zoom);
  return (
    w.x < r.min - 1e-9 || w.x > r.max + 1e-9 || w.y < r.min - 1e-9 || w.y > r.max + 1e-9
  );
}

/** The most zoom a clip's move may have: the document's, except on a cross-faded
 *  clip in a frame above 1440p, where the export would run out of memory. */
export function zoomLimit(model: EditorModel, id: string): number {
  return isLargeFrame(model) && isCrossfaded(model, id) ? XFADE_LARGE_ZOOM_MAX : MOVE_ZOOM_MAX;
}

const cleanWindow = (w: MoveWindow, top: number = MOVE_ZOOM_MAX): MoveWindow => ({
  zoom: round3(clamp(finite(w.zoom, 1), MOVE_ZOOM_MIN, top)),
  x: round3(clamp(finite(w.x, 0.5), 0, 1)),
  y: round3(clamp(finite(w.y, 0.5), 0, 1)),
});

/** Ready moves: a gentle zoom in or out, a pan across, and (photos) holding still. */
export const MOVE_PRESETS = {
  zoomIn: {
    from: { zoom: 1, x: 0.5, y: 0.5 },
    to: { zoom: 1.5, x: 0.5, y: 0.5 },
  },
  zoomOut: {
    from: { zoom: 1.5, x: 0.5, y: 0.5 },
    to: { zoom: 1, x: 0.5, y: 0.5 },
  },
  panRight: {
    from: { zoom: 1.5, x: 0.333, y: 0.5 },
    to: { zoom: 1.5, x: 0.667, y: 0.5 },
  },
  panLeft: {
    from: { zoom: 1.5, x: 0.667, y: 0.5 },
    to: { zoom: 1.5, x: 0.333, y: 0.5 },
  },
  hold: {
    from: { zoom: 1, x: 0.5, y: 0.5 },
    to: { zoom: 1, x: 0.5, y: 0.5 },
  },
} as const satisfies Record<string, ClipMoveFull>;
export type MovePresetId = keyof typeof MOVE_PRESETS;

/** The preset a move is exactly (null for a hand-made one). */
export function movePresetOf(clip: Pick<VideoClip, "move">): MovePresetId | null {
  const m = moveOf(clip);
  if (!m) return null;
  const same = (a: MoveWindow, b: MoveWindow) =>
    a.zoom === b.zoom && a.x === b.x && a.y === b.y;
  return (
    (Object.keys(MOVE_PRESETS) as MovePresetId[]).find(
      (k) => same(m.from, MOVE_PRESETS[k].from) && same(m.to, MOVE_PRESETS[k].to),
    ) ?? null
  );
}

/** Set (or, with null, remove) a clip's move. */
export function setClipMove(
  model: EditorModel,
  id: string,
  move: ClipMoveFull | null,
): EditorModel {
  return withClip(model, id, (c) => {
    if (move === null) return c.move ? drop(c, "move") : c;
    const top = zoomLimit(model, id);
    const next: ClipMove = { from: cleanWindow(move.from, top), to: cleanWindow(move.to, top) };
    return JSON.stringify(next) === JSON.stringify(c.move) ? c : { ...c, move: next };
  });
}

/** Change one end of the move (it starts from a gentle zoom in when there is none). */
export function setMovePoint(
  model: EditorModel,
  id: string,
  end: "from" | "to",
  patch: Partial<MoveWindow>,
): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  if (!at) return model;
  const now = moveOf(at) ?? MOVE_PRESETS.zoomIn;
  // A value that is not a number leaves that number as it was.
  const given = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => typeof v === "number" && Number.isFinite(v)),
  );
  return setClipMove(model, id, { ...now, [end]: { ...now[end], ...given } });
}

// ── an overlay's end keyframe ───────────────────────────────────────────────

export type OverlayKeyframeKey = "x" | "y" | "w" | "opacity";
export const OVERLAY_END_KEYS: readonly OverlayKeyframeKey[] = ["x", "y", "w", "opacity"];

const overlayEndRange = (k: OverlayKeyframeKey) =>
  k === "w" ? { min: OVERLAY_W_MIN, max: OVERLAY_W_MAX } : { min: 0, max: 1 };

/** Where the overlay is going: each of x, y, w, opacity is the end value, or the
 *  overlay's own value when the move does not change it. */
export function overlayEndOf(o: PictureOverlay): Record<OverlayKeyframeKey, number> {
  const to = o.move?.to ?? {};
  return {
    x: to.x ?? o.x,
    y: to.y ?? o.y,
    w: to.w ?? o.w,
    opacity: to.opacity ?? o.opacity,
  };
}

function withOverlay(
  model: EditorModel,
  id: string,
  f: (o: PictureOverlay) => PictureOverlay,
): EditorModel {
  const list = model.overlays ?? [];
  const at = list.find((o) => o.id === id);
  if (!at) return model;
  const next = f(at);
  if (next === at) return model;
  return { ...model, overlays: list.map((o) => (o.id === id ? next : o)) };
}

function withMoveTo(o: PictureOverlay, to: OverlayMoveTo): PictureOverlay {
  const keys = Object.keys(to);
  const { move: _old, ...rest } = o;
  void _old;
  return keys.length ? { ...rest, move: { to } } : rest;
}

/** Turn the end keyframe on: the overlay drifts a quarter of the frame sideways
 *  (toward the middle when it sits on the right). */
export function startOverlayMove(model: EditorModel, id: string): EditorModel {
  return withOverlay(model, id, (o) => {
    if (o.move) return o;
    const x = o.x > 0.5 ? o.x - 0.25 : o.x + 0.25;
    return withMoveTo(o, { x: round3(clamp(x, 0, 1)) });
  });
}

export function clearOverlayMove(model: EditorModel, id: string): EditorModel {
  return withOverlay(model, id, (o) => (o.move ? withMoveTo(o, {}) : o));
}

/** Set where one value ends. A value equal to the overlay's own is dropped (it
 *  does not move); with nothing left the move goes. */
export function setOverlayEnd(
  model: EditorModel,
  id: string,
  key: OverlayKeyframeKey,
  value: number,
): EditorModel {
  return withOverlay(model, id, (o) => {
    const r = overlayEndRange(key);
    const v = round3(clamp(finite(value, o[key]), r.min, r.max));
    const to: OverlayMoveTo = { ...(o.move?.to ?? {}) };
    if (v === o[key]) delete to[key];
    else to[key] = v;
    if (JSON.stringify(to) === JSON.stringify(o.move?.to ?? {})) return o;
    const next = withMoveTo(o, to);
    // A third move between two visible opacities is refused by the document.
    if (partialOpacityMove(next) && !partialOpacityMove(o) && !canPartialOpacity(model, id)) return o;
    return next;
  });
}

/** The overlay's x, y, w and opacity at timeline time `t` (a straight line from
 *  its own values to the end keyframe over its span). */
export function overlayAt(
  o: PictureOverlay,
  t: number,
): Record<OverlayKeyframeKey, number> {
  if (!o.move) return { x: o.x, y: o.y, w: o.w, opacity: o.opacity };
  const end = overlayEndOf(o);
  const span = o.end_s - o.start_s;
  const p = span > 0 ? clamp((t - o.start_s) / span, 0, 1) : 0;
  const mix = (k: OverlayKeyframeKey) => o[k] + (end[k] - o[k]) * p;
  return { x: mix("x"), y: mix("y"), w: mix("w"), opacity: mix("opacity") };
}

/** Does the move change opacity between two visible values? That is rendered
 *  per pixel and is slow, so the document allows only MAX_PARTIAL_OPACITY_MOVES
 *  overlays like that (a fade to or from fully clear is cheap). */
export function slowOpacityMove(o: PictureOverlay): boolean {
  return partialOpacityMove(o);
}

/** How many OTHER overlays of the project already use such a move. */
export function partialMovesElsewhere(model: EditorModel, id: string): number {
  return (model.overlays ?? []).filter((o) => o.id !== id && partialOpacityMove(o)).length;
}

/** May this overlay change opacity between two visible values (the others have not used the allowance up)? */
export function canPartialOpacity(model: EditorModel, id: string): boolean {
  return partialMovesElsewhere(model, id) < MAX_PARTIAL_OPACITY_MOVES;
}

// ── speed, direction, freeze ────────────────────────────────────────────────

export function curveOf(clip: Pick<VideoClip, "speed_curve">): SpeedPoint[] | null {
  return clip.speed_curve && clip.speed_curve.length >= RAMP_MIN_POINTS
    ? clip.speed_curve
    : null;
}

/** The slowest speed a clip plays at (its curve's lowest point, or its speed). */
export function slowestSpeed(clip: Pick<VideoClip, "speed" | "speed_curve">): number {
  const c = curveOf(clip);
  return c ? Math.min(...c.map((p) => p.speed)) : clip.speed;
}

/** Interpolation is for slow motion: some part must play below speed 1. */
function dropStaleInterpolate(c: VideoClip): VideoClip {
  return c.interpolate &&
    (slowestSpeed(c) >= 1 || c.reverse || c.freeze)
    ? drop(c, "interpolate")
    : c;
}

/**
 * After an edit that changes a clip's speed or length: if the clip smooths slow
 * motion or is steadied and the export would no longer fit its time allowance
 * (or the budgets), the smoothing / steadying of THAT clip is switched off, so
 * the document stays one the export accepts. The panel then shows why it is off.
 */
export function settleBudgets(model: EditorModel, id: string): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  if (!at) return model;
  let m = model;
  if (at.interpolate && !interpolateCheck(m, at).ok) m = withClip(m, id, (c) => drop(c, "interpolate"));
  const now = m.clips.find((c) => c.id === id);
  if (now?.stabilize && !renderWork(m).ok) m = withClip(m, id, (c) => drop(c, "stabilize"));
  return m;
}

/** A constant speed (it replaces a curve and, if frozen, the freeze). */
export function setClipSpeed(model: EditorModel, id: string, speed: number): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  if (!at || at.freeze) return model;
  const s = clamp(ms(finite(speed, at.speed)), SPEED_MIN, SPEED_MAX);
  if (s === at.speed && !at.speed_curve) return model;
  const next = setSpeed(model, id, s);
  return settleBudgets(withClip(next, id, dropStaleInterpolate), id);
}

/** The longest source range that can play backwards at this project's size
 *  and rate, in seconds: the validator's own number (whole frames). */
export function reverseLimit(model: Pick<EditorModel, "width" | "height" | "fps">): number {
  return reverseMaxSeconds(model.width, model.height, model.fps);
}

export function sourceRange(c: Pick<VideoClip, "in_s" | "out_s">): number {
  return ms(ms(c.out_s) - ms(c.in_s));
}

export type ReverseCheck =
  | { ok: true }
  | { ok: false; reason: "too_long"; max: number; range: number };

/** Can this clip be played backwards? Not past the memory cap. (Turning it on
 *  takes a freeze off: a frozen clip is one frame.) */
export function reverseCheck(model: EditorModel, c: VideoClip): ReverseCheck {
  const max = reverseLimit(model);
  const range = sourceRange(c);
  if (range > max + 1e-9) return { ok: false, reason: "too_long", max, range };
  return { ok: true };
}

export function setClipReverse(model: EditorModel, id: string, on: boolean): EditorModel {
  return withClip(
    model,
    id,
    (c) => {
      if (Boolean(c.reverse) === on) return c;
      if (!on) return drop(c, "reverse");
      if (!reverseCheck(model, c).ok) return c;
      return { ...drop(c, "freeze", "speed_curve", "interpolate"), reverse: true };
    },
    true,
  );
}

/** Hold the frame at the start point for the clip's whole length (no sound, speed 1). */
export function setClipFreeze(model: EditorModel, id: string, on: boolean): EditorModel {
  return withClip(
    model,
    id,
    (c) => {
      if (Boolean(c.freeze) === on) return c;
      if (!on) return drop(c, "freeze");
      return {
        ...drop(c, "reverse", "speed_curve", "interpolate", "stabilize"),
        freeze: true,
        speed: 1,
        audio: false,
      };
    },
    true,
  );
}

/** How long a "freeze frame here" holds, to start with. */
export const FREEZE_HOLD_S = 2;

/**
 * Hold the picture at the playhead: split the clip there and put a frozen clip
 * of the frame at that moment between the halves (docs §6). Null when the clip
 * cannot be split there or there is no room for two more clips.
 */
export function freezeAtPlayhead(
  model: EditorModel,
  id: string,
  t: number,
  hold: number = FREEZE_HOLD_S,
): { model: EditorModel; newId: string } | null {
  if (model.clips.length + 2 > MAX_EDITOR_CLIPS) return null;
  const clip = layout(model.clips).find((c) => c.id === id);
  if (!clip || clip.freeze || clip.reverse) return null;
  const cut = splitClip(model, id, t);
  if (!cut) return null;
  const clips = layout(cut.model.clips);
  const i = clips.findIndex((c) => c.id === id);
  const first = clips[i];
  // the frame shown at the cut is the first half's last: its source out point
  const frameAt = first.out_s;
  const newId = freshId(cut.model, "c");
  // The held frame looks like the clip it was taken from (fit, colour, effects,
  // crop, turn) but has no sound, speed, fades, move or way in of its own.
  const held: VideoClip = {
    ...drop(
      first,
      "transition",
      "fade_in_s",
      "fade_out_s",
      "speed_curve",
      "reverse",
      "interpolate",
      "stabilize",
      "move",
      "denoise",
      "loudnorm",
    ),
    id: newId,
    start_s: 0,
    in_s: ms(frameAt),
    out_s: ms(frameAt + hold),
    speed: 1,
    audio: false,
    freeze: true,
  };
  const next = [...clips.slice(0, i + 1), held, ...clips.slice(i + 1)];
  return { model: { ...cut.model, clips: layout(next) }, newId };
}

// ── speed curve ─────────────────────────────────────────────────────────────

/** Ready shapes: speed at the start / middle / end of the clip. */
export const CURVE_PRESETS = {
  slowEnd: [1, 1, 0.25],
  fastStart: [4, 1],
  hero: [1, 0.25, 1],
  burst: [1, 4, 1],
  rampUp: [0.5, 2],
} as const;
export type CurvePresetId = keyof typeof CURVE_PRESETS;

/** A curve with its points spread evenly from the given speeds. */
export function curveFromSpeeds(speeds: readonly number[]): SpeedPoint[] {
  const n = speeds.length;
  return speeds.map((s, i) => ({
    at: n === 1 ? 0 : round3(i / (n - 1)),
    speed: round3(clamp(s, SPEED_MIN, SPEED_MAX)),
  }));
}

function cleanCurve(points: readonly SpeedPoint[]): SpeedPoint[] | null {
  if (points.length < RAMP_MIN_POINTS || points.length > RAMP_MAX_POINTS) return null;
  const out = points.map((p) => ({
    at: round3(clamp(finite(p.at, 0), 0, 1)),
    speed: round3(clamp(finite(p.speed, 1), SPEED_MIN, SPEED_MAX)),
  }));
  out[0].at = 0;
  out[out.length - 1].at = 1;
  for (let i = 1; i < out.length; i += 1)
    if (out[i].at - out[i - 1].at < RAMP_MIN_GAP - 1e-9) return null;
  return out;
}

/** Use a speed curve (replaces the constant speed, reverse and freeze), or with
 *  null go back to a constant speed of 1. A curve that breaks the document's
 *  rules is refused. */
export function setClipCurve(
  model: EditorModel,
  id: string,
  points: readonly SpeedPoint[] | null,
): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  if (!at) return model;
  if (points === null) {
    if (!at.speed_curve) return model;
    return settleBudgets(
      withClip(model, id, (c) => dropStaleInterpolate({ ...drop(c, "speed_curve"), speed: 1 }), true),
      id,
    );
  }
  const clean = cleanCurve(points);
  if (!clean) return model;
  if (JSON.stringify(clean) === JSON.stringify(at.speed_curve)) return model;
  return settleBudgets(
    withClip(
      model,
      id,
      (c) =>
        dropStaleInterpolate({
          ...drop(c, "reverse", "freeze"),
          speed: 1,
          speed_curve: clean,
        }),
      true,
    ),
    id,
  );
}

/** Change one point of the curve. The first and last stay at 0 and 1; a point
 *  stays at least RAMP_MIN_GAP from its neighbours. */
export function setCurvePoint(
  model: EditorModel,
  id: string,
  index: number,
  patch: Partial<SpeedPoint>,
): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  const curve = at ? curveOf(at) : null;
  if (!at || !curve || index < 0 || index >= curve.length) return model;
  const p = { ...curve[index] };
  if (patch.speed !== undefined) p.speed = clamp(finite(patch.speed, p.speed), SPEED_MIN, SPEED_MAX);
  if (patch.at !== undefined && index > 0 && index < curve.length - 1) {
    p.at = clamp(
      finite(patch.at, p.at),
      curve[index - 1].at + RAMP_MIN_GAP,
      curve[index + 1].at - RAMP_MIN_GAP,
    );
  }
  const next = curve.map((q, i) => (i === index ? p : q));
  return setClipCurve(model, id, next);
}

export function canAddCurvePoint(clip: VideoClip): boolean {
  const c = curveOf(clip);
  return Boolean(c && c.length < RAMP_MAX_POINTS);
}

/** A new point in the middle of the widest gap, on the line between its neighbours. */
export function addCurvePoint(model: EditorModel, id: string): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  const curve = at ? curveOf(at) : null;
  if (!at || !curve || curve.length >= RAMP_MAX_POINTS) return model;
  let gap = 0;
  for (let i = 1; i < curve.length; i += 1)
    if (curve[i].at - curve[i - 1].at > curve[gap + 1].at - curve[gap].at) gap = i - 1;
  const a = curve[gap];
  const b = curve[gap + 1];
  if (b.at - a.at < 2 * RAMP_MIN_GAP) return model;
  const mid: SpeedPoint = { at: round3((a.at + b.at) / 2), speed: round3((a.speed + b.speed) / 2) };
  return setClipCurve(model, id, [...curve.slice(0, gap + 1), mid, ...curve.slice(gap + 1)]);
}

export function removeCurvePoint(model: EditorModel, id: string, index: number): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  const curve = at ? curveOf(at) : null;
  if (!at || !curve || curve.length <= RAMP_MIN_POINTS || index <= 0 || index >= curve.length - 1)
    return model;
  return setClipCurve(model, id, curve.filter((_, i) => i !== index));
}

// ── slow-motion interpolation (a frame budget) ──────────────────────────────

/** The 1080p-equivalent frames interpolation would make for a clip. */
export function interpolateFrames(model: EditorModel, c: VideoClip): number {
  return interpolatedFrames(c.in_s, c.out_s, slowestSpeed(c), model.fps, model.width, model.height);
}

/** The frames the other clips of the project already use. */
export function interpolateUsedByOthers(model: EditorModel, exceptId: string): number {
  return model.clips
    .filter((c) => c.id !== exceptId && c.interpolate)
    .reduce((n, c) => n + interpolateFrames(model, c), 0);
}

/** The longest range, in source seconds, that fits the per-clip budget at this
 *  speed, frame size and rate. */
export function interpolateMaxSeconds(
  model: Pick<EditorModel, "fps" | "width" | "height">,
  minSpeed: number,
  budget: number = INTERP_MAX_FRAMES,
): number {
  const perSecond = interpolatedFrames(0, 1000, minSpeed, model.fps, model.width, model.height) / 1000;
  return perSecond > 0 ? Math.floor((budget / perSecond) * 10) / 10 : 0;
}

/** What the export is charged against the worker's timeout, in estimated
 *  seconds (modules/timeline.py, the same numbers): the timeline itself, each
 *  1080p-equivalent interpolated frame, and each steadied second weighted by
 *  frame size. `ok` is the validator's rule: nothing slow, or the sum fits
 *  `renderTimeoutS(length)`. */
export interface RenderWork {
  length: number;
  interpEst: number;
  stabEst: number;
  /** What the shape layers add (lib/editorShapes.ts `shapeWorkSeconds`). */
  shapeEst: number;
  work: number;
  allowed: number;
  ok: boolean;
}

export function renderWork(model: EditorModel): RenderWork {
  const length = modelDuration(model);
  const frames = model.clips
    .filter((c) => c.interpolate)
    .reduce((n, c) => n + interpolateFrames(model, c), 0);
  // above its own cap the frames are refused on their own (the estimate is not added)
  const interpEst = frames <= INTERP_MAX_FRAMES_DOC ? INTERP_SECONDS_PER_FRAME * frames : 0;
  const stabEst = model.clips
    .filter((c) => c.stabilize)
    .reduce(
      (n, c) =>
        n + stabilizeSeconds(c as unknown as Record<string, unknown>, model.fps, model.width, model.height),
      0,
    );
  const shapeEst = shapeWorkSeconds(model.shapes ?? [], model.fps, model, length);
  const work = RENDER_PLAIN_FACTOR * length + interpEst + stabEst + shapeEst;
  const allowed = renderTimeoutS(length);
  return {
    length,
    interpEst,
    stabEst,
    shapeEst,
    work,
    allowed,
    ok: interpEst + stabEst + shapeEst <= 0 || work <= allowed + 1e-9,
  };
}

export type InterpolateCheck =
  | { ok: true; frames: number }
  | {
      ok: false;
      reason: "not_slow" | "direction" | "frame_size" | "clip_budget" | "doc_budget" | "render_time";
      frames: number;
      maxS: number;
      render?: RenderWork;
    };

/** Can this clip be interpolated? (Judged as if it were on: the same answer
 *  tells a clip that is on whether it still fits.) */
export function interpolateCheck(model: EditorModel, c: VideoClip): InterpolateCheck {
  const frames = interpolateFrames(model, c);
  const slow = slowestSpeed(c);
  const maxS = interpolateMaxSeconds(model, Math.min(slow, 0.9999));
  if (c.reverse || c.freeze) return { ok: false, reason: "direction", frames, maxS };
  if (slow >= 1) return { ok: false, reason: "not_slow", frames, maxS };
  if (model.width * model.height > INTERP_MAX_PIXELS)
    return { ok: false, reason: "frame_size", frames, maxS };
  if (frames > INTERP_MAX_FRAMES) return { ok: false, reason: "clip_budget", frames, maxS };
  if (frames + interpolateUsedByOthers(model, c.id) > INTERP_MAX_FRAMES_DOC)
    return { ok: false, reason: "doc_budget", frames, maxS };
  const render = renderWork({
    ...model,
    clips: model.clips.map((x) => (x.id === c.id ? { ...x, interpolate: true } : x)),
  });
  if (!render.ok) return { ok: false, reason: "render_time", frames, maxS, render };
  return { ok: true, frames };
}

export function setClipInterpolate(model: EditorModel, id: string, on: boolean): EditorModel {
  return withClip(model, id, (c) => {
    if (Boolean(c.interpolate) === on) return c;
    if (!on) return drop(c, "interpolate");
    return interpolateCheck(model, c).ok ? { ...c, interpolate: true } : c;
  });
}

// ── trimming with the limits above ──────────────────────────────────────────

/** The longest source range this clip may have given what it is set to do:
 *  reverse's memory cap, the interpolation budget and (stabilise) its own. */
export function maxRangeFor(model: EditorModel, c: VideoClip): number {
  let max = Number.POSITIVE_INFINITY;
  if (c.reverse) max = Math.min(max, reverseLimit(model));
  if (c.interpolate) {
    const slow = Math.min(slowestSpeed(c), 0.9999);
    const own = interpolateMaxSeconds(model, slow);
    const left = interpolateMaxSeconds(
      model,
      slow,
      Math.max(0, INTERP_MAX_FRAMES_DOC - interpolateUsedByOthers(model, c.id)),
    );
    max = Math.min(max, own, left);
  }
  if (c.stabilize) {
    const others = model.clips
      .filter((x) => x.id !== c.id && x.stabilize)
      .reduce((n, x) => n + sourceRange(x), 0);
    max = Math.min(max, STABILIZE_MAX_S, Math.max(0, STABILIZE_MAX_DOC_S - others));
  }
  return max;
}

/** What the validator says about the limits this module guards (backwards range,
 *  smoothing frames, steadying seconds, the export's time allowance) for clip `id`
 *  or the project: the answer is the validator's own, so it cannot disagree. */
export function budgetProblems(model: EditorModel, id: string): string[] {
  return validateTimeline(toDoc(model)).filter(
    (p) =>
      (p.includes(`clip ${id}:`) && /reverse holds|interpolat|stabilis/.test(p)) ||
      /^timeline: (interpolated|at most \d+ s of video can be stabilised)|would take about/.test(p),
  );
}

/**
 * `trimClip` that also keeps the clip inside the limits of what it is set to
 * do (reverse, interpolation, stabilise): the edge being moved stops where the
 * range would become too long. A frozen clip's end is its hold length, so it is
 * not capped by the file's length (only its start is).
 */
export function trimLimited(
  model: EditorModel,
  id: string,
  edge: "in" | "out",
  value: number,
  sourceS: number | null,
): EditorModel {
  const c = model.clips.find((x) => x.id === id);
  if (!c) return model;
  const frozen = Boolean(c.freeze);
  const next = trimClip(
    model,
    id,
    edge,
    frozen && edge === "in" && sourceS ? Math.min(value, ms(sourceS) - MIN_CLIP_S) : value,
    frozen && edge === "out" ? null : sourceS,
  );
  const t = next.clips.find((x) => x.id === id);
  if (!t) return next;
  const cap = maxRangeFor(next, t);
  const range = sourceRange(t);
  let out = next;
  if (range > cap + 1e-9)
    out =
      edge === "in"
        ? trimClip(next, id, "in", ms(t.out_s - cap), sourceS)
        : trimClip(next, id, "out", ms(t.in_s + cap), frozen ? null : sourceS);
  // The export's time allowance: slow work on this clip (and the timeline's own
  // length) must fit it; the edge stops where it last did.
  const slow = (m: EditorModel) => {
    const x = m.clips.find((k) => k.id === id);
    return Boolean(x && (x.interpolate || x.stabilize));
  };
  let result = out;
  if (slow(out) && !renderWork(out).ok) {
    const from = edge === "in" ? c.in_s : c.out_s;
    const to = edge === "in" ? out.clips.find((k) => k.id === id)!.in_s : out.clips.find((k) => k.id === id)!.out_s;
    let good = from;
    let bad = to;
    let best = model;
    for (let i = 0; i < 24 && Math.abs(bad - good) > 0.002; i += 1) {
      const mid = ms((good + bad) / 2);
      const cand = trimClip(model, id, edge, mid, frozen && edge === "out" ? null : sourceS);
      if (renderWork(cand).ok) {
        good = mid;
        best = cand;
      } else bad = mid;
    }
    result = best;
  }
  // The cap is a number of seconds; the validator counts whole frames of the
  // range exactly as it is stored (a float difference can tip 300 frames to 301).
  // So the last word is the validator's own: step the edge in by a millisecond
  // until it has nothing to say about this clip's limits.
  for (let i = 0; i < 60 && budgetProblems(result, id).length > 0; i += 1) {
    const x = result.clips.find((k) => k.id === id);
    if (!x) break;
    const v = edge === "in" ? ms(x.in_s + 0.001) : ms(x.out_s - 0.001);
    const stepped = trimClip(result, id, edge, v, edge === "out" && frozen ? null : sourceS);
    const y = stepped.clips.find((k) => k.id === id);
    if (!y || (edge === "in" ? y.in_s === x.in_s : y.out_s === x.out_s)) break;
    result = stepped;
  }
  return result;
}

