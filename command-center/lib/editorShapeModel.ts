/**
 * Stickers and shapes in the editor: the pure model edits behind the shape
 * picker and inspector. What a shape is and the limits it keeps are in
 * `lib/editorShapes.ts` (the closed set, shared with the worker's
 * modules/shape_art.py) and docs/editor-render-fields.md.
 *
 * Every function returns the SAME model when nothing changes (so it is not an
 * undo step), clamps to the document's own limits and keeps the shape one the
 * validators accept: a field the kind does not take is never kept, a bar takes
 * a fade only and no move, a pill always has a label of 1 to SHAPE_TEXT_MAX
 * characters, the entrance and exit fit in the time it is shown. Shapes share
 * the picture-overlay layers of the export, so `canAddShape` counts both.
 */
import {
  MAX_OVERLAYS,
  MIN_CLIP_S,
  HEX_RE,
  clamp,
  fitAnims,
  freshId,
  ms,
  pictureEndOf,
  type EditorModel,
} from "@/lib/editor";
import { withAnim, withAnimSeconds, type AnimSide } from "@/lib/editorFx";
import { renderWork } from "@/lib/editorMotion";
import {
  ARROW_DIRS,
  ASPECT_DEFAULT,
  ASPECT_MAX,
  ASPECT_MIN,
  DIR_DEFAULT,
  EDGE_DEFAULT,
  KIND_FIELDS,
  MAX_SHAPES,
  PROGRESS_ANIMS,
  PROGRESS_EDGES,
  SHAPE_COLOR_DEFAULT,
  SHAPE_DEFAULTS,
  SHAPE_MOVE_KEYS,
  SHAPE_OUTLINE_MAX,
  SHAPE_W_MAX,
  SHAPE_W_MIN,
  THICK_DEFAULTS,
  THICK_MAX,
  THICK_MIN,
  cleanShapeText,
  isShapeKind,
  memoryBudgetBytes,
  memoryEstimateBytes,
  shapeTextProblem,
  type ShapeKind,
  type ShapeLayer,
  type ShapeMoveKey,
  type ShapeMoveTo,
} from "@/lib/editorShapes";

/** How long a new shape lasts, at most (seconds); a progress bar takes the whole video. */
export const SHAPE_DEFAULT_S = 5;

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
const finite = (v: number, d: number) => (Number.isFinite(v) ? v : d);

export function shapesOf(model: EditorModel): ShapeLayer[] {
  return model.shapes ?? [];
}

export function shapeById(model: EditorModel, id: string): ShapeLayer | undefined {
  return shapesOf(model).find((s) => s.id === id);
}

export function shapeLength(s: Pick<ShapeLayer, "start_s" | "end_s">): number {
  return ms(ms(s.end_s) - ms(s.start_s));
}

/** Layers of the final pass the picture overlays and the shapes use together. */
export function layerCount(model: EditorModel): number {
  return (model.overlays?.length ?? 0) + shapesOf(model).length;
}

/** Can one more shape be added? At most MAX_SHAPES, with the picture overlays at most MAX_OVERLAYS layers. */
export function canAddShape(model: EditorModel): boolean {
  return shapesOf(model).length < MAX_SHAPES && layerCount(model) < MAX_OVERLAYS;
}

// ── what the export can afford (memory and time; lib/editorShapes.ts has the measurements) ──

export interface ShapeBudget {
  /** Estimated address space the final pass needs, and the most it may. */
  memory: number;
  memoryMax: number;
  /** Estimated render seconds (everything), and the most the worker allows this timeline. */
  work: number;
  workMax: number;
  ok: boolean;
}

export function shapeBudget(model: EditorModel): ShapeBudget {
  const memory = memoryEstimateBytes(shapesOf(model), model);
  const memoryMax = memoryBudgetBytes();
  const r = renderWork(model);
  return { memory, memoryMax, work: r.work, workMax: r.allowed, ok: memory <= memoryMax && r.ok };
}

/** Why the shapes do not fit the export, or null when they do. */
export function shapeBudgetProblem(model: EditorModel): "memory" | "time" | null {
  const b = shapeBudget(model);
  if (b.memory > b.memoryMax) return "memory";
  return renderWork(model).ok ? null : "time";
}

/** The model with shape `id` made narrower, step by step, until the shapes fit (its end of a move too); the
 *  model it was given when it already fits; null when even the narrowest does not. */
function narrowToFit(model: EditorModel, id: string): EditorModel | null {
  let m = model;
  for (let i = 0; i < 60; i += 1) {
    if (shapeBudgetProblem(m) === null) return m;
    const s = shapeById(m, id);
    if (!s || s.w === undefined) return null;
    const to = s.move?.to.w;
    if (s.w <= SHAPE_W_MIN + 1e-9 && (to === undefined || to <= SHAPE_W_MIN + 1e-9)) return null;
    const next: ShapeLayer = {
      ...s,
      w: round3(Math.max(SHAPE_W_MIN, s.w * 0.9)),
      ...(s.move && to !== undefined
        ? { move: { to: { ...s.move.to, w: round3(Math.max(SHAPE_W_MIN, to * 0.9)) } } }
        : {}),
    };
    m = { ...m, shapes: shapesOf(m).map((x) => (x.id === id ? next : x)) };
  }
  return null;
}

/** After an edit to shape `id`: the edited model if it fits the export, else that shape narrowed until it does, else
 *  null (refused). An edit that does not make things dearer than they were is always allowed (a project that was
 *  already over is not stuck: it can only get cheaper). */
function keepAffordable(before: EditorModel, after: EditorModel, id: string): EditorModel | null {
  if (shapeBudgetProblem(after) === null) return after;
  const a = shapeBudget(before);
  const b = shapeBudget(after);
  if (b.memory <= a.memory && b.work <= a.work + 1e-9) return after;
  return narrowToFit(after, id);
}

/** The kind's own starting look: a ring and a frame are outlines, the rest solid; a label sits low,
 *  a line is an underline, the bar sits on the bottom edge. */
function kindDefaults(kind: ShapeKind, text: string): Partial<ShapeLayer> {
  switch (kind) {
    case "arrow":
      return { w: 0.22, dir: DIR_DEFAULT };
    case "circle":
      return { w: 0.2, outline: 0.1 };
    case "rect":
      return { w: 0.35, aspect: ASPECT_DEFAULT, outline: 0.05 };
    case "star":
      return { w: 0.18 };
    case "pill":
      return { w: 0.32, y: 0.82, text };
    case "line":
      return { w: 0.5, y: 0.86, thick: THICK_DEFAULTS.line };
    case "progress":
      return { thick: THICK_DEFAULTS.progress, edge: EDGE_DEFAULT };
  }
}

function base(kind: ShapeKind, id: string, start: number, end: number, text: string): ShapeLayer {
  const d = kindDefaults(kind, text);
  return {
    id,
    kind,
    start_s: start,
    end_s: end,
    color: SHAPE_COLOR_DEFAULT,
    opacity: SHAPE_DEFAULTS.opacity,
    ...(KIND_FIELDS[kind].includes("x") ? { x: SHAPE_DEFAULTS.x, y: SHAPE_DEFAULTS.y, w: SHAPE_DEFAULTS.w } : {}),
    ...d,
  };
}

/**
 * A new shape of `kind` at timeline time `at` (the playhead): in the middle of the frame (a label
 * low, a line under, the bar on the bottom edge), SHAPE_DEFAULT_S seconds long (shorter where the
 * picture ends sooner; the bar spans the whole video). `text` is a label's words. null when the
 * limit is reached.
 */
export function addShape(
  model: EditorModel,
  kind: ShapeKind,
  at: number,
  text = "",
): { model: EditorModel; id: string } | null {
  if (!canAddShape(model) || !isShapeKind(kind)) return null;
  const picture = pictureEndOf(model);
  let start: number;
  let end: number;
  if (kind === "progress") {
    start = 0;
    end = ms(Math.max(picture, MIN_CLIP_S));
  } else {
    start = ms(clamp(at, 0, Math.max(0, picture - MIN_CLIP_S)));
    const room = picture - start;
    const length = room > MIN_CLIP_S ? Math.min(SHAPE_DEFAULT_S, room) : MIN_CLIP_S;
    end = ms(start + Math.max(ms(length), MIN_CLIP_S));
  }
  const label = kind === "pill" ? cleanShapeText(text) || "…" : "";
  const id = freshId(model, "h");
  const added = { ...model, shapes: [...shapesOf(model), base(kind, id, start, end, label)] };
  const fitted = keepAffordable(model, added, id);
  return fitted ? { model: fitted, id } : null;
}

/** Why `addShape` would say no: the count, the layers, or what the export can afford. */
export function shapeAddCheck(
  model: EditorModel,
  kind: ShapeKind,
  at = 0,
): "ok" | "count" | "memory" | "time" {
  if (!canAddShape(model)) return "count";
  if (addShape(model, kind, at, "…")) return "ok";
  // the narrowest the new shape can be still does not fit: say which budget it is
  const probe = { ...model, shapes: [...shapesOf(model), { ...base(kind, "probe", 0, 1, "…"), ...(KIND_FIELDS[kind].includes("w") ? { w: SHAPE_W_MIN } : {}) }] };
  return shapeBudgetProblem(probe) ?? "memory";
}

/** The shape with every field brought to what its kind takes and into range (the document would
 *  refuse anything else). `at` is the shape before the change (a rejected value keeps its value). */
function settle(s: ShapeLayer, at: ShapeLayer): ShapeLayer {
  const kind = s.kind;
  const takes = (f: string) => KIND_FIELDS[kind].includes(f);
  const out: ShapeLayer = {
    id: s.id,
    kind,
    start_s: ms(Math.max(0, finite(s.start_s, at.start_s))),
    end_s: ms(finite(s.end_s, at.end_s)),
    color: typeof s.color === "string" && HEX_RE.test(s.color) ? s.color.toUpperCase() : at.color,
    opacity: round3(clamp(finite(s.opacity, at.opacity), 0, 1)),
  };
  out.end_s = ms(Math.max(out.end_s, out.start_s + MIN_CLIP_S));
  if (takes("x")) {
    out.x = round3(clamp(finite(s.x ?? at.x ?? SHAPE_DEFAULTS.x, SHAPE_DEFAULTS.x), 0, 1));
    out.y = round3(clamp(finite(s.y ?? at.y ?? SHAPE_DEFAULTS.y, SHAPE_DEFAULTS.y), 0, 1));
    out.w = round3(clamp(finite(s.w ?? at.w ?? SHAPE_DEFAULTS.w, SHAPE_DEFAULTS.w), SHAPE_W_MIN, SHAPE_W_MAX));
  }
  if (takes("outline")) {
    const o = round3(clamp(finite(s.outline ?? 0, 0), 0, SHAPE_OUTLINE_MAX));
    if (o > 0) out.outline = o;
  }
  if (kind === "rect")
    out.aspect = round3(clamp(finite(s.aspect ?? ASPECT_DEFAULT, ASPECT_DEFAULT), ASPECT_MIN, ASPECT_MAX));
  if (kind === "arrow")
    out.dir = (ARROW_DIRS as readonly unknown[]).includes(s.dir) ? s.dir : (at.dir ?? DIR_DEFAULT);
  if (kind === "line" || kind === "progress")
    out.thick = round4(clamp(finite(s.thick ?? THICK_DEFAULTS[kind], THICK_DEFAULTS[kind]), THICK_MIN, THICK_MAX));
  if (kind === "progress")
    out.edge = (PROGRESS_EDGES as readonly unknown[]).includes(s.edge) ? s.edge : (at.edge ?? EDGE_DEFAULT);
  if (kind === "pill") {
    const text = cleanShapeText(s.text ?? "");
    // A label is never empty: the document refuses one, so the last good words stay.
    out.text = shapeTextProblem(text) ? (at.text ?? "…") : text;
  }
  // Entrance / exit: kept when the kind has them (a bar: a fade only) and when they fit the time shown.
  for (const key of ["anim_in", "anim_out"] as const) {
    const v = s[key];
    if (!v) continue;
    if (kind === "progress" && !(PROGRESS_ANIMS as readonly string[]).includes(v)) continue;
    out[key] = v;
    out[`${key}_s` as "anim_in_s"] = s[`${key}_s` as "anim_in_s"];
  }
  if (takes("move") && s.move) {
    const to: ShapeMoveTo = {};
    for (const k of SHAPE_MOVE_KEYS) {
      const v = s.move.to[k];
      if (v === undefined) continue;
      const r = k === "w" ? { lo: SHAPE_W_MIN, hi: SHAPE_W_MAX } : { lo: 0, hi: 1 };
      const held = round3(clamp(finite(v, out[k] ?? 0), r.lo, r.hi));
      if (held !== out[k]) to[k] = held;
    }
    if (Object.keys(to).length) out.move = { to };
  }
  return fitAnims(out);
}

/**
 * Change a shape, kept renderable: a new `start_s` alone slides the span (its length is kept; give
 * `end_s` too, or alone, to change the length), the span inside 0..MAX and at least MIN_CLIP_S
 * long, every number inside its range, a field the kind does not take dropped. The same model back
 * when nothing changes (not an undo step).
 */
export function updateShape(
  model: EditorModel,
  id: string,
  patch: Partial<Omit<ShapeLayer, "id" | "kind">>,
): EditorModel {
  const list = shapesOf(model);
  const at = list.find((s) => s.id === id);
  if (!at) return model;
  const merged: ShapeLayer = { ...at, ...patch };
  if (patch.end_s === undefined && patch.start_s !== undefined)
    merged.end_s = ms(finite(merged.start_s, at.start_s) + shapeLength(at));
  const next = settle(merged, at);
  if (JSON.stringify(next) === JSON.stringify(at)) return model;
  const after = { ...model, shapes: list.map((s) => (s.id === id ? next : s)) };
  return keepAffordable(model, after, id) ?? model;
}

/** Another kind in the same place in time: the span, colour and opacity are kept, the new kind's
 *  own look (size, stroke, label) starts fresh, and an entrance the new kind has not is dropped. */
export function setShapeKind(
  model: EditorModel,
  id: string,
  kind: ShapeKind,
  text = "",
): EditorModel {
  const list = shapesOf(model);
  const at = list.find((s) => s.id === id);
  if (!at || at.kind === kind || !isShapeKind(kind)) return model;
  const fresh = base(kind, id, at.start_s, at.end_s, kind === "pill" ? cleanShapeText(text) || "…" : "");
  const carried: ShapeLayer = {
    ...fresh,
    color: at.color,
    opacity: at.opacity,
    ...(at.anim_in ? { anim_in: at.anim_in, anim_in_s: at.anim_in_s } : {}),
    ...(at.anim_out ? { anim_out: at.anim_out, anim_out_s: at.anim_out_s } : {}),
  };
  // settle() leaves out an entrance or exit the new kind cannot have (a bar: only a fade).
  const settled = settle(carried, fresh);
  const after = { ...model, shapes: list.map((s) => (s.id === id ? settled : s)) };
  return keepAffordable(model, after, id) ?? model;
}

/** Position, size and opacity back to the kind's own look; the span and colour stay. */
export function resetShape(model: EditorModel, id: string): EditorModel {
  const at = shapeById(model, id);
  if (!at) return model;
  const d = base(at.kind, id, at.start_s, at.end_s, at.text ?? "");
  const { color: _c, start_s: _s, end_s: _e, id: _i, kind: _k, ...look } = d;
  void [_c, _s, _e, _i, _k];
  const { move: _m, ...rest } = at;
  void _m;
  return updateShape(
    { ...model, shapes: shapesOf(model).map((s) => (s.id === id ? rest : s)) },
    id,
    { ...look },
  );
}

/** Move the centre by whole steps (the arrow keys); a bar has no position. */
export function nudgeShape(
  model: EditorModel,
  id: string,
  dx: number,
  dy: number,
  step = 0.01,
): EditorModel {
  const at = shapeById(model, id);
  if (!at || at.x === undefined || at.y === undefined) return model;
  return updateShape(model, id, { x: round3(at.x + dx * step), y: round3(at.y + dy * step) });
}

export function removeShape(model: EditorModel, id: string): EditorModel {
  const list = shapesOf(model);
  if (!list.some((s) => s.id === id)) return model;
  const rest = list.filter((s) => s.id !== id);
  const { shapes: _old, ...without } = model;
  void _old;
  // None left: the field goes (the document without shapes is unchanged).
  return rest.length ? { ...model, shapes: rest } : without;
}

/** Move a shape one layer up (+1, drawn later, on top) or down (-1) among the shapes. */
export function moveShape(model: EditorModel, id: string, by: -1 | 1): EditorModel {
  const list = [...shapesOf(model)];
  const i = list.findIndex((s) => s.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return model;
  [list[i], list[j]] = [list[j], list[i]];
  return { ...model, shapes: list };
}

/** Shapes on screen at timeline time `t`, bottom layer first. */
export function shapesAt(model: EditorModel, t: number): ShapeLayer[] {
  return shapesOf(model).filter((s) => t >= s.start_s && t < s.end_s);
}

/** What a person should know about a shape: it starts after the picture ends (nothing of it is
 *  exported), runs past the end (the rest is cut; a bar then stops short of full) or is invisible. */
export function shapeWarnings(
  model: EditorModel,
): Record<string, "past_end" | "cut_end" | "invisible"> {
  const end = pictureEndOf(model);
  const out: Record<string, "past_end" | "cut_end" | "invisible"> = {};
  for (const s of shapesOf(model)) {
    if (s.start_s >= end) out[s.id] = "past_end";
    else if (s.opacity <= 0) out[s.id] = "invisible";
    else if (s.end_s > end + 0.001) out[s.id] = "cut_end";
  }
  return out;
}

// ── entrance / exit ─────────────────────────────────────────────────────────

/** The animations a shape has on a side: a bar a fade only. */
export function shapeAnimChoices(kind: ShapeKind, all: readonly string[]): readonly string[] {
  return kind === "progress" ? all.filter((a) => (PROGRESS_ANIMS as readonly string[]).includes(a)) : all;
}

function mapShape(
  model: EditorModel,
  id: string,
  f: (s: ShapeLayer) => ShapeLayer,
): EditorModel {
  const list = shapesOf(model);
  const at = list.find((s) => s.id === id);
  if (!at) return model;
  const next = f(at);
  if (next === at) return model;
  return { ...model, shapes: list.map((s) => (s.id === id ? next : s)) };
}

export function setShapeAnim(
  model: EditorModel,
  id: string,
  side: AnimSide,
  anim: string | null,
): EditorModel {
  return mapShape(model, id, (s) => {
    if (anim !== null && s.kind === "progress" && !(PROGRESS_ANIMS as readonly string[]).includes(anim))
      return s;
    return withAnim(s, side, anim, false);
  });
}

export function setShapeAnimSeconds(
  model: EditorModel,
  id: string,
  side: AnimSide,
  seconds: number,
): EditorModel {
  return mapShape(model, id, (s) => withAnimSeconds(s, side, seconds));
}

// ── an end position (a move) ────────────────────────────────────────────────

export function shapeEndOf(s: ShapeLayer): Record<ShapeMoveKey, number> {
  const to = s.move?.to ?? {};
  return {
    x: to.x ?? s.x ?? SHAPE_DEFAULTS.x,
    y: to.y ?? s.y ?? SHAPE_DEFAULTS.y,
    w: to.w ?? s.w ?? SHAPE_DEFAULTS.w,
  };
}

/** Does this kind move? (Not the bar.) */
export function canMoveShape(s: ShapeLayer): boolean {
  return KIND_FIELDS[s.kind].includes("move");
}

/** Turn the end position on: the shape drifts a quarter of the frame sideways (toward the middle
 *  when it sits on the right). */
export function startShapeMove(model: EditorModel, id: string): EditorModel {
  return mapShape(model, id, (s) => {
    if (s.move || !canMoveShape(s)) return s;
    const x = s.x ?? SHAPE_DEFAULTS.x;
    return { ...s, move: { to: { x: round3(clamp(x > 0.5 ? x - 0.25 : x + 0.25, 0, 1)) } } };
  });
}

export function clearShapeMove(model: EditorModel, id: string): EditorModel {
  return mapShape(model, id, (s) => {
    if (!s.move) return s;
    const { move: _m, ...rest } = s;
    void _m;
    return rest;
  });
}

/** Set where one value ends; a value equal to the shape's own is dropped, with nothing left the move goes. */
export function setShapeEnd(
  model: EditorModel,
  id: string,
  key: ShapeMoveKey,
  value: number,
): EditorModel {
  const after = setShapeEndRaw(model, id, key, value);
  return after === model ? model : (keepAffordable(model, after, id) ?? model);
}

function setShapeEndRaw(
  model: EditorModel,
  id: string,
  key: ShapeMoveKey,
  value: number,
): EditorModel {
  return mapShape(model, id, (s) => {
    if (!canMoveShape(s)) return s;
    const own = s[key] ?? SHAPE_DEFAULTS[key];
    const r = key === "w" ? { lo: SHAPE_W_MIN, hi: SHAPE_W_MAX } : { lo: 0, hi: 1 };
    const v = round3(clamp(finite(value, own), r.lo, r.hi));
    const to: ShapeMoveTo = { ...(s.move?.to ?? {}) };
    if (v === own) delete to[key];
    else to[key] = v;
    if (JSON.stringify(to) === JSON.stringify(s.move?.to ?? {})) return s;
    const { move: _m, ...rest } = s;
    void _m;
    return Object.keys(to).length ? { ...rest, move: { to } } : rest;
  });
}

/** The shape's x, y and w at timeline time `t` (a straight line from its own values to the end). */
export function shapeAt(s: ShapeLayer, t: number): Record<ShapeMoveKey, number> {
  const own = {
    x: s.x ?? SHAPE_DEFAULTS.x,
    y: s.y ?? SHAPE_DEFAULTS.y,
    w: s.w ?? SHAPE_DEFAULTS.w,
  };
  if (!s.move) return own;
  const end = shapeEndOf(s);
  const span = s.end_s - s.start_s;
  const p = span > 0 ? clamp((t - s.start_s) / span, 0, 1) : 0;
  return {
    x: own.x + (end.x - own.x) * p,
    y: own.y + (end.y - own.y) * p,
    w: own.w + (end.w - own.w) * p,
  };
}
