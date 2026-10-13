/**
 * The timeline's view maths: zoom, scroll anchoring, snapping and the
 * playhead's step. Pure (no DOM, no React) so it is tested directly; the
 * editor only wires it in (components/editor/useTimelineView.ts).
 *
 * Zoom 1 is "fit": the strip is exactly as wide as the window. Zoom 2 is twice
 * as wide, and the window scrolls over it.
 */
import {
  clipEnd,
  soundLength,
  type SoundClip,
  type TextClip,
  type VideoClip,
} from "@/lib/editor";

export const ZOOM_FIT = 1;
/** Never zoom out past "fit". */
export const ZOOM_MIN = 1;
/** Always allow at least this much zoom, however short the project is. */
export const ZOOM_FLOOR_MAX = 8;
/** An absolute ceiling, so a 4 h project cannot ask for a million-pixel strip. */
export const ZOOM_CEIL = 64;
/** Frame-level work needs about this many pixels per second at the most. */
export const MAX_PX_PER_S = 480;
/** One button press or one `+` / `-` key. */
export const ZOOM_STEP = 1.5;
/** How close (screen pixels) an edge has to come to a target to snap to it. */
export const SNAP_PX = 8;
/** The same on a touch screen, where a finger is less exact. */
export const SNAP_PX_TOUCH = 12;
/** The playhead's big step (Shift + arrow), in seconds. */
export const NUDGE_BIG_S = 1;

const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);

/** The most a project of `total` seconds may zoom in in a window `viewportPx` wide. */
export function maxZoom(total: number, viewportPx: number): number {
  if (!(total > 0) || !(viewportPx > 0)) return ZOOM_FLOOR_MAX;
  const byDetail = (MAX_PX_PER_S * total) / viewportPx;
  return Math.min(ZOOM_CEIL, Math.max(ZOOM_FLOOR_MAX, byDetail));
}

export function clampZoom(z: number, max: number = ZOOM_CEIL): number {
  const top = Math.max(ZOOM_MIN, max);
  return Math.min(top, Math.max(ZOOM_MIN, finite(z, ZOOM_FIT)));
}

/** One button / key step in (+1) or out (-1); lands exactly on "fit" when it gets close. */
export function stepZoom(z: number, dir: 1 | -1, max: number = ZOOM_CEIL): number {
  const next = dir > 0 ? z * ZOOM_STEP : z / ZOOM_STEP;
  const c = clampZoom(next, max);
  return c < 1.05 ? ZOOM_FIT : c;
}

/** Ctrl / Cmd + wheel: scrolling up (negative deltaY) zooms in, smoothly. */
export function wheelZoom(
  z: number,
  deltaY: number,
  deltaMode: number,
  max: number = ZOOM_CEIL,
): number {
  // deltaMode 1 = lines, 2 = pages; a trackpad pinch arrives as small pixel deltas.
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const limited = Math.max(-240, Math.min(240, finite(px, 0)));
  const c = clampZoom(z * Math.exp(-limited * 0.0045), max);
  return c < 1.02 ? ZOOM_FIT : c;
}

/** The strip's width for a window `viewportPx` wide at `zoom`. */
export function contentWidth(viewportPx: number, zoom: number): number {
  return Math.max(0, viewportPx) * clampZoom(zoom);
}

/**
 * The scrollLeft that keeps the point under `anchorX` (pixels from the left of
 * the window) where it was when the strip's width changes. Not clamped to the
 * scrollable range (the browser clamps); never negative.
 */
export function anchoredScrollLeft(p: {
  scrollLeft: number;
  anchorX: number;
  prevWidth: number;
  nextWidth: number;
}): number {
  if (!(p.prevWidth > 0)) return 0;
  const frac = (p.scrollLeft + p.anchorX) / p.prevWidth;
  return Math.max(0, frac * p.nextWidth - p.anchorX);
}

/**
 * The scrollLeft that brings the content pixel `x` into the window, keeping a
 * margin; the same scrollLeft when it is already visible (a user scrolling by
 * hand is never fought).
 */
export function scrollToReveal(p: {
  scrollLeft: number;
  viewportPx: number;
  contentPx: number;
  x: number;
  margin?: number;
}): number {
  const margin = Math.min(p.margin ?? 24, p.viewportPx / 4);
  const maxLeft = Math.max(0, p.contentPx - p.viewportPx);
  if (p.x >= p.scrollLeft + margin && p.x <= p.scrollLeft + p.viewportPx - margin)
    return Math.min(p.scrollLeft, maxLeft);
  const target = p.x < p.scrollLeft + margin ? p.x - margin : p.x - p.viewportPx + margin;
  return Math.min(maxLeft, Math.max(0, target));
}

// ── playhead step ───────────────────────────────────────────────────────────

/** The playhead one step left (-1) or right (+1): a frame, or with `big` a second, on the frame grid, inside 0..total. */
export function nudgePlayhead(p: {
  playhead: number;
  dir: 1 | -1;
  fps: number;
  total: number;
  big?: boolean;
}): number {
  const fps = p.fps > 0 ? p.fps : 30;
  const step = p.big ? NUDGE_BIG_S : 1 / fps;
  const frames = Math.round((p.playhead + p.dir * step) * fps);
  const next = frames / fps;
  return Math.min(Math.max(0, p.total), Math.max(0, Math.round(next * 1000) / 1000));
}

// ── snapping ────────────────────────────────────────────────────────────────

export interface SnapSources {
  clips: readonly VideoClip[];
  texts: readonly TextClip[];
  sounds: readonly SoundClip[];
  playhead: number;
  /** The moving clip: clips after it ripple with it, so their edges are no fixed target. */
  skipClipsAfter?: string;
}

/**
 * The times an edge may snap to: 0, the playhead, the edges of the clips (not
 * the ones that will move with a trim), of the texts and of the sounds.
 * Sorted and without near-duplicates.
 */
export function snapTargets(s: SnapSources): number[] {
  const out: number[] = [0, s.playhead];
  let after = false;
  for (const c of s.clips) {
    if (!after) {
      out.push(c.start_s, clipEnd(c));
    }
    if (s.skipClipsAfter && c.id === s.skipClipsAfter) after = true;
  }
  for (const x of s.texts) out.push(x.start_s, x.end_s);
  for (const x of s.sounds) out.push(x.start_s, x.start_s + soundLength(x));
  const sorted = out.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  return sorted.filter((n, i) => i === 0 || n - sorted[i - 1] > 1e-4);
}

/** Snap `t` to the nearest target within `thresholdS`; `snappedTo` is null when it stays free. */
export function snapTime(
  t: number,
  targets: readonly number[],
  thresholdS: number,
): { time: number; snappedTo: number | null } {
  let best: number | null = null;
  let bestD = Infinity;
  for (const x of targets) {
    const d = Math.abs(x - t);
    if (d < bestD) {
      bestD = d;
      best = x;
    }
  }
  if (best !== null && bestD <= thresholdS) return { time: best, snappedTo: best };
  return { time: t, snappedTo: null };
}

/** The snap distance in seconds for a strip that shows `pxPerS` pixels per second. */
export function snapThresholdS(pxPerS: number, touch = false): number {
  if (!(pxPerS > 0)) return 0;
  return (touch ? SNAP_PX_TOUCH : SNAP_PX) / pxPerS;
}

/**
 * A trim drag. The pointer is at `baseTime + dx / pxPerS` on the timeline
 * (baseTime: the clip's end for the out handle, its start for the in handle);
 * with snapping on, that time snaps to a target and the source value follows:
 * `v0 + (time - baseTime) * speed`. Returns the unrounded source value and the
 * time it snapped to (for the guide line), or null.
 */
export function snapTrimValue(p: {
  v0: number;
  speed: number;
  baseTime: number;
  dx: number;
  pxPerS: number;
  targets: readonly number[];
  snap: boolean;
  touch?: boolean;
}): { value: number; snappedTo: number | null } {
  const speed = p.speed > 0 ? p.speed : 1;
  const raw = p.baseTime + p.dx / p.pxPerS;
  if (!p.snap || !(p.pxPerS > 0)) return { value: p.v0 + (raw - p.baseTime) * speed, snappedTo: null };
  const s = snapTime(raw, p.targets, snapThresholdS(p.pxPerS, p.touch));
  return { value: p.v0 + (s.time - p.baseTime) * speed, snappedTo: s.snappedTo };
}

/**
 * The playhead dragged to `t`: it snaps to a clip edge, a text or sound edge.
 * Only for a pointer drag; a key press steps frame by frame and must never
 * stick to an edge.
 */
export function snapPlayhead(
  t: number,
  s: Omit<SnapSources, "playhead" | "skipClipsAfter">,
  pxPerS: number,
  snap: boolean,
  touch = false,
): number {
  if (!snap) return t;
  const targets = snapTargets({ ...s, playhead: 0 });
  return snapTime(t, targets, snapThresholdS(pxPerS, touch)).time;
}
