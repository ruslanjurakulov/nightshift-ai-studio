import { applyAdjust, type Adjust } from "@/lib/imageEditor/adjust";
import { baseMatrix, type Rotation } from "@/lib/imageEditor/state";
import type { Rect, Size } from "@/lib/regionEdit/geometry";

/**
 * The picture itself (no text, no shapes) drawn into a 2D canvas: mirrored, turned, windowed to the crop, then coloured.
 * The preview calls this at a reduced scale and the saved file at scale 1, with the SAME matrix (lib/imageEditor/state.ts
 * baseMatrix) and the SAME colour function (lib/imageEditor/adjust.ts), so the two cannot disagree.
 */
export interface BaseSpec {
  rotation: Rotation;
  mirrored: boolean;
  adjust: Adjust;
}

/** Null when the browser gives no 2D context (then nothing can be shown or saved, and the caller says so). */
export function renderBase(
  img: CanvasImageSource,
  src: Size,
  spec: BaseSpec,
  area: Rect,
  scale: number,
  opaque = false,
): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(area.w * scale));
  canvas.height = Math.max(1, Math.round(area.h * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  if (opaque) {
    // A JPEG has no transparency: a transparent PNG would turn black, so it goes onto white.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const [a, b, c, d, e, f] = baseMatrix(src, spec.rotation, spec.mirrored);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(a * scale, b * scale, c * scale, d * scale, (e - area.x) * scale, (f - area.y) * scale);
  ctx.drawImage(img, 0, 0, src.width, src.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (spec.adjust.brightness !== 0 || spec.adjust.contrast !== 0 || spec.adjust.saturation !== 0) {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyAdjust(data.data, spec.adjust);
    ctx.putImageData(data, 0, 0);
  }
  return canvas;
}

/** The preview works on at most this many pixels on the long side, whatever the picture's size. */
export const PREVIEW_LONG_SIDE = 1600;
export const previewScale = (canvas: Size): number => Math.min(1, PREVIEW_LONG_SIDE / Math.max(canvas.width, canvas.height, 1));
