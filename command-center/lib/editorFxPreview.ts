/**
 * What the editor's preview can show of the clip effects, the turn / mirror /
 * crop / free angle and the entrance / exit animations. The export (ffmpeg) is
 * the reference; every function here is a browser approximation built from the
 * same document fields and says so in the product:
 *
 *   * looks: an SVG filter whose per-channel tables are the export's curve
 *     points moved toward the look by its strength (the same numbers as
 *     modules/render_backend.py `_FILTER_CURVES`, pinned by
 *     samples/clip_look_curves.json on both sides). Blur is CSS `blur()` in a
 *     share of the frame's width, vignette a radial shade. Sharpen and grain
 *     have no faithful CSS twin and are not drawn.
 *   * geometry: a nested "stage" (`stageLayout`) places the picture as the
 *     export does: turn and mirror the source, crop it, fit it (bars / fill),
 *     then turn the fitted picture by the free angle.
 *   * animations: `animFrame` is the opacity / offset / scale an item has at a
 *     moment, for the paused preview and the playing one.
 *
 * Nothing here is sent anywhere or changes the document.
 */
import type { CSSProperties } from "react";
import {
  ANIM_DEFAULT_S,
  BLUR_MAX,
  clamp,
  type ClipCrop,
  type ClipFilter,
  type ClipMove,
  type VideoClip,
} from "@/lib/editor";
import { GRADE_FILTER_ID, gradeOf, isNeutralGrade } from "@/lib/editorGrade";
import { centreRange, windowOf } from "@/lib/editorMotion";

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const pct = (v: number) => `${round3(v * 100)}%`;

// ── looks ───────────────────────────────────────────────────────────────────

type Pts = readonly (readonly [number, number])[];

/** The export's curve points per look (modules/render_backend.py
 *  `_FILTER_CURVES`; samples/clip_look_curves.json pins the two together).
 *  `all` is the master curve. */
export const LOOK_CURVES: Record<
  Exclude<ClipFilter, "mono" | "sepia">,
  Partial<Record<"r" | "g" | "b" | "all", Pts>>
> = {
  vintage: {
    r: [[0, 0.08], [0.5, 0.53], [1, 0.96]],
    g: [[0, 0.05], [0.5, 0.48], [1, 0.9]],
    b: [[0, 0.12], [0.5, 0.44], [1, 0.76]],
  },
  cinematic: {
    r: [[0, 0], [0.3, 0.22], [0.7, 0.78], [1, 1]],
    g: [[0, 0.02], [0.5, 0.5], [1, 0.97]],
    b: [[0, 0.06], [0.3, 0.36], [0.7, 0.62], [1, 0.9]],
  },
  cool: { r: [[0, 0], [1, 0.88]], b: [[0, 0.06], [1, 1]] },
  warm: { r: [[0, 0.04], [1, 1]], b: [[0, 0], [1, 0.86]] },
  "high-contrast": { all: [[0, 0], [0.25, 0.15], [0.75, 0.87], [1, 1]] },
};

/** The classic sepia matrix (rows are the output r, g, b). */
export const SEPIA_MATRIX = [
  [0.393, 0.769, 0.189],
  [0.349, 0.686, 0.168],
  [0.272, 0.534, 0.131],
] as const;

/** Where a curve (control points moved from "no change" toward the look by
 *  `k`) is at `x`: piecewise linear between the points. */
export function curveAt(points: Pts, k: number, x: number): number {
  const ys = points.map(([px, py]) => [px, px + (py - px) * k] as const);
  if (x <= ys[0][0]) return ys[0][1];
  for (let i = 1; i < ys.length; i += 1) {
    if (x <= ys[i][0]) {
      const [x0, y0] = ys[i - 1];
      const [x1, y1] = ys[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return ys[ys.length - 1][1];
}

/** Samples of a channel's table for an SVG `feFuncR/G/B type="table"`. */
export const TABLE_STEPS = 17;
export function curveTable(points: Pts | undefined, k: number): string {
  const out: number[] = [];
  for (let i = 0; i < TABLE_STEPS; i += 1) {
    const x = i / (TABLE_STEPS - 1);
    out.push(round3(points ? curveAt(points, k, x) : x));
  }
  return out.join(" ");
}

/** The 4x5 `feColorMatrix` values of the sepia look at strength `k`. */
export function sepiaValues(k: number): string {
  const rows: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1)
      rows.push(round3((i === j ? 1 : 0) + (SEPIA_MATRIX[i][j] - (i === j ? 1 : 0)) * k));
    rows.push(0, 0);
  }
  rows.push(0, 0, 0, 1, 0);
  return rows.join(" ");
}

/** What the look's SVG filter holds: a saturate for mono, a matrix for sepia,
 *  per-channel tables for the curve looks. */
export type LookSpec =
  | { kind: "saturate"; value: string }
  | { kind: "matrix"; value: string }
  | { kind: "tables"; r: string; g: string; b: string };

export function lookSpec(filter: ClipFilter, strength: number): LookSpec {
  const k = Math.min(1, Math.max(0, strength));
  if (filter === "mono") return { kind: "saturate", value: String(round3(1 - k)) };
  if (filter === "sepia") return { kind: "matrix", value: sepiaValues(k) };
  const c = LOOK_CURVES[filter];
  return {
    kind: "tables",
    r: curveTable(c.r ?? c.all, k),
    g: curveTable(c.g ?? c.all, k),
    b: curveTable(c.b ?? c.all, k),
  };
}

/** The id of the one `<filter>` that holds the look (one clip is on screen). */
export const LOOK_FILTER_ID = "ns-clip-look";

export function hasLook(clip: Pick<VideoClip, "filter" | "filter_strength">): boolean {
  return Boolean(clip.filter) && (clip.filter_strength ?? 1) > 0;
}

/** A blur of `sigma` OUTPUT pixels, as a CSS length that scales with the
 *  preview: a share of the frame's width (container query units). */
export function blurLength(sigma: number, frameWidth: number): string {
  const s = Math.min(BLUR_MAX, Math.max(0, sigma));
  return `${round3((s / frameWidth) * 100)}cqw`;
}

/** The CSS `filter` of the picture: colour (the Colour panel), then the look,
 *  then the blur, in the export's order. Empty for a clip with none of them,
 *  so its element is exactly what it was before effects existed. */
export function previewFilterStyle(
  clip: Partial<Pick<VideoClip, "grade" | "filter" | "filter_strength" | "blur">> | null | undefined,
  frameWidth: number,
): CSSProperties {
  if (!clip) return {};
  const parts: string[] = [];
  if (clip.grade && !isNeutralGrade(gradeOf({ grade: clip.grade })))
    parts.push(`url(#${GRADE_FILTER_ID})`);
  if (hasLook(clip)) parts.push(`url(#${LOOK_FILTER_ID})`);
  if ((clip.blur ?? 0) > 0) parts.push(`blur(${blurLength(clip.blur ?? 0, frameWidth)})`);
  return parts.length ? { filter: parts.join(" ") } : {};
}

/** The vignette's shade: a dark ring toward the corners, as strong as the
 *  setting (the export's lens-angle vignette is darker at the very corners). */
export function vignetteStyle(strength: number): CSSProperties {
  const s = Math.min(1, Math.max(0, strength));
  return {
    background: `radial-gradient(ellipse at center, rgba(0,0,0,0) ${round3(70 - 35 * s)}%, rgba(0,0,0,${round3(0.85 * s)}) 100%)`,
  };
}

// ── geometry: turn, mirror, crop, fit, free angle ───────────────────────────

/** The fields of a clip that move or cut the picture. */
export type GeometryClip = Partial<
  Pick<VideoClip, "rotate" | "flip_h" | "flip_v" | "crop" | "angle" | "fit" | "move">
>;

const cropOfClip = (c: GeometryClip): { x: number; y: number; w: number; h: number } => ({
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  ...(c.crop as ClipCrop | undefined),
});

/** Does the picture need the nested stage (a turn, mirror, crop, free angle,
 *  move or blurred-background fit)? Without one the preview draws the plain
 *  element it always did. A picture has no blurred background (it always fills). */
export function needsStage(
  c: GeometryClip | null | undefined,
  still = false,
): boolean {
  if (!c) return false;
  const k = cropOfClip(c);
  return Boolean(
    c.move ||
      (c.fit === "blur" && !still) ||
      c.rotate ||
      c.flip_h ||
      c.flip_v ||
      c.angle ||
      k.x !== 0 ||
      k.y !== 0 ||
      k.w !== 1 ||
      k.h !== 1,
  );
}

/** One picture chain: the cropped box, the whole turned picture inside it, the
 *  media inside that. */
export interface Chain {
  crop: CSSProperties;
  turned: CSSProperties;
  media: CSSProperties;
}

export interface Stage extends Chain {
  /** Frame-sized (bars / fill / blurred background) or the visible picture's
   *  box (fit with bars); the free angle turns it. */
  fit: CSSProperties;
  /** Only with `fit: blur`: the same picture filling the frame, blurred, behind. */
  backdrop?: Chain & { blur: CSSProperties };
}

/** The blurred background's strength: the export shrinks the picture to 1/8
 *  and blurs it with sigma 3 (modules/render_backend.py BLUR_FIT_SHRINK and
 *  BLUR_FIT_SIGMA), i.e. about 24 px at full size. */
export const BACKDROP_SIGMA_PX = 8 * 3;

/**
 * The stage for a clip in a frame of the given size. `source` is the file's
 * pixel size (null = unknown: the picture is taken to have the frame's own
 * shape); `still` pictures are always drawn filling the frame, like the export.
 *
 * Order, as in the export: turn (quarter turns) and mirror the source, crop the
 * turned picture, fit the cropped part into the frame (bars / fill / over a
 * blurred copy), then turn the fitted picture by the free angle about the
 * frame's centre. A move (zoom and pan) acts on all of this, see `moveStyle`.
 */
export function stageLayout(
  c: GeometryClip,
  frame: { width: number; height: number },
  source: { width: number | null; height: number | null } | null,
  still: boolean,
): Stage {
  const F = frame.width / frame.height;
  const sw = source?.width ?? 0;
  const sh = source?.height ?? 0;
  const quarter = c.rotate === 90 || c.rotate === 270;
  // The shape of the turned picture; an unknown file is taken to have the frame's shape.
  const turned = sw > 0 && sh > 0 ? (quarter ? sh / sw : sw / sh) : F;
  const k = cropOfClip(c);
  const cropped = turned * (k.w / k.h);
  const blur = c.fit === "blur" && !still;
  const fill = still || c.fit === "cover";
  // Box of the cropped picture inside the frame, as shares of the frame.
  const box = (filling: boolean) =>
    filling === (cropped >= F)
      ? // fill with a wide picture, or contain with a tall one: the height is the frame's
        { w: cropped / F, h: 1 }
      : { w: 1, h: F / cropped };
  const angle = c.angle ?? 0;
  const spin = angle ? ` rotate(${angle}deg)` : "";
  const center = "translate(-50%, -50%)";
  const placed = (b: { w: number; h: number }): CSSProperties => ({
    position: "absolute",
    left: "50%",
    top: "50%",
    width: pct(b.w),
    height: pct(b.h),
    transform: center,
    overflow: "hidden",
  });
  // The whole turned picture, shifted so the crop window lands on the box.
  const turnedStyle: CSSProperties = {
    position: "absolute",
    width: pct(1 / k.w),
    height: pct(1 / k.h),
    left: pct(-k.x / k.w),
    top: pct(-k.y / k.h),
  };
  // The media: a quarter turn swaps its box (its width is the turned picture's height).
  const flips = `${c.flip_h ? " scaleX(-1)" : ""}${c.flip_v ? " scaleY(-1)" : ""}`;
  const turn = c.rotate ? ` rotate(${c.rotate}deg)` : "";
  const mediaStyle: CSSProperties = {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: quarter ? pct(1 / turned) : "100%",
    height: quarter ? pct(turned) : "100%",
    transform: `${center}${flips}${turn}`,
    objectFit: "contain",
    maxWidth: "none",
  };
  const bars = box(false);
  const filling = box(true);
  // `fit` is the visible region: the frame itself when filling or over a
  // blurred background, the picture's box when there are bars.
  const frameSized = fill || blur;
  const fitStyle: CSSProperties = {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: pct(frameSized ? 1 : bars.w),
    height: pct(frameSized ? 1 : bars.h),
    transform: `${center}${spin}`,
    overflow: "hidden",
  };
  // Inside `fit`, the cropped picture: as big as the box, bigger when filling,
  // the contained picture centred over the backdrop with a blurred fit.
  const cropStyle: CSSProperties = blur
    ? placed(bars)
    : fill
      ? placed(filling)
      : { position: "absolute", inset: 0, overflow: "hidden" };
  const out: Stage = {
    fit: fitStyle,
    crop: cropStyle,
    turned: turnedStyle,
    media: mediaStyle,
  };
  if (blur) {
    const sigma = (BACKDROP_SIGMA_PX / frame.width) * 100;
    out.backdrop = {
      // a little bigger than the frame, so the blur's soft edge falls outside it
      crop: { ...placed(filling), transform: `${center} scale(1.12)` },
      turned: turnedStyle,
      media: mediaStyle,
      blur: { filter: `blur(${round3(sigma)}cqw)` },
    };
  }
  return out;
}

// ── a zoom and pan over the clip ────────────────────────────────────────────

/** The window of a move at a point `progress` (0 to 1) of the clip's length:
 *  a straight line between the two ends, its centre held where the window
 *  stays inside the picture (what the export does). */
export function moveWindowAt(
  move: ClipMove,
  progress: number,
): { zoom: number; x: number; y: number } {
  const a = windowOf(move.from);
  const b = windowOf(move.to);
  const p = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  const zoom = a.zoom + (b.zoom - a.zoom) * p;
  const r = centreRange(zoom);
  return {
    zoom,
    x: clamp(a.x + (b.x - a.x) * p, r.min, r.max),
    y: clamp(a.y + (b.y - a.y) * p, r.min, r.max),
  };
}

/** The transform that shows the window of a move on a frame-sized layer. */
export function moveStyle(
  move: ClipMove | undefined,
  progress: number,
): CSSProperties {
  if (!move) return {};
  const w = moveWindowAt(move, progress);
  const left = w.x - 0.5 / w.zoom;
  const top = w.y - 0.5 / w.zoom;
  return {
    transformOrigin: "0 0",
    transform: `translate(${pct(-left * w.zoom)}, ${pct(-top * w.zoom)}) scale(${round3(w.zoom)})`,
  };
}

/** Can the browser's own video element play this clip as it is (forward, at a
 *  constant speed)? A reversed, frozen or ramped clip is stepped by the editor
 *  instead: the preview seeks to the right frame as the playhead moves. */
export function playsNatively(
  c: Pick<VideoClip, "reverse" | "freeze" | "speed_curve"> | null | undefined,
): boolean {
  return !c || !(c.reverse || c.freeze || c.speed_curve);
}

// ── entrance / exit animation at a moment ───────────────────────────────────

/** A slide travels this share of the frame (docs/editor-render-fields.md §2). */
export const SLIDE_SHARE = 0.15;
/** A pop starts at this share of full size. */
export const POP_FROM = 0.6;

export interface AnimFrame {
  /** Multiplies the item's own opacity. */
  opacity: number;
  /** Offsets in shares of the frame's width and height (+x right, +y down). */
  dx: number;
  dy: number;
  scale: number;
  /** Typewriter: the share of the text written so far (null = all of it). */
  written: number | null;
}

export const ANIM_REST: AnimFrame = { opacity: 1, dx: 0, dy: 0, scale: 1, written: null };

type Timed = {
  start_s: number;
  end_s: number;
  anim_in?: string;
  anim_out?: string;
  anim_in_s?: number;
  anim_out_s?: number;
};

function slide(kind: string, away: number): { dx: number; dy: number } {
  // `away` is 0 at rest and 1 fully off: the entrance comes from the side the
  // name's direction points away from; the exit leaves toward it.
  switch (kind) {
    case "slide-up":
      return { dx: 0, dy: away };
    case "slide-down":
      return { dx: 0, dy: -away };
    case "slide-left":
      return { dx: away, dy: 0 };
    case "slide-right":
      return { dx: -away, dy: 0 };
    default:
      return { dx: 0, dy: 0 };
  }
}

/** The look of an animated item at timeline time `t`. An item without an
 *  animation (or outside it) is at rest. The exit is the entrance mirrored:
 *  `slide-up` enters from below and leaves upward. */
export function animFrame(item: Timed, t: number): AnimFrame {
  let f: AnimFrame = ANIM_REST;
  if (item.anim_in) {
    const d = item.anim_in_s ?? ANIM_DEFAULT_S;
    const p = Math.min(1, Math.max(0, (t - item.start_s) / d));
    if (p < 1) {
      if (item.anim_in === "typewriter") f = { ...f, written: p };
      else {
        const s = slide(item.anim_in, SLIDE_SHARE * (1 - p));
        f = {
          ...f,
          opacity: f.opacity * p,
          dx: f.dx + s.dx,
          dy: f.dy + s.dy,
          scale: item.anim_in === "pop" ? POP_FROM + (1 - POP_FROM) * p : f.scale,
        };
      }
    }
  }
  if (item.anim_out) {
    const d = item.anim_out_s ?? ANIM_DEFAULT_S;
    const q = Math.min(1, Math.max(0, (item.end_s - t) / d));
    if (q < 1) {
      // slide-up leaves upward: the opposite sign of the entrance
      const s = slide(item.anim_out, -SLIDE_SHARE * (1 - q));
      f = {
        ...f,
        opacity: f.opacity * q,
        dx: f.dx + s.dx,
        dy: f.dy + s.dy,
        scale: item.anim_out === "pop" ? f.scale * (POP_FROM + (1 - POP_FROM) * q) : f.scale,
      };
    }
  }
  return f;
}

/** The part of a text a typewriter has written (all of it without one). */
export function writtenText(text: string, written: number | null): string {
  if (written === null) return text;
  const chars = Array.from(text);
  return chars.slice(0, Math.ceil(chars.length * written)).join("");
}
