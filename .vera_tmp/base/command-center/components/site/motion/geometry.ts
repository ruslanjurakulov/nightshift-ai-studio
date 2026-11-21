/** The pure arithmetic behind the pointer effects, kept apart so a test can pin the limits without a browser. */

type Box = { left: number; top: number; width: number; height: number };

const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));

/** The furthest a magnetic key moves toward the pointer, in px. More than this and the key leaves its own focus ring behind. */
export const MAGNET_MAX = 6;
/** The furthest the hero's picture moves against the pointer, in px (the brief's ceiling is 8). */
export const PARALLAX_MAX = 8;

/**
 * A magnetic key's pull: a fifth of the pointer's distance from the key's centre, never more than MAGNET_MAX on either axis.
 * Rounded to a tenth of a pixel so the style string does not change on every sub-pixel move.
 */
export function magnetOffset(box: Box, x: number, y: number, max = MAGNET_MAX): { x: number; y: number } {
  const dx = (x - (box.left + box.width / 2)) * 0.2;
  const dy = (y - (box.top + box.height / 2)) * 0.2;
  return { x: Math.round(clamp(dx, max) * 10) / 10, y: Math.round(clamp(dy, max) * 10) / 10 };
}

/**
 * The hero picture's offset: the pointer's position across the hero mapped to -1..1 and the picture moved the other way, so
 * it reads as depth. At the hero's edge it is exactly `max`; outside the box (a pointer event that bubbled from a menu) it is
 * clamped, never further.
 */
export function parallaxOffset(box: Box, x: number, y: number, max = PARALLAX_MAX): { x: number; y: number } {
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
  const nx = clamp(((x - box.left) / box.width) * 2 - 1, 1);
  const ny = clamp(((y - box.top) / box.height) * 2 - 1, 1);
  return { x: Math.round(-nx * max * 10) / 10, y: Math.round(-ny * max * 10) / 10 };
}
