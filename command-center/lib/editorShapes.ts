/**
 * Stickers, shapes and the progress bar: the closed set, its limits and the
 * geometry the preview draws from. The pure, client-safe leaf (it imports only
 * types) so `lib/editor.ts` can validate with it and the model edits in
 * `lib/editorShapeModel.ts` can build on both.
 *
 * The document holds a top-level `shapes` list (modules/timeline.py, drawn by
 * modules/shape_art.py, which has the same lists and numbers; a test pins
 * them): `{ id, kind, start_s, end_s, color?, opacity?, x?, y?, w?, ... }`.
 * (x, y) is the CENTRE and `w` the width as fractions of the frame, exactly
 * the picture overlay's model; the height follows the kind. The export draws
 * each into a PNG and lays it with the picture-overlay path (so entrance / exit
 * animations and a move work); the progress bar is frame-wide and fills from
 * the left across its span.
 *
 * Preview vs export: the preview draws the same polygons as SVG, so a shape
 * is close to exact; a pill's width is ESTIMATED from its character count (the
 * export measures the real font), and the entrance / exit is a rough picture.
 * The product says so.
 */
import type { AnimOut } from "@/lib/editor";

// ── the closed set and its limits (modules/shape_art.py) ────────────────────

export const SHAPE_KINDS = [
  "arrow",
  "circle",
  "rect",
  "star",
  "pill",
  "line",
  "progress",
] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
export const ARROW_DIRS = ["right", "left", "up", "down"] as const;
export type ArrowDir = (typeof ARROW_DIRS)[number];
export const PROGRESS_EDGES = ["bottom", "top"] as const;
export type ProgressEdge = (typeof PROGRESS_EDGES)[number];

/** Shapes in a document; with the picture overlays they share MAX_OVERLAYS layers. */
export const MAX_SHAPES = 12;
/** A pill's label, in characters (code points). */
export const SHAPE_TEXT_MAX = 24;
export const SHAPE_COLOR_DEFAULT = "#FFD60A";
/** A stroke as a fraction of the shape's shorter side (0 = solid). */
export const SHAPE_OUTLINE_MAX = 0.5;
/** A line's or the bar's thickness, as a fraction of the frame HEIGHT. */
export const THICK_MIN = 0.002;
export const THICK_MAX = 0.05;
export const THICK_DEFAULTS = { line: 0.008, progress: 0.012 } as const;
/** A rectangle's width / height. */
export const ASPECT_MIN = 0.2;
export const ASPECT_MAX = 5;
export const ASPECT_DEFAULT = 1.6;
/** Width as a fraction of the frame (the picture overlay's own range). */
export const SHAPE_W_MIN = 0.05;
export const SHAPE_W_MAX = 1;
export const SHAPE_W_DEFAULT = 0.3;
export const EDGE_DEFAULT: ProgressEdge = "bottom";
export const DIR_DEFAULT: ArrowDir = "right";
/** The progress bar animates with a fade only (the bar is already slid by the clock). */
export const PROGRESS_ANIMS = ["fade"] as const;

/** Which fields each kind takes besides the common ones (modules/shape_art.py KIND_FIELDS). */
export const KIND_FIELDS: Record<ShapeKind, readonly string[]> = {
  arrow: ["x", "y", "w", "dir", "move"],
  circle: ["x", "y", "w", "outline", "move"],
  rect: ["x", "y", "w", "outline", "aspect", "move"],
  star: ["x", "y", "w", "outline", "move"],
  pill: ["x", "y", "w", "outline", "text", "move"],
  line: ["x", "y", "w", "thick", "move"],
  progress: ["edge", "thick"],
};
export const SHAPE_REQUIRED = ["id", "kind", "start_s", "end_s"];
export const SHAPE_COMMON = [
  ...SHAPE_REQUIRED,
  "color",
  "opacity",
  "anim_in",
  "anim_out",
  "anim_in_s",
  "anim_out_s",
];
/** A shape's `move.to` may change these (no opacity: that is the per-pixel budget). */
export const SHAPE_MOVE_KEYS = ["x", "y", "w"] as const;
export type ShapeMoveKey = (typeof SHAPE_MOVE_KEYS)[number];

/** A pill's own proportions in units of its font size (modules/shape_art.py). */
const PILL_PAD_X_EM = 0.55;
const PILL_HEIGHT_EM = 1.55;
/** The average width of a bold letter in em, measured over Latin and Cyrillic words (±15%). */
const PILL_EM_PER_CHAR = 0.64;
const STAR_INNER = 0.381966;
const STAR_WIDTH_R = 2 * Math.sin((72 * Math.PI) / 180);
const STAR_HEIGHT_R = 1 + Math.cos((36 * Math.PI) / 180);
const ARROW_SHAFT = 0.36;
const ARROW_HEAD_AT = 0.52;

export const isShapeKind = (v: unknown): v is ShapeKind =>
  typeof v === "string" && (SHAPE_KINDS as readonly string[]).includes(v);

/** The ready labels of the picker's "label" shape, by key; their words are in the dictionaries. */
export const PILL_LABELS = ["subscribe", "new", "link", "part2"] as const;
export type PillLabel = (typeof PILL_LABELS)[number];

// ── the model of one shape ──────────────────────────────────────────────────

export interface ShapeMoveTo {
  x?: number;
  y?: number;
  w?: number;
}

/** One shape as the editor holds it: the document's fields with the defaults of
 *  its kind filled in (x / y / w for every kind but the bar; the rest as the kind takes them). */
export interface ShapeLayer {
  id: string;
  kind: ShapeKind;
  start_s: number;
  end_s: number;
  color: string;
  opacity: number;
  x?: number;
  y?: number;
  w?: number;
  /** A stroke instead of a solid fill (circle, rect, star, pill); absent = solid. */
  outline?: number;
  /** Rect only. */
  aspect?: number;
  /** Arrow only. */
  dir?: ArrowDir;
  /** Line and bar only. */
  thick?: number;
  /** Pill only. */
  text?: string;
  /** Bar only. */
  edge?: ProgressEdge;
  /** Entrance / exit (a bar: fade only). */
  anim_in?: AnimOut;
  anim_out?: AnimOut;
  anim_in_s?: number;
  anim_out_s?: number;
  /** Two-keyframe move to these over start_s..end_s (not on a bar). */
  move?: { to: ShapeMoveTo };
}

export const SHAPE_DEFAULTS = {
  x: 0.5,
  y: 0.5,
  w: SHAPE_W_DEFAULT,
  opacity: 1,
} as const;

/** Does this kind take the field? (The common fields are every kind's.) */
export function kindTakes(kind: ShapeKind, field: string): boolean {
  return SHAPE_COMMON.includes(field) || KIND_FIELDS[kind].includes(field);
}

/** What a pill's text may hold, as inclusive code-point ranges (modules/shape_art.py TEXT_RANGES; a shared
 *  fixture, samples/shape_text_cases.json, pins both): Basic Latin, Latin-1, Latin Extended-A/B, the two Uzbek
 *  apostrophes, Cyrillic, dashes, quotes, bullet, ellipsis, euro, tenge and numero. The worker's font draws
 *  nothing else (an empty box), so nothing else is accepted. */
export const TEXT_RANGES: readonly (readonly [number, number])[] = [
  [0x0020, 0x007e],
  [0x00a1, 0x00ac],
  [0x00ae, 0x00ff],
  [0x0100, 0x024f],
  [0x02bb, 0x02bc],
  [0x0400, 0x0525],
  [0x2010, 0x2015],
  [0x2018, 0x201e],
  [0x2022, 0x2022],
  [0x2026, 0x2026],
  [0x20ac, 0x20ac],
  [0x20b8, 0x20b8],
  [0x2116, 0x2116],
];

export function textCharOk(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? -1;
  return TEXT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** Why a pill's text cannot be used, or null: non-empty after trimming, at most SHAPE_TEXT_MAX characters
 *  (code points: what the Python twin counts) and only characters of TEXT_RANGES. */
export function shapeTextProblem(text: unknown): string | null {
  if (typeof text !== "string" || text.trim() === "")
    return `text must be non-empty text of at most ${SHAPE_TEXT_MAX} characters`;
  const chars = Array.from(text);
  if (chars.length > SHAPE_TEXT_MAX)
    return `text must be non-empty text of at most ${SHAPE_TEXT_MAX} characters`;
  if (!chars.every(textCharOk))
    return "text can only use Latin and Cyrillic letters, digits and common punctuation";
  return null;
}

/** What a typed field keeps: a line break or tab is a space, a character the font cannot draw is left out
 *  (`dropped` says so, so the editor can tell the person), at most SHAPE_TEXT_MAX characters. */
export function cleanShapeTextReport(text: string): { text: string; dropped: boolean } {
  const spaced = Array.from(text.replace(/[\u2028\u2029\r\n\t]+/g, " "));
  const kept = spaced.filter(textCharOk);
  return { text: kept.slice(0, SHAPE_TEXT_MAX).join(""), dropped: kept.length < spaced.length };
}

export function cleanShapeText(text: string): string {
  return cleanShapeTextReport(text).text;
}

/** The words the export actually draws: braces become parentheses, a backslash a slash and runs of white
 *  space one space (modules/ass_captions.py escape_text, the clean-up every text overlay's words get). */
export function escapeShapeText(text: string): string {
  return text.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\s+/g, " ").trim();
}

// ── geometry (the same arithmetic as modules/shape_art.py; a shared fixture pins them) ──

/** Python's `round` (half to even): the worker rounds with it. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}
const even = (v: number) => Math.max(2, Math.trunc(pyRound(v) / 2) * 2);

/** The bar's height in pixels (even). */
export function progressHeightPx(thick: number, frameH: number): number {
  return even(thick * frameH);
}

/** The bar's centre as a fraction of the frame height: against the top or bottom edge. */
export function progressCenterY(
  shape: Pick<ShapeLayer, "thick" | "edge">,
  frameH: number,
): number {
  const half =
    progressHeightPx(shape.thick ?? THICK_DEFAULTS.progress, frameH) / 2 / frameH;
  return shape.edge === "top" ? half : 1 - half;
}

/** The expected width of a pill, over its height, from its character count. */
export function pillAspectEstimate(text: string): number {
  const n = Array.from(escapeShapeText(text)).length;
  return (n * PILL_EM_PER_CHAR + 2 * PILL_PAD_X_EM) / PILL_HEIGHT_EM;
}

/** Width / height of the shape's picture, or null for a pill (the export measures the font). */
export function shapeBaseAspect(
  s: Pick<ShapeLayer, "kind" | "aspect" | "dir" | "thick" | "w">,
  frame: { width: number; height: number },
): number | null {
  switch (s.kind) {
    case "circle":
    case "star":
      return 1;
    case "rect":
      return s.aspect ?? ASPECT_DEFAULT;
    case "arrow":
      return s.dir === "up" || s.dir === "down" ? 0.5 : 2;
    case "line":
      return (
        Math.max(1, (s.w ?? SHAPE_W_DEFAULT) * frame.width) /
        progressHeightPx(s.thick ?? THICK_DEFAULTS.line, frame.height)
      );
    case "progress":
      return (
        frame.width / progressHeightPx(s.thick ?? THICK_DEFAULTS.progress, frame.height)
      );
    default:
      return null;
  }
}

/** The picture's size in pixels: `w` of the frame wide, its height from `aspect`, inside the same
 *  box the overlay filter scales to (the frame's width by twice its height). Both even. */
export function fitPx(
  aspect: number,
  w: number,
  frame: { width: number; height: number },
): [number, number] {
  const boxW = even(w * frame.width);
  const boxH = Math.max(2, frame.height * 2);
  let pw = boxW;
  let ph = pw / aspect;
  if (ph > boxH) {
    ph = boxH;
    pw = ph * aspect;
  }
  return [even(pw), even(ph)];
}

/** The size in pixels the export draws a shape at (a pill's from the estimate, so only
 *  roughly), for a shape `w` of the frame wide. */
export function shapePx(
  s: Pick<ShapeLayer, "kind" | "aspect" | "dir" | "thick" | "text">,
  w: number,
  frame: { width: number; height: number },
): [number, number] {
  if (s.kind === "progress")
    return [even(frame.width), progressHeightPx(s.thick ?? THICK_DEFAULTS.progress, frame.height)];
  if (s.kind === "line")
    return [even(w * frame.width), progressHeightPx(s.thick ?? THICK_DEFAULTS.line, frame.height)];
  if (s.kind === "pill") return fitPx(pillAspectEstimate(s.text ?? ""), w, frame);
  return fitPx(shapeBaseAspect({ ...s, w }, frame) ?? 1, w, frame);
}

// ── what a document's shapes cost to render (modules/shape_art.py has the measurements) ─────────

const MIB = 1024 * 1024;
/** ffmpeg's address space in an editor export, and what is kept free of it (modules/shape_art.py). */
export const MEM_LIMIT_BYTES = 2048 * MIB;
export const MEM_MARGIN_BYTES = 150 * MIB;
export const MEM_PLAIN_FIXED_BYTES = 654 * MIB;
export const MEM_PLAIN_PER_FRAME_PX = 127;
export const MEM_PER_LAYER_BYTES = 56 * MIB;
export const MEM_PER_PNG_PX = 9;
export const MEM_FIRST_LAYER_PER_FRAME_PX = 13;
/** A pill's PNG width over height is never below this, so it is charged as a box of this proportion. */
export const PILL_MIN_ASPECT = 0.9;

/** A shape as the budgets read it (a model's shape or a document's entry). */
export type CostShape = {
  kind: string;
  w?: number;
  aspect?: number;
  dir?: string;
  thick?: number;
  move?: { to?: { w?: number } };
};

/** Pixels of the PNG one shape is drawn into, at the widest it ever is (a pill's: an upper bound). */
export function layerPngPixels(s: CostShape, frame: { width: number; height: number }): number {
  const wide = Math.max(s.w ?? SHAPE_W_DEFAULT, s.move?.to?.w ?? 0);
  const [pw, ph] =
    s.kind === "pill"
      ? fitPx(PILL_MIN_ASPECT, wide, frame)
      : shapePx(s as Pick<ShapeLayer, "kind" | "aspect" | "dir" | "thick" | "text">, wide, frame);
  return pw * ph;
}

/** About how much address space the final pass needs for a clip of this frame and rate with these shapes. */
export function memoryEstimateBytes(
  shapes: readonly CostShape[],
  frame: { width: number; height: number },
): number {
  const px = frame.width * frame.height;
  const plain = MEM_PLAIN_FIXED_BYTES + MEM_PLAIN_PER_FRAME_PX * px;
  if (!shapes.length) return Math.trunc(plain);
  const layers = MEM_PER_LAYER_BYTES * shapes.length + MEM_FIRST_LAYER_PER_FRAME_PX * px;
  const pngs = MEM_PER_PNG_PX * shapes.reduce((n, s) => n + layerPngPixels(s, frame), 0);
  return Math.trunc(plain + layers + pngs);
}

export const memoryBudgetBytes = () => MEM_LIMIT_BYTES - MEM_MARGIN_BYTES;

/** What the shapes add to the render, in estimated seconds (modules/shape_art.py has the measurements): per
 *  layer per OUTPUT frame, whatever its span, a fixed part that grows with the frame (1080p equivalent) and a
 *  part that grows with the layer's PNG. */
export const WORK_SECONDS_PER_LAYER_FRAME_1080P = 0.0025;
export const WORK_SECONDS_PER_PNG_MP = 0.001;
const REF_FRAME_PX = 1920 * 1080;

export type WorkShape = CostShape & { start_s: number; opacity?: number };

export function shapeWorkSeconds(
  shapes: readonly WorkShape[],
  fps: number,
  frame: { width: number; height: number },
  lengthS: number,
): number {
  const totalFrames = Math.floor(lengthS * fps + 0.5);
  if (totalFrames <= 0) return 0;
  const px = frame.width * frame.height;
  let seconds = 0;
  for (const s of shapes) {
    if (Math.floor(s.start_s * fps + 0.5) >= totalFrames || (s.opacity ?? 1) <= 0) continue;
    seconds +=
      totalFrames *
      ((WORK_SECONDS_PER_LAYER_FRAME_1080P * px) / REF_FRAME_PX +
        (WORK_SECONDS_PER_PNG_MP * layerPngPixels(s, frame)) / 1e6);
  }
  return seconds;
}

/** Black or white text for a solid colour (Rec. 709 luma, a fixed threshold: modules/shape_art.py). */
export function contrastOn(color: string): string {
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? "#111111" : "#FFFFFF";
}

/** The star's ten points in a `pw` x `ph` box (outer radius `r` fitted to the box), as "x,y" pairs. */
export function starPoints(pw: number, ph: number, inset = 0): string {
  const r = Math.min(pw / STAR_WIDTH_R, ph / STAR_HEIGHT_R) - inset;
  const cx = pw / 2;
  const cy = ph / 2 + Math.min(pw / STAR_WIDTH_R, ph / STAR_HEIGHT_R) * (1 - STAR_HEIGHT_R / 2);
  const pts: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? r : r * STAR_INNER;
    pts.push(`${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`);
  }
  return pts.join(" ");
}

/** A right-pointing arrow in a `long` x `short` box, as an SVG polygon's points. */
export function arrowPoints(long: number, short: number): string {
  const shaft = short * ARROW_SHAFT;
  const top = (short - shaft) / 2;
  const bottom = (short + shaft) / 2;
  const head = long * ARROW_HEAD_AT;
  return [
    [0, top],
    [head, top],
    [head, 0],
    [long, short / 2],
    [head, short],
    [head, bottom],
    [0, bottom],
  ]
    .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ");
}

/** How full the progress bar is at timeline time `t`: empty on its first frame, full on its last
 *  (the export's `clip((t - start) / (last frame - first frame))`). */
export function progressFill(
  s: Pick<ShapeLayer, "start_s" | "end_s">,
  t: number,
  fps: number,
): number {
  const frames = Math.max(1, Math.round((s.end_s - s.start_s) * fps) - 1);
  const p = (t - s.start_s) / (frames / fps);
  return Math.min(1, Math.max(0, p));
}
