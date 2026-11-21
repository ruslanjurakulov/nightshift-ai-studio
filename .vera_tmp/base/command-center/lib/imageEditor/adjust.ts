/**
 * Brightness, contrast and saturation as ONE pure function over RGBA bytes.
 *
 * The preview and the saved file both run this very function, so what the person sees is what is uploaded (Konva's own
 * filters use other formulas and would make the two disagree). Alpha is never touched. Each control is -100..100 and
 * 0 means "leave it": a neutral adjustment returns without reading a pixel.
 */
export interface Adjust {
  brightness: number;
  contrast: number;
  saturation: number;
}

export const NEUTRAL_ADJUST: Adjust = { brightness: 0, contrast: 0, saturation: 0 };
export const ADJUST_MIN = -100;
export const ADJUST_MAX = 100;
export const ADJUST_KEYS = ["brightness", "contrast", "saturation"] as const;
export type AdjustKey = (typeof ADJUST_KEYS)[number];

export function clampAdjust(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(ADJUST_MIN, Math.min(ADJUST_MAX, Math.round(v)));
}

export const isNeutral = (a: Adjust): boolean => a.brightness === 0 && a.contrast === 0 && a.saturation === 0;

/** 0 -> 1 (no change); -100 -> 0 (nothing left); +100 -> 3 (three times as strong). */
export const gain = (v: number): number => (v >= 0 ? 1 + (v / 100) * 2 : 1 + v / 100);

/** Brightness moves every channel by up to 128 levels either way. */
export const brightnessShift = (b: number): number => (b / 100) * 128;

const clamp8 = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n));

/** Order: brightness, then contrast around mid grey, then saturation around the pixel's own luma (Rec. 709). */
export function applyAdjust(data: Uint8ClampedArray | number[], a: Adjust): void {
  if (isNeutral(a)) return;
  const shift = brightnessShift(a.brightness);
  const c = gain(a.contrast);
  const s = gain(a.saturation);
  for (let i = 0; i + 3 < data.length; i += 4) {
    let r = data[i] + shift;
    let g = data[i + 1] + shift;
    let b = data[i + 2] + shift;
    r = (r - 128) * c + 128;
    g = (g - 128) * c + 128;
    b = (b - 128) * c + 128;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    data[i] = clamp8(luma + (r - luma) * s);
    data[i + 1] = clamp8(luma + (g - luma) * s);
    data[i + 2] = clamp8(luma + (b - luma) * s);
  }
}
