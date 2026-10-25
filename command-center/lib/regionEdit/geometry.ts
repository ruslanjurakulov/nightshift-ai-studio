/**
 * The region editor's geometry, independent of any canvas library so it is unit-tested without a DOM.
 *
 * Everything is in the picture's OWN pixels (after the browser applies EXIF orientation, which is also the grid
 * modules/region_edit.py works on). The canvas only draws what this decides: a rectangle can never leave the picture,
 * never be smaller than MIN_REGION_PX, and there are never more than MAX_REGIONS of them. The server checks all of it
 * again and REFUSES (never clamps) what is out of bounds.
 */

/** modules/region_edit.py MAX_REGIONS / MIN_REGION_PX / FEATHER_*: kept equal by tests/region-edit-parity.test.ts. */
export const MAX_REGIONS = 5;
export const MIN_REGION_PX = 16;
export const FEATHER_MIN = 2;
export const FEATHER_MAX = 8;
export const DEFAULT_FEATHER = 4;
export const NAME_MAX = 60;
export const PROMPT_MAX = 1000;

export interface Size {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface EditorRegion extends Rect {
  id: string;
  name: string;
  prompt: string;
}
/** What goes over the wire for one region (no editor-only id). */
export interface WireRegion extends Rect {
  name: string;
  prompt: string;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** One line of plain text, trimmed and cut; the server cleans it the same way. */
export function cleanLine(text: unknown, max: number): string {
  return String(text ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const whole = (n: number): number => (Number.isFinite(n) ? Math.round(n) : 0);

/**
 * A rectangle forced into the picture: whole pixels, at least `min` on each side (but never more than the picture),
 * and fully inside. Size is settled first, then the position, so a rectangle dragged past an edge stops at it
 * instead of shrinking.
 */
export function clampRect(r: Rect, bounds: Size, min: number = MIN_REGION_PX): Rect {
  const minW = Math.min(min, bounds.width);
  const minH = Math.min(min, bounds.height);
  const w = Math.max(minW, Math.min(whole(r.w), bounds.width));
  const h = Math.max(minH, Math.min(whole(r.h), bounds.height));
  const x = Math.max(0, Math.min(whole(r.x), bounds.width - w));
  const y = Math.max(0, Math.min(whole(r.y), bounds.height - h));
  return { x, y, w, h };
}

export function clampPoint(p: Point, bounds: Size): Point {
  return { x: Math.max(0, Math.min(p.x, bounds.width)), y: Math.max(0, Math.min(p.y, bounds.height)) };
}

/** The rectangle between two corners, in any drag direction, inside the picture and at least MIN_REGION_PX. */
export function rectFromCorners(a: Point, b: Point, bounds: Size): Rect {
  const p = clampPoint(a, bounds);
  const q = clampPoint(b, bounds);
  return clampRect({ x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(p.x - q.x), h: Math.abs(p.y - q.y) }, bounds);
}

/** A starting rectangle (a fifth of the shorter side, at least the minimum) centred on a point. */
export function defaultRect(center: Point, bounds: Size): Rect {
  const side = Math.max(MIN_REGION_PX, Math.round(Math.min(bounds.width, bounds.height) / 5));
  return clampRect({ x: center.x - side / 2, y: center.y - side / 2, w: side, h: side }, bounds);
}

export function moveRect(r: Rect, dx: number, dy: number, bounds: Size): Rect {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy }, bounds);
}

/** Grow or shrink from the top-left corner (the keyboard's resize): the position holds unless the picture's edge stops it. */
export function resizeBy(r: Rect, dw: number, dh: number, bounds: Size): Rect {
  return clampRect({ ...r, w: r.w + dw, h: r.h + dh }, bounds);
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Drag one handle by (dx, dy): the opposite edges stay put; the result stays inside the picture and at least the minimum. */
export function resizeFromHandle(r: Rect, handle: Handle, dx: number, dy: number, bounds: Size): Rect {
  let left = r.x;
  let top = r.y;
  let right = r.x + r.w;
  let bottom = r.y + r.h;
  if (handle.includes("w")) left = Math.min(left + dx, right - MIN_REGION_PX);
  if (handle.includes("e")) right = Math.max(right + dx, left + MIN_REGION_PX);
  if (handle.includes("n")) top = Math.min(top + dy, bottom - MIN_REGION_PX);
  if (handle.includes("s")) bottom = Math.max(bottom + dy, top + MIN_REGION_PX);
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(bounds.width, right);
  bottom = Math.min(bounds.height, bottom);
  return clampRect({ x: left, y: top, w: right - left, h: bottom - top }, bounds);
}

/** Keyboard step: one pixel, ten with Shift. */
export const nudgeStep = (shift: boolean): number => (shift ? 10 : 1);

// ── the view: picture pixels <-> canvas pixels ─────────────────────────────────

export interface View {
  scale: number;
  ox: number;
  oy: number;
}

/** The picture fitted (never enlarged past its own size) and centred in a viewport. */
export function fitView(image: Size, viewport: Size): View {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return { scale: 1, ox: 0, oy: 0 };
  const scale = Math.min(1, viewport.width / image.width, viewport.height / image.height);
  return { scale, ox: (viewport.width - image.width * scale) / 2, oy: (viewport.height - image.height * scale) / 2 };
}

/** A canvas point as a picture point, held inside the picture. */
export function toImagePoint(p: Point, view: View, bounds: Size): Point {
  return clampPoint({ x: (p.x - view.ox) / view.scale, y: (p.y - view.oy) / view.scale }, bounds);
}

export function toCanvasRect(r: Rect, view: View): Rect {
  return { x: r.x * view.scale + view.ox, y: r.y * view.scale + view.oy, w: r.w * view.scale, h: r.h * view.scale };
}

export function toImageRect(r: Rect, view: View, bounds: Size): Rect {
  return clampRect({ x: (r.x - view.ox) / view.scale, y: (r.y - view.oy) / view.scale, w: r.w / view.scale, h: r.h / view.scale }, bounds);
}

// ── the list of regions ────────────────────────────────────────────────────────

export type AddResult = { ok: true; regions: EditorRegion[]; added: EditorRegion } | { ok: false; error: "region_limit" };

/** Adds a region unless there are already MAX_REGIONS. The rectangle is forced into the picture. */
export function addRegion(list: readonly EditorRegion[], rect: Rect, meta: { id: string; name: string }, bounds: Size): AddResult {
  if (list.length >= MAX_REGIONS) return { ok: false, error: "region_limit" };
  const added: EditorRegion = { ...clampRect(rect, bounds), id: meta.id, name: cleanLine(meta.name, NAME_MAX), prompt: "" };
  return { ok: true, regions: [...list, added], added };
}

export function removeRegion(list: readonly EditorRegion[], id: string): EditorRegion[] {
  return list.filter((r) => r.id !== id);
}

/** Replace one region's fields; a rectangle is re-clamped, text is cleaned. Unknown ids change nothing. */
export function updateRegion(list: readonly EditorRegion[], id: string, patch: Partial<Omit<EditorRegion, "id">>, bounds: Size): EditorRegion[] {
  return list.map((r) => {
    if (r.id !== id) return r;
    const rect = clampRect({ x: patch.x ?? r.x, y: patch.y ?? r.y, w: patch.w ?? r.w, h: patch.h ?? r.h }, bounds);
    return {
      ...r,
      ...rect,
      name: patch.name === undefined ? r.name : cleanLine(patch.name, NAME_MAX),
      prompt: patch.prompt === undefined ? r.prompt : String(patch.prompt).replace(CONTROL, " ").slice(0, PROMPT_MAX),
    };
  });
}

/** The regions that have words: only these are run, priced and charged. */
export function runnableRegions(list: readonly EditorRegion[]): EditorRegion[] {
  return list.filter((r) => cleanLine(r.prompt, PROMPT_MAX) !== "");
}

/** The next free "Region N" number (never reuses the number of a region still in the list). */
export function nextRegionNumber(list: readonly EditorRegion[], pattern: RegExp = /(\d+)\s*$/): number {
  const used = new Set(list.map((r) => Number(pattern.exec(r.name)?.[1])).filter((n) => Number.isInteger(n)));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

export function toWire(list: readonly EditorRegion[]): WireRegion[] {
  return list.map((r) => ({ name: cleanLine(r.name, NAME_MAX), prompt: cleanLine(r.prompt, PROMPT_MAX), x: r.x, y: r.y, w: r.w, h: r.h }));
}

export function isFeather(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= FEATHER_MIN && n <= FEATHER_MAX;
}
