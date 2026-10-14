/**
 * Picture overlays (a picture or a video laid over the picture: picture in
 * picture, a sticker, a logo): the pure model edits and the ONE place the
 * preview takes its geometry from the document.
 *
 * The document holds a top-level `overlays` list (modules/timeline.py): each
 * entry is `{ id, asset_id, start_s, end_s, x, y, w, opacity }`. (x, y) is the
 * CENTRE of the overlay and `w` its width, both as fractions of the frame, so
 * the same overlay fits any resolution; its height follows the file's own
 * aspect ratio. They are drawn in list order (later on top), under the texts,
 * may overlap in time, and never lengthen the timeline.
 *
 * The export lays them over the composited picture with ffmpeg `overlay`
 * (modules/render_spec.py `picture_overlay_filters`); the preview draws the
 * same fractions as an absolutely positioned element (`overlayPreviewStyle`).
 * `overlayRect` is that arithmetic in frame pixels, pinned to a shared fixture
 * (samples/overlay_preview.json) that tests/test_editor_overlay.py measures a
 * real ffmpeg export against. Preview and export are two renderers: the test's
 * tolerance is the honest gap.
 */
import type { CSSProperties } from "react";
import {
  MAX_OVERLAYS,
  MAX_OVERLAY_VIDEOS,
  MIN_CLIP_S,
  OVERLAY_DEFAULTS,
  OVERLAY_W_MAX,
  OVERLAY_W_MIN,
  clamp,
  MAX_PARTIAL_OPACITY_MOVES,
  fitAnims,
  freshId,
  partialOpacityMove,
  ms,
  pictureEndOf,
  type EditorAsset,
  type EditorModel,
  type PictureOverlay,
} from "@/lib/editor";

export { OVERLAY_DEFAULTS, OVERLAY_W_MAX, OVERLAY_W_MIN };

/** How long a new overlay lasts, at most (seconds). */
export const OVERLAY_DEFAULT_S = 5;

export type OverlayKey = "x" | "y" | "w" | "opacity";

/** The valid range of each number (modules/timeline.py: x / y / opacity 0..1,
 *  w 0.05..1), the value a Reset returns it to, and the editor's slider step
 *  (a nudge with the arrow keys is one step). */
export const OVERLAY_RANGES: Record<
  OverlayKey,
  { min: number; max: number; neutral: number; step: number }
> = {
  x: { min: 0, max: 1, neutral: OVERLAY_DEFAULTS.x, step: 0.01 },
  y: { min: 0, max: 1, neutral: OVERLAY_DEFAULTS.y, step: 0.01 },
  w: {
    min: OVERLAY_W_MIN,
    max: OVERLAY_W_MAX,
    neutral: OVERLAY_DEFAULTS.w,
    step: 0.01,
  },
  opacity: { min: 0, max: 1, neutral: OVERLAY_DEFAULTS.opacity, step: 0.05 },
};

export const OVERLAY_KEYS = ["x", "y", "w", "opacity"] as const;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function clampKey(key: OverlayKey, v: number): number {
  const r = OVERLAY_RANGES[key];
  return round3(clamp(Number.isFinite(v) ? v : r.neutral, r.min, r.max));
}

export function overlaysOf(model: EditorModel): PictureOverlay[] {
  return model.overlays ?? [];
}

export function overlayById(
  model: EditorModel,
  id: string,
): PictureOverlay | undefined {
  return overlaysOf(model).find((o) => o.id === id);
}

export function overlayLength(o: Pick<PictureOverlay, "start_s" | "end_s">) {
  return ms(ms(o.end_s) - ms(o.start_s));
}

/** Can one more overlay of this kind be added? Videos are fewer than pictures
 *  (each keeps a decoder open for its whole span): `isVideoAsset` says which
 *  of the model's overlays are videos (the model holds ids, not kinds); without
 *  it only the total is checked here, and the export enforces the rest. */
export function canAddOverlay(
  model: EditorModel,
  kind: EditorAsset["kind"] = "image",
  isVideoAsset?: (assetId: string) => boolean,
): boolean {
  const list = overlaysOf(model);
  // Drawn shapes take layers of the same final pass (modules/timeline.py: together at most MAX_OVERLAYS).
  if (kind === "audio" || list.length + (model.shapes?.length ?? 0) >= MAX_OVERLAYS)
    return false;
  if (kind !== "video" || !isVideoAsset) return true;
  return (
    list.filter((o) => isVideoAsset(o.asset_id)).length < MAX_OVERLAY_VIDEOS
  );
}

/**
 * A new overlay of a library picture or video at timeline time `at` (the
 * playhead): in the middle of the frame, about a third of its width, opaque,
 * for OVERLAY_DEFAULT_S seconds — shorter where the picture ends sooner, and
 * for a video no longer than the video (nothing loops or freezes). null when
 * the file is a sound, a video of unknown length, or the limit is reached.
 */
export function addOverlay(
  model: EditorModel,
  asset: Pick<EditorAsset, "id" | "kind" | "durationS">,
  at: number,
  isVideoAsset?: (assetId: string) => boolean,
): { model: EditorModel; id: string } | null {
  if (!canAddOverlay(model, asset.kind, isVideoAsset)) return null;
  const isVideo = asset.kind === "video";
  if (isVideo && !(asset.durationS && asset.durationS > 0)) return null;
  const picture = pictureEndOf(model);
  const start = ms(clamp(at, 0, Math.max(0, picture - MIN_CLIP_S)));
  const room = picture - start;
  let length = room > MIN_CLIP_S ? Math.min(OVERLAY_DEFAULT_S, room) : MIN_CLIP_S;
  if (isVideo) length = Math.min(length, asset.durationS as number);
  length = Math.max(ms(length), MIN_CLIP_S);
  const id = freshId(model, "o");
  const overlay: PictureOverlay = {
    id,
    asset_id: asset.id,
    start_s: start,
    end_s: ms(start + length),
    ...OVERLAY_DEFAULTS,
  };
  return { model: { ...model, overlays: [...overlaysOf(model), overlay] }, id };
}

/**
 * Change an overlay, kept renderable (a new `start_s` alone slides the span,
 * keeping its length; give `end_s` too, or alone, to change the length): the span inside 0..MAX and at least
 * MIN_CLIP_S long (and, for a video, no longer than the video: `sourceS`),
 * x / y / w / opacity inside their ranges, to 3 decimals as the document keeps
 * them. The same model back when nothing changes (not an undo step).
 */
export function updateOverlay(
  model: EditorModel,
  id: string,
  patch: Partial<Omit<PictureOverlay, "id" | "asset_id">>,
  sourceS: number | null = null,
): EditorModel {
  const list = overlaysOf(model);
  const at = list.find((o) => o.id === id);
  if (!at) return model;
  const next: PictureOverlay = { ...at, ...patch };
  next.start_s = ms(Math.max(0, Number.isFinite(next.start_s) ? next.start_s : at.start_s));
  next.end_s = ms(
    Number.isFinite(next.end_s) ? next.end_s : at.end_s,
  );
  if (patch.end_s === undefined && patch.start_s !== undefined) {
    // Moving the start keeps the length (the span slides).
    next.end_s = ms(next.start_s + overlayLength(at));
  }
  next.end_s = ms(Math.max(next.end_s, next.start_s + MIN_CLIP_S));
  if (sourceS && sourceS > 0)
    next.end_s = ms(Math.min(next.end_s, next.start_s + sourceS));
  for (const k of OVERLAY_KEYS) next[k] = clampKey(k, next[k]);
  // A shorter overlay shortens its entrance and exit with it.
  let fitted = fitAnims(next);
  // Changing its own opacity can make its move one between two visible values; the
  // document allows only a few of those, so past that the move keeps its other ends only.
  if (
    patch.opacity !== undefined &&
    fitted.move?.to.opacity !== undefined &&
    partialOpacityMove(fitted) &&
    list.filter((o) => o.id !== id && partialOpacityMove(o)).length >= MAX_PARTIAL_OPACITY_MOVES
  ) {
    const { opacity: _gone, ...to } = fitted.move.to;
    void _gone;
    const { move: _m, ...rest } = fitted;
    void _m;
    fitted = Object.keys(to).length ? { ...rest, move: { to } } : rest;
  }
  if (JSON.stringify(fitted) === JSON.stringify(at)) return model;
  return {
    ...model,
    overlays: list.map((o) => (o.id === id ? fitted : o)),
  };
}

/** Position, size and opacity back to the document's defaults; the span and
 *  the file stay. */
export function resetOverlay(model: EditorModel, id: string): EditorModel {
  return updateOverlay(model, id, { ...OVERLAY_DEFAULTS });
}

/** Move the centre by whole steps of the position range (the arrow keys). */
export function nudgeOverlay(
  model: EditorModel,
  id: string,
  dx: number,
  dy: number,
  step: number = OVERLAY_RANGES.x.step,
): EditorModel {
  const at = overlayById(model, id);
  if (!at) return model;
  return updateOverlay(model, id, {
    x: round3(at.x + dx * step),
    y: round3(at.y + dy * step),
  });
}

export function removeOverlay(model: EditorModel, id: string): EditorModel {
  const list = overlaysOf(model);
  if (!list.some((o) => o.id === id)) return model;
  const rest = list.filter((o) => o.id !== id);
  const { overlays: _old, ...without } = model;
  void _old;
  // None left: the field goes (the document without overlays is unchanged).
  return rest.length ? { ...model, overlays: rest } : without;
}

/** Move an overlay one layer up (+1, drawn later, on top) or down (-1). */
export function moveOverlay(
  model: EditorModel,
  id: string,
  by: -1 | 1,
): EditorModel {
  const list = [...overlaysOf(model)];
  const i = list.findIndex((o) => o.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return model;
  [list[i], list[j]] = [list[j], list[i]];
  return { ...model, overlays: list };
}

/** Overlays on screen at timeline time `t`, bottom layer first. */
export function overlaysAt(model: EditorModel, t: number): PictureOverlay[] {
  return overlaysOf(model).filter((o) => t >= o.start_s && t < o.end_s);
}

/** What a person should know about an overlay: it starts after the picture
 *  ends (nothing of it is exported), runs past the end (the rest is cut),
 *  or is invisible (opacity 0 renders nothing). */
export function overlayWarnings(
  model: EditorModel,
): Record<string, "past_end" | "cut_end" | "invisible"> {
  const end = pictureEndOf(model);
  const out: Record<string, "past_end" | "cut_end" | "invisible"> = {};
  for (const o of overlaysOf(model)) {
    if (o.start_s >= end) out[o.id] = "past_end";
    else if (o.opacity <= 0) out[o.id] = "invisible";
    else if (o.end_s > end + 0.001) out[o.id] = "cut_end";
  }
  return out;
}

// ── the preview ─────────────────────────────────────────────────────────────

/** The overlay's rectangle in FRAME pixels, as the preview draws it: width is
 *  `w` of the frame, height follows the file's aspect (`aspect` = width /
 *  height of the file), the centre is (x, y) of the frame. The export differs
 *  by rounding only (even sizes, whole pixels; see the parity test). */
export function overlayRect(
  o: Pick<PictureOverlay, "x" | "y" | "w">,
  frame: { width: number; height: number },
  aspect: number,
): { left: number; top: number; width: number; height: number } {
  const width = o.w * frame.width;
  const height = aspect > 0 ? width / aspect : 0;
  return {
    left: o.x * frame.width - width / 2,
    top: o.y * frame.height - height / 2,
    width,
    height,
  };
}

/** The box of an overlay in the preview: absolutely positioned in the
 *  preview box, in percent of it (so it is resolution independent and the
 *  same fractions the document holds), centred on (x, y), `w` of the box's
 *  width, height from the content's own aspect. The parent clips what leaves
 *  the frame, as the export does. */
export function overlayBoxStyle(
  o: Pick<PictureOverlay, "x" | "y" | "w">,
): CSSProperties {
  return {
    position: "absolute",
    left: `${round3(o.x * 100)}%`,
    top: `${round3(o.y * 100)}%`,
    width: `${round3(o.w * 100)}%`,
    height: "auto",
    transform: "translate(-50%, -50%)",
  };
}

/** The same box with the overlay's opacity, for an element that carries both
 *  (it ignores the pointer: the selection frame is what takes input). */
export function overlayPreviewStyle(
  o: Pick<PictureOverlay, "x" | "y" | "w" | "opacity">,
): CSSProperties {
  return { ...overlayBoxStyle(o), opacity: o.opacity, pointerEvents: "none" };
}
