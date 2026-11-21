import type { Size } from "@/lib/regionEdit/geometry";

/**
 * Text and simple shapes drawn over the picture. Every layer is positioned by its CENTRE, in the picture's canvas space
 * (the source after mirror and rotation, before the crop), in whole picture pixels. Centre-anchoring is what lets a
 * rotate or flip keep a layer attached to the same spot of the picture without measuring text.
 *
 * Nothing here can carry markup or a font file: text is plain characters drawn by the browser in one of three generic
 * families, colours are `#rrggbb`, shapes are rectangles, ellipses and one straight line.
 */
export const MAX_LAYERS = 20;
export const TEXT_MAX = 200;
export const FONT_MIN = 8;
export const FONT_MAX = 400;
export const STROKE_MIN = 1;
export const STROKE_MAX = 80;
export const MIN_SHAPE_PX = 4;
export const FAMILIES = ["sans", "serif", "mono"] as const;
export type Family = (typeof FAMILIES)[number];
export const SWATCHES = ["#ffffff", "#000000", "#f59e0b", "#ef4444", "#22c55e", "#3b82f6"] as const;

/** The CSS font stacks. Generic families only: no user font is ever loaded or parsed. */
export const FAMILY_CSS: Record<Family, string> = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', Times, serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
};

export interface TextLayer {
  id: string;
  kind: "text";
  cx: number;
  cy: number;
  text: string;
  fontSize: number;
  color: string;
  family: Family;
  bold: boolean;
}
export interface BoxLayer {
  id: string;
  kind: "rect" | "ellipse";
  cx: number;
  cy: number;
  w: number;
  h: number;
  color: string;
  filled: boolean;
  strokeWidth: number;
}
/** A straight line from (cx - dx, cy - dy) to (cx + dx, cy + dy). */
export interface LineLayer {
  id: string;
  kind: "line";
  cx: number;
  cy: number;
  dx: number;
  dy: number;
  color: string;
  strokeWidth: number;
}
export type Layer = TextLayer | BoxLayer | LineLayer;
export type ShapeKind = "rect" | "ellipse" | "line";

const HEX = /^#[0-9a-f]{6}$/;
/** `#rgb` / `#rrggbb` in any case -> `#rrggbb`; anything else -> the fallback. */
export function normalizeColor(raw: unknown, fallback = "#ffffff"): string {
  const s = String(raw ?? "").trim().toLowerCase();
  if (HEX.test(s)) return s;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : fallback;
}

const whole = (n: number): number => (Number.isFinite(n) ? Math.round(n) : 0);
const between = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, whole(n)));
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Plain text, line breaks kept (as \n), no control characters, cut at TEXT_MAX. */
export function cleanText(raw: unknown): string {
  return String(raw ?? "").replace(/\r\n?/g, "\n").replace(CONTROL, "").slice(0, TEXT_MAX);
}

/** A layer centre forced inside the canvas, so a layer can never be lost off the picture. */
export function clampCenter(cx: number, cy: number, canvas: Size): { cx: number; cy: number } {
  return { cx: between(cx, 0, canvas.width), cy: between(cy, 0, canvas.height) };
}

/** A starting font size: about a twelfth of the shorter side, never outside the allowed range. */
export function defaultFontSize(canvas: Size): number {
  return between(Math.min(canvas.width, canvas.height) / 12, 16, 200);
}

export function newText(id: string, canvas: Size, text: string): TextLayer {
  return {
    id,
    kind: "text",
    cx: Math.round(canvas.width / 2),
    cy: Math.round(canvas.height / 2),
    text: cleanText(text),
    fontSize: Math.min(FONT_MAX, defaultFontSize(canvas)),
    color: "#ffffff",
    family: "sans",
    bold: true,
  };
}

export function newShape(id: string, kind: ShapeKind, canvas: Size): BoxLayer | LineLayer {
  const side = Math.max(MIN_SHAPE_PX * 4, Math.round(Math.min(canvas.width, canvas.height) / 4));
  const cx = Math.round(canvas.width / 2);
  const cy = Math.round(canvas.height / 2);
  const strokeWidth = between(Math.min(canvas.width, canvas.height) / 150, 2, 12);
  if (kind === "line") return { id, kind, cx, cy, dx: Math.round(side / 2), dy: 0, color: "#f59e0b", strokeWidth };
  return { id, kind, cx, cy, w: side, h: Math.round(side * 0.7), color: "#f59e0b", filled: false, strokeWidth };
}

export type LayerPatch = Partial<Omit<TextLayer, "id" | "kind">> & Partial<Omit<BoxLayer, "id" | "kind">> & Partial<Omit<LineLayer, "id" | "kind">>;

/** Apply a patch to one layer, re-validating every field it touches. Unknown ids and fields that do not belong to the layer's kind change nothing. */
export function updateLayer(list: readonly Layer[], id: string, patch: LayerPatch, canvas: Size): Layer[] {
  return list.map((l) => {
    if (l.id !== id) return l;
    const c = clampCenter(patch.cx ?? l.cx, patch.cy ?? l.cy, canvas);
    if (l.kind === "text") {
      return {
        ...l,
        ...c,
        text: patch.text === undefined ? l.text : cleanText(patch.text),
        fontSize: patch.fontSize === undefined ? l.fontSize : between(patch.fontSize, FONT_MIN, FONT_MAX),
        color: patch.color === undefined ? l.color : normalizeColor(patch.color, l.color),
        family: patch.family && (FAMILIES as readonly string[]).includes(patch.family) ? patch.family : l.family,
        bold: patch.bold === undefined ? l.bold : Boolean(patch.bold),
      };
    }
    const strokeWidth = patch.strokeWidth === undefined ? l.strokeWidth : between(patch.strokeWidth, STROKE_MIN, STROKE_MAX);
    const color = patch.color === undefined ? l.color : normalizeColor(patch.color, l.color);
    if (l.kind === "line") {
      const max = Math.max(canvas.width, canvas.height);
      return { ...l, ...c, color, strokeWidth, dx: between(patch.dx ?? l.dx, -max, max), dy: between(patch.dy ?? l.dy, -max, max) };
    }
    return {
      ...l,
      ...c,
      color,
      strokeWidth,
      w: between(patch.w ?? l.w, MIN_SHAPE_PX, canvas.width * 2),
      h: between(patch.h ?? l.h, MIN_SHAPE_PX, canvas.height * 2),
      filled: patch.filled === undefined ? l.filled : Boolean(patch.filled),
    };
  });
}

export type AddLayerResult = { ok: true; layers: Layer[] } | { ok: false; error: "layer_limit" };

export function addLayer(list: readonly Layer[], layer: Layer): AddLayerResult {
  if (list.length >= MAX_LAYERS) return { ok: false, error: "layer_limit" };
  return { ok: true, layers: [...list, layer] };
}

export const removeLayer = (list: readonly Layer[], id: string): Layer[] => list.filter((l) => l.id !== id);

/** The line as a length and an angle in degrees (0 = to the right, clockwise on screen), the form a person can type. */
export function lineToPolar(l: Pick<LineLayer, "dx" | "dy">): { length: number; angle: number } {
  const length = Math.round(2 * Math.hypot(l.dx, l.dy));
  const angle = ((Math.round((Math.atan2(l.dy, l.dx) * 180) / Math.PI) % 360) + 360) % 360;
  return { length, angle };
}

export function lineFromPolar(length: number, angle: number): { dx: number; dy: number } {
  const rad = (angle * Math.PI) / 180;
  const half = Math.max(0, length) / 2;
  return { dx: Math.round(Math.cos(rad) * half), dy: Math.round(Math.sin(rad) * half) };
}

// ── what a rotate or a flip does to a layer (canvas dimensions are those BEFORE the operation) ──────────────────

/** A quarter turn clockwise: (x, y) -> (H - y, x). Boxes swap their sides, a line's half-vector turns, text stays upright. */
export function rotateLayerCw(l: Layer, canvas: Size): Layer {
  const cx = canvas.height - l.cy;
  const cy = l.cx;
  if (l.kind === "text") return { ...l, cx, cy };
  if (l.kind === "line") return { ...l, cx, cy, dx: -l.dy, dy: l.dx };
  return { ...l, cx, cy, w: l.h, h: l.w };
}

/** A quarter turn counter-clockwise: (x, y) -> (y, W - x). */
export function rotateLayerCcw(l: Layer, canvas: Size): Layer {
  const cx = l.cy;
  const cy = canvas.width - l.cx;
  if (l.kind === "text") return { ...l, cx, cy };
  if (l.kind === "line") return { ...l, cx, cy, dx: l.dy, dy: -l.dx };
  return { ...l, cx, cy, w: l.h, h: l.w };
}

/** A left-right mirror: x -> W - x. Text is not mirrored (it stays readable). */
export function flipLayerH(l: Layer, canvas: Size): Layer {
  const cx = canvas.width - l.cx;
  return l.kind === "line" ? { ...l, cx, dx: -l.dx } : { ...l, cx };
}
