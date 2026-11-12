/**
 * Selecting several items on the timeline, and the edits that take the whole selection at once: delete, move,
 * nudge, copy and paste (paste attributes is lib/editorPasteLook.ts). Each is one model change, so the editor makes
 * it one undo step, and each is held to the same rules as its single-item twin (`removeClip`, `moveClip`,
 * `insertClipCopy`, ...), which it is built from.
 *
 * The picture lane is magnetic, as CapCut's main track is: its clips sit end to end, so they are reordered (moved
 * one place earlier or later as a block), not nudged in time; a slide (U) moves one in time. Texts, sounds,
 * overlays and shapes are nudged by frames. The selection itself is editor state, never saved.
 */
import {
  MAX_EDITOR_TEXTS,
  canAddSound,
  clipEnd,
  freshId,
  gapOf,
  layout,
  ms,
  insertClipCopy,
  removeClip,
  soundLength,
  toDoc,
  validateTimeline,
  type EditorModel,
  type PictureOverlay,
  type SoundClip,
  type TextClip,
  type VideoClip,
} from "@/lib/editor";
import { canAddOverlay } from "@/lib/editorOverlay";
import { canAddShape, shapeBudgetProblem } from "@/lib/editorShapeModel";
import type { ShapeLayer } from "@/lib/editorShapes";
import { syncLock, NO_LOCKS, type SyncLocks } from "@/lib/editorSync";

export type ItemKind = "clip" | "text" | "sound" | "overlay" | "shape";
export interface Item {
  kind: ItemKind;
  id: string;
}

export const sameItem = (a: Item | null | undefined, b: Item | null | undefined) =>
  Boolean(a && b && a.kind === b.kind && a.id === b.id);
export const hasItem = (list: readonly Item[], x: Item) => list.some((y) => sameItem(x, y));

/** Shift- or Ctrl / Cmd-click: `x` added to the selection, or taken out of it when it is in it. */
export function toggleItem(list: readonly Item[], x: Item): Item[] {
  return hasItem(list, x) ? list.filter((y) => !sameItem(x, y)) : [...list, x];
}

/** The items of `list` the model still has (an undo or a delete can take some away), in the same order. */
export function existing(model: EditorModel, list: readonly Item[]): Item[] {
  return list.filter((x) => itemSpan(model, x) !== null);
}

/** Where item `x` is on the timeline, [start, end] in seconds, or null when the model has no such item. */
export function itemSpan(model: EditorModel, x: Item): [number, number] | null {
  if (x.kind === "clip") {
    const c = layout(model.clips).find((k) => k.id === x.id);
    return c ? [c.start_s, clipEnd(c)] : null;
  }
  if (x.kind === "sound") {
    const s = model.sounds.find((k) => k.id === x.id);
    return s ? [s.start_s, ms(s.start_s + soundLength(s))] : null;
  }
  const list: { id: string; start_s: number; end_s: number }[] =
    x.kind === "text" ? model.texts : x.kind === "overlay" ? (model.overlays ?? []) : (model.shapes ?? []);
  const it = list.find((k) => k.id === x.id);
  return it ? [it.start_s, it.end_s] : null;
}

/** Every item of every lane, picture first, in timeline order within a lane. */
export function allItems(model: EditorModel): Item[] {
  const by = <T extends { id: string; start_s: number }>(kind: ItemKind, xs: readonly T[]) =>
    [...xs].sort((a, b) => a.start_s - b.start_s).map((x) => ({ kind, id: x.id }));
  return [
    ...layout(model.clips).map((c) => ({ kind: "clip" as const, id: c.id })),
    ...by("text", model.texts),
    ...by("sound", model.sounds),
    ...by("overlay", model.overlays ?? []),
    ...by("shape", model.shapes ?? []),
  ];
}

/** Track select forward (Premiere's A tool): every item that starts at or after `t`, on every lane. */
export function selectFrom(model: EditorModel, t: number): Item[] {
  return allItems(model).filter((x) => {
    const s = itemSpan(model, x);
    return s !== null && s[0] >= t - 0.0005;
  });
}

/** A box on the strip, in its own pixels. */
export interface Box {
  item: Item;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The items a marquee from (x0, y0) to (x1, y1) touches (either corner first). A box touched by one pixel counts. */
export function marqueeHits(boxes: readonly Box[], x0: number, y0: number, x1: number, y1: number): Item[] {
  const l = Math.min(x0, x1);
  const r = Math.max(x0, x1);
  const t = Math.min(y0, y1);
  const b = Math.max(y0, y1);
  return boxes.filter((k) => k.right >= l && k.left <= r && k.bottom >= t && k.top <= b).map((k) => k.item);
}

const ids = (list: readonly Item[], kind: ItemKind) => new Set(list.filter((x) => x.kind === kind).map((x) => x.id));

/**
 * Delete every selected item in one step. Picture clips are ripple-deleted one at a time, the last first, each with
 * sync lock (`locks`), so what is after each one moves up by that clip alone. The picture keeps at least one clip
 * (as a single delete does): with every clip selected, the first stays and `keptClip` says so.
 */
export function removeItems(
  model: EditorModel,
  list: readonly Item[],
  locks: SyncLocks = NO_LOCKS,
): { model: EditorModel; removed: number; keptClip: string | null } {
  const tx = ids(list, "text");
  const sd = ids(list, "sound");
  const ov = ids(list, "overlay");
  const sh = ids(list, "shape");
  let m: EditorModel = {
    ...model,
    texts: model.texts.filter((x) => !tx.has(x.id)),
    sounds: model.sounds.filter((x) => !sd.has(x.id)),
    ...(model.overlays ? { overlays: model.overlays.filter((x) => !ov.has(x.id)) } : {}),
    ...(model.shapes ? { shapes: model.shapes.filter((x) => !sh.has(x.id)) } : {}),
  };
  let removed =
    model.texts.length - m.texts.length +
    (model.sounds.length - m.sounds.length) +
    ((model.overlays?.length ?? 0) - (m.overlays?.length ?? 0)) +
    ((model.shapes?.length ?? 0) - (m.shapes?.length ?? 0));
  const cs = ids(list, "clip");
  let keptClip: string | null = null;
  for (const c of [...layout(m.clips)].reverse()) {
    if (!cs.has(c.id)) continue;
    const next = removeClip(m, c.id);
    if (next === m) {
      keptClip = c.id;
      continue;
    }
    m = syncLock(m, next, locks);
    removed += 1;
  }
  return { model: removed ? m : model, removed, keptClip };
}

/**
 * The selected picture clips moved one place earlier (-1) or later (+1) as a block: each swaps with the unselected
 * clip beside it. A gap stays where it is on the timeline (it belongs to the place, as `moveClip` rules). The same
 * model back when the block is already at that end.
 */
export function moveClips(model: EditorModel, list: readonly Item[], by: -1 | 1): EditorModel {
  const cs = ids(list, "clip");
  const clips = layout(model.clips);
  const gaps = clips.map(gapOf);
  const order = [...clips];
  const picked = order.map((c) => cs.has(c.id));
  if (!picked.some(Boolean)) return model;
  let moved = false;
  const idx = order.map((_, i) => i);
  const seq = by < 0 ? idx : idx.reverse();
  for (const i of seq) {
    const j = i + by;
    if (!picked[i] || j < 0 || j >= order.length || picked[j]) continue;
    [order[i], order[j]] = [order[j], order[i]];
    [picked[i], picked[j]] = [picked[j], picked[i]];
    moved = true;
  }
  if (!moved) return model;
  const placed = order.map((c, k) => {
    const out = { ...c };
    delete out.gap_s;
    return gaps[k] > 0 ? { ...out, gap_s: gaps[k] } : out;
  });
  return { ...model, clips: layout(placed) };
}

/**
 * The selected texts, sounds, overlays and shapes moved `d` seconds later (earlier when negative) together, held
 * so the earliest of them does not go before 0 (the group keeps its spacing). Picture clips are left where they
 * are (the lane is magnetic). `by` is how far they really moved.
 */
export function nudgeItems(model: EditorModel, list: readonly Item[], d: number): { model: EditorModel; by: number; moved: number } {
  const tx = ids(list, "text");
  const sd = ids(list, "sound");
  const ov = ids(list, "overlay");
  const sh = ids(list, "shape");
  const starts = [
    ...model.texts.filter((x) => tx.has(x.id)),
    ...model.sounds.filter((x) => sd.has(x.id)),
    ...(model.overlays ?? []).filter((x) => ov.has(x.id)),
    ...(model.shapes ?? []).filter((x) => sh.has(x.id)),
  ].map((x) => x.start_s);
  if (!starts.length) return { model, by: 0, moved: 0 };
  const by = ms(Math.max(d, -Math.min(...starts)));
  if (Math.abs(by) < 0.0005) return { model, by: 0, moved: 0 };
  const span = <T extends { id: string; start_s: number; end_s: number }>(set: Set<string>) => (x: T): T =>
    set.has(x.id) ? { ...x, start_s: ms(x.start_s + by), end_s: ms(x.end_s + by) } : x;
  return {
    model: {
      ...model,
      texts: model.texts.map(span<TextClip>(tx)),
      sounds: model.sounds.map((x) => (sd.has(x.id) ? { ...x, start_s: ms(x.start_s + by) } : x)),
      ...(model.overlays ? { overlays: model.overlays.map(span<PictureOverlay>(ov)) } : {}),
      ...(model.shapes ? { shapes: model.shapes.map(span<ShapeLayer>(sh)) } : {}),
    },
    by,
    moved: starts.length,
  };
}

// ── copy and paste of a selection ──────────────────────────────────────────

/** What a copy of a selection holds: the picture clips in timeline order, and the other items with their start
 *  measured from the earliest of them (pasted at the playhead with the same spacing). */
export interface ItemsClipboard {
  clips: VideoClip[];
  texts: TextClip[];
  sounds: SoundClip[];
  overlays: PictureOverlay[];
  shapes: ShapeLayer[];
}
export const clipboardSize = (c: ItemsClipboard) =>
  c.clips.length + c.texts.length + c.sounds.length + c.overlays.length + c.shapes.length;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function copyItems(model: EditorModel, list: readonly Item[]): ItemsClipboard {
  const pick = <T extends { id: string }>(xs: readonly T[], kind: ItemKind) => {
    const set = ids(list, kind);
    return xs.filter((x) => set.has(x.id)).map(clone);
  };
  const out: ItemsClipboard = {
    clips: pick(layout(model.clips), "clip"),
    texts: pick(model.texts, "text"),
    sounds: pick(model.sounds, "sound"),
    overlays: pick(model.overlays ?? [], "overlay"),
    shapes: pick(model.shapes ?? [], "shape"),
  };
  const first = Math.min(
    ...[...out.texts, ...out.sounds, ...out.overlays, ...out.shapes].map((x) => x.start_s),
    Number.POSITIVE_INFINITY,
  );
  if (Number.isFinite(first)) {
    const rel = <T extends { start_s: number; end_s?: number }>(x: T): T => ({
      ...x,
      start_s: ms(x.start_s - first),
      ...(x.end_s !== undefined ? { end_s: ms(x.end_s - first) } : {}),
    });
    out.texts = out.texts.map(rel);
    out.sounds = out.sounds.map(rel);
    out.overlays = out.overlays.map(rel);
    out.shapes = out.shapes.map(rel);
  }
  for (const c of out.clips) delete c.gap_s;
  return out;
}

/**
 * Paste a copied selection in one step: its picture clips right after clip `afterId` (at the end when it is not on
 * the lane), in their order, each a ripple insert with sync lock; its other items at `at` (the playhead) with the
 * spacing they had. Each gets a fresh id. An item the project has no room for (the lane's or the mix's limit, a
 * shape the export could not afford, anything the validator would refuse) is left out and counted in `skipped`.
 */
export function pasteItems(
  model: EditorModel,
  board: ItemsClipboard,
  afterId: string | null,
  at: number,
  opts: { locks?: SyncLocks; isVideoAsset?: (assetId: string) => boolean } = {},
): { model: EditorModel; items: Item[]; skipped: number } {
  const locks = opts.locks ?? NO_LOCKS;
  let m = model;
  const items: Item[] = [];
  let skipped = 0;
  let after = afterId;
  for (const c of board.clips) {
    const out = insertClipCopy(m, c, after);
    if (!out) {
      skipped += 1;
      continue;
    }
    m = syncLock(m, out.model, locks);
    after = out.id;
    items.push({ kind: "clip", id: out.id });
  }
  const base = ms(Math.max(0, at));
  const problems = (x: EditorModel) => validateTimeline(toDoc(x)).length;
  let known = problems(m);
  const tryAdd = (next: EditorModel, item: Item) => {
    const p = problems(next);
    if (p > known) {
      skipped += 1;
      return;
    }
    known = p;
    m = next;
    items.push(item);
  };
  for (const x of board.texts) {
    if (m.texts.length >= MAX_EDITOR_TEXTS) {
      skipped += 1;
      continue;
    }
    const id = freshId(m, "x");
    tryAdd({ ...m, texts: [...m.texts, { ...clone(x), id, start_s: ms(base + x.start_s), end_s: ms(base + x.end_s) }] }, { kind: "text", id });
  }
  for (const x of board.sounds) {
    if (!canAddSound(m)) {
      skipped += 1;
      continue;
    }
    const id = freshId(m, "m");
    tryAdd({ ...m, sounds: [...m.sounds, { ...clone(x), id, start_s: ms(base + x.start_s) }] }, { kind: "sound", id });
  }
  for (const x of board.overlays) {
    const kind = opts.isVideoAsset?.(x.asset_id) ? "video" : "image";
    if (!canAddOverlay(m, kind, opts.isVideoAsset)) {
      skipped += 1;
      continue;
    }
    const id = freshId(m, "o");
    const o = { ...clone(x), id, start_s: ms(base + x.start_s), end_s: ms(base + x.end_s) };
    tryAdd({ ...m, overlays: [...(m.overlays ?? []), o] }, { kind: "overlay", id });
  }
  for (const x of board.shapes) {
    if (!canAddShape(m)) {
      skipped += 1;
      continue;
    }
    const id = freshId(m, "h");
    const next = { ...m, shapes: [...(m.shapes ?? []), { ...clone(x), id, start_s: ms(base + x.start_s), end_s: ms(base + x.end_s) }] };
    // a shape the export could not draw in time or memory is not pasted (settling would take it away again)
    if (shapeBudgetProblem(next) !== null) {
      skipped += 1;
      continue;
    }
    tryAdd(next, { kind: "shape", id });
  }
  return { model: items.length ? m : model, items, skipped };
}
