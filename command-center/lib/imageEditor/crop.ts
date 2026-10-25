import { clampRect, type Rect, type Size } from "@/lib/regionEdit/geometry";

/**
 * Crop maths, in canvas pixels (the picture after mirror and rotation). Whole pixels only; a crop never leaves the
 * picture and is never smaller than MIN_CROP_PX.
 */
export const MIN_CROP_PX = 16;
export const ASPECTS = ["free", "1:1", "4:5", "9:16", "16:9"] as const;
export type AspectId = (typeof ASPECTS)[number];

/** width / height, or null for a free crop. */
export function aspectRatio(id: AspectId): number | null {
  if (id === "free") return null;
  const [w, h] = id.split(":").map(Number);
  return w / h;
}

export const fullRect = (canvas: Size): Rect => ({ x: 0, y: 0, w: canvas.width, h: canvas.height });

export const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** A crop that covers the whole canvas is "no crop" (null), so a no-op never counts as an edit. */
export function normalizeCrop(rect: Rect | null, canvas: Size): Rect | null {
  if (!rect) return null;
  const r = clampCrop(rect, canvas);
  return sameRect(r, fullRect(canvas)) ? null : r;
}

export function clampCrop(rect: Rect, canvas: Size): Rect {
  return clampRect(rect, canvas, MIN_CROP_PX);
}

/**
 * The largest rectangle of the given ratio that fits INSIDE `rect`, centred in it, in whole pixels (it rounds down, so
 * it is always inside, and its ratio is right to within one pixel). Used when an aspect is picked and after a ratio-locked drag.
 */
export function fitAspect(rect: Rect, ratio: number, canvas: Size): Rect {
  const r = clampCrop(rect, canvas);
  let w = r.w;
  let h = Math.floor(w / ratio);
  if (h > r.h) {
    h = r.h;
    w = Math.floor(h * ratio);
  }
  w = Math.max(1, w);
  return clampCrop({ x: r.x + Math.floor((r.w - w) / 2), y: r.y + Math.floor((r.h - h) / 2), w, h }, canvas);
}

/**
 * Change the crop's width or height from a number field. Free: just that side. Locked: the other side follows the
 * ratio and the rectangle stays inside the picture.
 */
export function resizeCrop(rect: Rect, change: { w?: number; h?: number }, ratio: number | null, canvas: Size): Rect {
  if (ratio === null) return clampCrop({ ...rect, w: change.w ?? rect.w, h: change.h ?? rect.h }, canvas);
  const maxW = Math.floor(Math.min(canvas.width, canvas.height * ratio));
  const minW = Math.ceil(MIN_CROP_PX * Math.max(1, ratio));
  let w: number;
  if (change.w !== undefined) w = change.w;
  else if (change.h !== undefined) w = Math.round(change.h * ratio);
  else w = rect.w;
  w = Math.max(Math.min(minW, maxW), Math.min(Math.round(w), maxW));
  const h = Math.min(canvas.height, Math.max(1, Math.round(w / ratio)));
  return clampCrop({ x: rect.x, y: rect.y, w, h }, canvas);
}

// ── what a rotate or a flip does to the crop (canvas dimensions are those BEFORE the operation) ─────────────────

export const rotateRectCw = (r: Rect, canvas: Size): Rect => ({ x: canvas.height - r.y - r.h, y: r.x, w: r.h, h: r.w });
export const rotateRectCcw = (r: Rect, canvas: Size): Rect => ({ x: r.y, y: canvas.width - r.x - r.w, w: r.h, h: r.w });
export const flipRectH = (r: Rect, canvas: Size): Rect => ({ x: canvas.width - r.x - r.w, y: r.y, w: r.w, h: r.h });
