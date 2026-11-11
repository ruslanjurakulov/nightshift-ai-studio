/**
 * Advanced colour (temperature, tint, hue, a tone curve) and a shape mask on a video clip: the model
 * operations the editor's panels call, the export-time check, and the preview's approximations. The
 * document fields, limits and validators are lib/editor.ts (`color`, `mask`; modules/timeline.py has
 * the same rules); the export draws them with ffmpeg (modules/render_backend.py). Saturation and
 * lightness are the clip's existing grade (lib/editorGrade.ts).
 */
import type { CSSProperties } from "react";
import {
  COLOR_HUE_MAX,
  COLOR_TEMP_MAX,
  COLOR_TINT_MAX,
  MASK_DEFAULTS,
  MASK_FEATHER_MAX,
  MASK_MIN,
  MASK_RADIUS_DEFAULT,
  MASK_RADIUS_MAX,
  clamp,
  ms,
  type ClipColor,
  type ClipMask,
  type ColorCurve,
  type EditorModel,
  type MaskShape,
  type VideoClip,
} from "@/lib/editor";
import { renderWork, type RenderWork } from "@/lib/editorMotion";

export type ColorKey = "temperature" | "tint" | "hue";
export const COLOR_RANGES: Record<ColorKey, { min: number; max: number; step: number }> = {
  temperature: { min: -COLOR_TEMP_MAX, max: COLOR_TEMP_MAX, step: 1 },
  tint: { min: -COLOR_TINT_MAX, max: COLOR_TINT_MAX, step: 1 },
  hue: { min: -COLOR_HUE_MAX, max: COLOR_HUE_MAX, step: 1 },
};

function withClip(model: EditorModel, id: string, f: (c: VideoClip) => VideoClip): EditorModel {
  return { ...model, clips: model.clips.map((c) => (c.id === id ? f(c) : c)) };
}

function without<K extends keyof VideoClip>(c: VideoClip, k: K): VideoClip {
  const out = { ...c };
  delete out[k];
  return out;
}

export function colorValue(c: Pick<VideoClip, "color">, k: ColorKey): number {
  return c.color?.[k] ?? 0;
}

export function hasColor(c: Pick<VideoClip, "color">): boolean {
  return Boolean(c.color && (c.color.temperature || c.color.tint || c.color.hue || c.color.curve));
}

/** The clip with one colour value (clamped, to the step); 0 removes it, and a colour of nothing is none. */
export function setClipColor(model: EditorModel, id: string, k: ColorKey, v: number): EditorModel {
  const r = COLOR_RANGES[k];
  const n = Number.isFinite(v) ? Math.round(clamp(v, r.min, r.max)) : 0;
  return withClip(model, id, (c) => tidyColor(c, { ...c.color, [k]: n }));
}

export function setClipCurve(model: EditorModel, id: string, curve: ColorCurve | null): EditorModel {
  return withClip(model, id, (c) => {
    const next: ClipColor = { ...c.color };
    if (curve) next.curve = curve;
    else delete next.curve;
    return tidyColor(c, next);
  });
}

export function resetClipColor(model: EditorModel, id: string): EditorModel {
  return withClip(model, id, (c) => without(c, "color"));
}

function tidyColor(c: VideoClip, col: ClipColor): VideoClip {
  const out: ClipColor = {};
  for (const k of ["temperature", "tint", "hue"] as const) if (col[k]) out[k] = col[k];
  if (col.curve) out.curve = col.curve;
  return Object.keys(out).length ? { ...c, color: out } : without(c, "color");
}

/** A mask with its defaults filled in (what the export draws). */
export function maskOf(m: ClipMask): Required<Omit<ClipMask, "radius">> & { radius: number } {
  return {
    shape: m.shape,
    x: m.x ?? MASK_DEFAULTS.x,
    y: m.y ?? MASK_DEFAULTS.y,
    w: m.w ?? MASK_DEFAULTS.w,
    h: m.h ?? MASK_DEFAULTS.h,
    feather: m.feather ?? MASK_DEFAULTS.feather,
    radius: m.shape === "rounded" ? (m.radius ?? MASK_RADIUS_DEFAULT) : 0,
    invert: m.invert === true,
  };
}

export type MaskNumber = "x" | "y" | "w" | "h" | "feather" | "radius";
export const MASK_RANGES: Record<MaskNumber, { min: number; max: number }> = {
  x: { min: 0, max: 1 },
  y: { min: 0, max: 1 },
  w: { min: MASK_MIN, max: 1 },
  h: { min: MASK_MIN, max: 1 },
  feather: { min: 0, max: MASK_FEATHER_MAX },
  radius: { min: 0, max: MASK_RADIUS_MAX },
};

/** Put a mask on the clip (or change its shape): a new one is centred, 60 % of the frame. */
export function setClipMaskShape(model: EditorModel, id: string, shape: MaskShape | null): EditorModel {
  return withClip(model, id, (c) => {
    if (!shape) return without(c, "mask");
    const next: ClipMask = { ...(c.mask ?? {}), shape };
    if (shape === "rounded") next.radius = c.mask?.radius ?? MASK_RADIUS_DEFAULT;
    else delete next.radius;
    return { ...c, mask: next };
  });
}

export function setClipMaskValue(model: EditorModel, id: string, k: MaskNumber, v: number): EditorModel {
  return withClip(model, id, (c) => {
    if (!c.mask || (k === "radius" && c.mask.shape !== "rounded")) return c;
    const r = MASK_RANGES[k];
    const fallback = k === "radius" ? MASK_RADIUS_DEFAULT : MASK_DEFAULTS[k];
    const n = Number.isFinite(v) ? ms(clamp(v, r.min, r.max)) : fallback;
    return { ...c, mask: { ...c.mask, [k]: n } };
  });
}

export function setClipMaskInvert(model: EditorModel, id: string, on: boolean): EditorModel {
  return withClip(model, id, (c) => {
    if (!c.mask) return c;
    const next: ClipMask = { ...c.mask };
    if (on) next.invert = true;
    else delete next.invert;
    return { ...c, mask: next };
  });
}

/** Does this change still fit the export's time allowance? (Judged on the whole model, as Save is.) An
 *  edit that takes colour or a mask away always fits. */
export function lookCheck(next: EditorModel): { ok: true } | { ok: false; render: RenderWork } {
  const render = renderWork(next);
  return render.ok ? { ok: true } : { ok: false, render };
}

/**
 * The preview's mask, in CSS on the frame: an ellipse (with its feather and inversion) as a radial mask
 * image; a rectangle or rounded rectangle as a clip path (inverted as a frame with a hole). The feather
 * of a rectangle is not drawn: the export is the truth, and the panel says so.
 */
export function maskPreviewStyle(mask: ClipMask | undefined): CSSProperties {
  if (!mask) return {};
  const m = maskOf(mask);
  const pc = (v: number) => `${(v * 100).toFixed(2)}%`;
  if (m.shape === "ellipse") {
    const inner = Math.max(0, 1 - m.feather * 2);
    const [on, off] = m.invert ? ["transparent", "#000"] : ["#000", "transparent"];
    const img = `radial-gradient(ellipse ${pc(m.w / 2)} ${pc(m.h / 2)} at ${pc(m.x)} ${pc(m.y)}, ${on} ${(inner * 100).toFixed(1)}%, ${off} 100%)`;
    return { maskImage: img, WebkitMaskImage: img };
  }
  const x1 = clamp(m.x - m.w / 2, 0, 1);
  const x2 = clamp(m.x + m.w / 2, 0, 1);
  const y1 = clamp(m.y - m.h / 2, 0, 1);
  const y2 = clamp(m.y + m.h / 2, 0, 1);
  if (m.invert) {
    const ring = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${pc(x1)} ${pc(y1)}, ${pc(x2)} ${pc(y1)}, ${pc(x2)} ${pc(y2)}, ${pc(x1)} ${pc(y2)}, ${pc(x1)} ${pc(y1)})`;
    return { clipPath: ring };
  }
  const round = m.shape === "rounded" ? ` round ${pc(m.radius * Math.min(m.w, m.h))}` : "";
  return { clipPath: `inset(${pc(y1)} ${pc(1 - x2)} ${pc(1 - y2)} ${pc(x1)}${round})` };
}

/** The preview's hue turn (CSS `hue-rotate`); temperature, tint and the curves are not drawn. */
export function huePreview(c: Pick<VideoClip, "color"> | null | undefined): string {
  const h = c?.color?.hue ?? 0;
  return h ? `hue-rotate(${h}deg)` : "";
}
