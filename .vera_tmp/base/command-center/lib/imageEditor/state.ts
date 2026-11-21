import type { Rect, Size } from "@/lib/regionEdit/geometry";
import { NEUTRAL_ADJUST, isNeutral, type Adjust } from "./adjust";
import { flipRectH, normalizeCrop, rotateRectCcw, rotateRectCw, sameRect } from "./crop";
import { flipLayerH, rotateLayerCcw, rotateLayerCw, type Layer } from "./layers";

/**
 * Everything a person has done to the picture, as one small immutable value (what undo and redo snapshot).
 *
 * The source is mirrored (left-right) if `mirrored`, then turned `rotation` degrees clockwise: that is the CANVAS. The
 * crop is a window onto the canvas, adjustments colour the picture only (never the text and shapes on top), and layers
 * sit over it. Saving flattens exactly this, in this order, and nothing else.
 */
export type Rotation = 0 | 90 | 180 | 270;

export interface EditState {
  rotation: Rotation;
  mirrored: boolean;
  /** In canvas pixels; null = the whole canvas. */
  crop: Rect | null;
  adjust: Adjust;
  layers: readonly Layer[];
}

/**
 * Same ceiling idea as REGION_MAX_SOURCE_PIXELS (modules/region_edit.py): 16 megapixels. It is also what browsers can
 * reliably hold in one canvas (iOS Safari stops at 16,777,216 pixels), so a larger picture could not be saved anyway.
 */
export const MAX_EDIT_PIXELS = 16_000_000;

/** Types a browser can decode in a canvas AND the library accepts. HEIC / GIF / video / audio are not edited here. */
export const EDITABLE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export const isEditableMime = (mime: unknown): boolean => typeof mime === "string" && (EDITABLE_MIMES as readonly string[]).includes(mime.toLowerCase());

export const initialState = (): EditState => ({ rotation: 0, mirrored: false, crop: null, adjust: NEUTRAL_ADJUST, layers: [] });

export const tooManyPixels = (size: Size): boolean => size.width * size.height > MAX_EDIT_PIXELS;

/** The canvas: the source with its sides swapped for a quarter turn. */
export const canvasSize = (src: Size, rotation: Rotation): Size =>
  rotation === 90 || rotation === 270 ? { width: src.height, height: src.width } : { width: src.width, height: src.height };

/** What the saved file measures: the crop, or the whole canvas. */
export function outputSize(src: Size, s: Pick<EditState, "rotation" | "crop">): Size {
  const c = canvasSize(src, s.rotation);
  return s.crop ? { width: s.crop.w, height: s.crop.h } : c;
}

export const isEdited = (s: EditState): boolean => s.rotation !== 0 || s.mirrored || s.crop !== null || !isNeutral(s.adjust) || s.layers.length > 0;

type P = { x: number; y: number };

/** Where a point of the source lands on the canvas: mirror first, then the clockwise turn. */
export function mapSourcePoint(src: Size, rotation: Rotation, mirrored: boolean, p: P): P {
  const mx = mirrored ? src.width - p.x : p.x;
  const my = p.y;
  switch (rotation) {
    case 90:
      return { x: src.height - my, y: mx };
    case 180:
      return { x: src.width - mx, y: src.height - my };
    case 270:
      return { x: my, y: src.width - mx };
    default:
      return { x: mx, y: my };
  }
}

/** The 2D-canvas matrix [a, b, c, d, e, f] that draws the source onto the canvas (from mapSourcePoint, so they cannot disagree). */
export function baseMatrix(src: Size, rotation: Rotation, mirrored: boolean): [number, number, number, number, number, number] {
  const o = mapSourcePoint(src, rotation, mirrored, { x: 0, y: 0 });
  const ex = mapSourcePoint(src, rotation, mirrored, { x: 1, y: 0 });
  const ey = mapSourcePoint(src, rotation, mirrored, { x: 0, y: 1 });
  return [ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y];
}

const next = (r: Rotation, quarter: number): Rotation => ((((r / 90 + quarter) % 4) + 4) % 4) * 90 as Rotation;

export function rotateCw(s: EditState, src: Size): EditState {
  const before = canvasSize(src, s.rotation);
  return {
    ...s,
    rotation: next(s.rotation, 1),
    crop: s.crop && rotateRectCw(s.crop, before),
    layers: s.layers.map((l) => rotateLayerCw(l, before)),
  };
}

export function rotateCcw(s: EditState, src: Size): EditState {
  const before = canvasSize(src, s.rotation);
  return {
    ...s,
    rotation: next(s.rotation, -1),
    crop: s.crop && rotateRectCcw(s.crop, before),
    layers: s.layers.map((l) => rotateLayerCcw(l, before)),
  };
}

/**
 * Mirror the canvas left-right. A mirror after a turn equals the opposite turn after a mirror (M R(t) = R(-t) M), which is why the
 * rotation is negated: the state keeps its single "mirror, then turn" form.
 */
export function flipHorizontal(s: EditState, src: Size): EditState {
  const c = canvasSize(src, s.rotation);
  return {
    ...s,
    mirrored: !s.mirrored,
    rotation: next(s.rotation, -2 * (s.rotation / 90)),
    crop: s.crop && flipRectH(s.crop, c),
    layers: s.layers.map((l) => flipLayerH(l, c)),
  };
}

/** Mirror top-bottom = mirror left-right, then half a turn. */
export const flipVertical = (s: EditState, src: Size): EditState => rotateCw(rotateCw(flipHorizontal(s, src), src), src);

export function withCrop(s: EditState, crop: Rect | null, src: Size): EditState {
  const normal = normalizeCrop(crop, canvasSize(src, s.rotation));
  const same = normal === s.crop || (normal !== null && s.crop !== null && sameRect(normal, s.crop));
  return same ? s : { ...s, crop: normal };
}
