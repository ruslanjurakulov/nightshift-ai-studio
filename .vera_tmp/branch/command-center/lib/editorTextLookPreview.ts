/**
 * How the editor's preview draws a text clip's outline, shadow and box in CSS.
 *
 * The export draws them with libass (modules/ass_captions.py
 * `build_overlay_ass`); the browser cannot draw the same pixels, so this is an
 * APPROXIMATION built from what the export measurably does
 * (samples/text_looks.json `draws`, measured by tests/test_editor_transitions.py
 * against real ffmpeg + libass):
 *
 *   - an outline of `outline_width` output pixels around the glyphs, in
 *     `outline_color` (drawn as a ring of hard text-shadows);
 *   - a shadow `shadow` pixels down AND to the right, 60 % black;
 *   - a box of `box_color` at `box_opacity` behind each line, padded by a
 *     quarter of the font size on every side, INSTEAD of the outline.
 *
 * A text with none of those fields (every project made before looks existed)
 * keeps the preview it always had, character for character.
 */
import type { CSSProperties } from "react";
import type { TextClip } from "@/lib/editor";
import { BOX_OPACITY_DEFAULT } from "@/lib/editor";

/** What the export does (samples/text_looks.json `draws`). */
export const SHADOW_OPACITY = 0.6;
export const BOX_PADDING_EM = 0.25;
/** The renderer's default outline (modules/timeline.py TEXT_DEFAULTS). */
const DEFAULT_OUTLINE_COLOR = "#000000";
const DEFAULT_OUTLINE_WIDTH = 3;

export const FONT_FAMILY: Record<NonNullable<TextClip["font"]>, string> = {
  "DejaVu Sans": '"DejaVu Sans", Verdana, sans-serif',
  "DejaVu Serif": '"DejaVu Serif", Georgia, serif',
  "Liberation Sans": '"Liberation Sans", Arial, Helvetica, sans-serif',
  "Liberation Serif": '"Liberation Serif", "Times New Roman", Times, serif',
};

type LookFields = Pick<
  TextClip,
  | "size"
  | "outline_color"
  | "outline_width"
  | "shadow"
  | "box_color"
  | "box_opacity"
  | "font"
>;

/** `#RRGGBB` → `rgba(r, g, b, a)`; opacity rounded to 3 decimals. */
export function rgba(hex: string, opacity: number): string {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  const a = Math.round(Math.min(1, Math.max(0, opacity)) * 1000) / 1000;
  return `rgba(${n(1)}, ${n(3)}, ${n(5)}, ${a})`;
}

export const cqw = (px: number, frameWidth: number) =>
  `${Math.round((px / frameWidth) * 100 * 1000) / 1000}cqw`;

/** A ring of hard text-shadows of radius `r` (output pixels). */
export function ring(color: string, r: number, frameWidth: number): string[] {
  if (!(r > 0)) return [];
  const out: string[] = [];
  const steps = Math.min(16, Math.max(8, Math.round(r * 2)));
  for (const k of [1, 0.5]) {
    for (let i = 0; i < steps; i += 1) {
      const a = (2 * Math.PI * i) / steps;
      const dx = Math.round(Math.cos(a) * r * k * 100) / 100;
      const dy = Math.round(Math.sin(a) * r * k * 100) / 100;
      out.push(`${cqw(dx, frameWidth)} ${cqw(dy, frameWidth)} 0 ${color}`);
    }
  }
  return out;
}

/** True for a text that has any of the fields this module draws. */
export function hasLook(x: Partial<LookFields>): boolean {
  return (
    x.outline_color !== undefined ||
    x.outline_width !== undefined ||
    x.shadow !== undefined ||
    x.box_color !== undefined ||
    x.font !== undefined
  );
}

/**
 * The CSS for the text box itself (the absolutely positioned element): its
 * font family and outline / shadow. Merged over the caller's own style
 * (position, size, colour); a text without any look field returns `legacy`
 * unchanged.
 */
export function previewTextStyle(
  x: LookFields,
  frameWidth: number,
  legacyShadow: string,
): CSSProperties {
  if (!hasLook(x)) return { textShadow: legacyShadow };
  const style: CSSProperties = {};
  if (x.font) style.fontFamily = FONT_FAMILY[x.font];
  if (x.box_color) return style; // a box replaces the outline; the box has the shadow
  const shadows = ring(
    x.outline_color ?? DEFAULT_OUTLINE_COLOR,
    x.outline_width ?? DEFAULT_OUTLINE_WIDTH,
    frameWidth,
  );
  if (x.shadow && x.shadow > 0) {
    const s = cqw(x.shadow, frameWidth);
    shadows.push(`${s} ${s} 0 ${rgba("#000000", SHADOW_OPACITY)}`);
  }
  style.textShadow = shadows.length ? shadows.join(", ") : "none";
  return style;
}

/**
 * The CSS for the text's inner inline element: the box behind each line (one
 * rectangle per line, like the export) and its shadow. Empty for a text with
 * no box. `box-decoration-break: clone` gives every wrapped line its own
 * padding.
 */
export function previewBoxStyle(
  x: LookFields,
  frameWidth: number,
): CSSProperties {
  if (!x.box_color) return {};
  const pad = cqw(x.size * BOX_PADDING_EM, frameWidth);
  const style: CSSProperties = {
    backgroundColor: rgba(x.box_color, x.box_opacity ?? BOX_OPACITY_DEFAULT),
    padding: pad,
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  };
  if (x.shadow && x.shadow > 0) {
    const s = cqw(x.shadow, frameWidth);
    style.boxShadow = `${s} ${s} 0 ${rgba("#000000", SHADOW_OPACITY)}`;
  }
  return style;
}
