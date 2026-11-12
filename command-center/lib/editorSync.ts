/**
 * Sync lock: a ripple edit of the picture lane (a clip removed, a trim, a ripple delete or extract, a silence cut,
 * an insert or paste, a gap closed) moves the texts, sounds, overlays and shapes that come after the edit point by
 * the same amount, so a title stays on the shot it was made for and a sound effect on its hit. Each of those four
 * lanes can be LOCKED (Premiere's sync lock switched off for that track): a locked lane keeps its times.
 *
 * Nothing new reaches the document. The shift is worked out from the picture lane itself, before and after the edit
 * (`rippleOf`), so every ripple operation gets the same rule without knowing about it, and an edit that keeps the
 * picture's timing (a split, a roll, a slip, a slide, a lift, an effect) moves nothing.
 *
 * The rule (docs/editor-render-fields.md §18), in OLD timeline seconds, for a ripple between `from` and `to` that
 * moves everything after `to` by `by`:
 *
 *  1. an item that starts at or after `to` moves by `by`, keeping its length;
 *  2. an item that starts over a clip that was trimmed (the same clip is still there) follows the frame it was on:
 *     a head trim moves it up with the rest of that clip. When its frame was trimmed away it goes to that clip's
 *     new edge (its start for a head trim, its end for a tail trim);
 *  3. an item that starts inside a part that was taken out (a clip removed, a gap closed, a range extracted) goes
 *     to the cut, keeping its length. Items are never deleted, never trimmed, never put before the edit point and
 *     so never before 0;
 *  4. an item that starts before the edit point never moves, even when it runs across it (its length is kept, so it
 *     may now run further over the picture: nothing is cut out of a text);
 *  5. a moved item may share time with another: every text and every sound is its own track in the document and
 *     overlays and shapes are layers, so there is nothing to collide with; nothing is merged or dropped.
 *
 * Captions and the tracks the editor does not edit keep their times (captions are timed from the transcript's
 * words; the captions panel lays them out again), and so does every item on a locked lane.
 */
import { clipEnd, clipLength, layout, ms, type EditorModel, type VideoClip } from "@/lib/editor";
import { extractRange, insertAt, type RangeProblem } from "@/lib/editorRange";

/** The lanes that follow ripple edits, each with its own lock. */
export const SYNC_LANES = ["texts", "sounds", "overlays", "shapes"] as const;
export type SyncLane = (typeof SYNC_LANES)[number];
/** true = the lane is LOCKED: it keeps its times. */
export type SyncLocks = Record<SyncLane, boolean>;

/** The default, as in Premiere (sync lock on for every track) and CapCut (items follow the main track): nothing is
 *  locked, every lane follows. */
export const NO_LOCKS: SyncLocks = { texts: false, sounds: false, overlays: false, shapes: false };
/** Every lane locked: the editor before sync lock (texts, sounds, overlays and shapes kept their times). */
export const ALL_LOCKED: SyncLocks = { texts: true, sounds: true, overlays: true, shapes: true };

/** One ripple of the picture lane: what was at or after `to` (old timeline seconds) is now `by` seconds later. */
export interface Ripple {
  /** Where the change on the picture lane begins (nothing before it moved). */
  from: number;
  /** Where the unchanged rest of the picture began. */
  to: number;
  by: number;
  /** The clips in the changed part that are still there (trimmed): old span and source in, new span and source in. */
  kept: { s0: number; e0: number; in0: number; s1: number; e1: number; in1: number; speed: number }[];
}

const near = (a: number, b: number, eps = 0.0006) => Math.abs(a - b) <= eps;
const pictureEnd = (clips: readonly VideoClip[]) => clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0);

/**
 * The ripple a picture-lane edit made, from the lane before and after it, or null when nothing after the edit moved.
 * The clips at the start that kept their place and length are the part before the edit; the clips at the end that
 * kept their length and all moved by the same amount are the part after it.
 */
export function rippleOf(before: EditorModel, after: EditorModel): Ripple | null {
  if (before.clips === after.clips) return null;
  const a = layout(before.clips);
  const b = layout(after.clips);
  let head = 0;
  while (
    head < a.length &&
    head < b.length &&
    a[head].id === b[head].id &&
    near(a[head].start_s, b[head].start_s) &&
    near(clipLength(a[head]), clipLength(b[head]))
  )
    head += 1;
  if (head === a.length && head === b.length) return null;
  let tail = 0;
  let by: number | null = null;
  while (tail < a.length - head && tail < b.length - head) {
    const x = a[a.length - 1 - tail];
    const y = b[b.length - 1 - tail];
    if (x.id !== y.id || !near(clipLength(x), clipLength(y))) break;
    const d = y.start_s - x.start_s;
    if (by !== null && !near(d, by)) break;
    by = d;
    tail += 1;
  }
  const from = head > 0 ? clipEnd(a[head - 1]) : 0;
  // A clip of the changed part that is still there, at one speed and forwards, is followed frame by frame.
  const newer = new Map(b.slice(head, b.length - tail).map((c) => [c.id, c]));
  const kept = a.slice(head, a.length - tail).flatMap((x) => {
    const y = newer.get(x.id);
    const plain = (c: VideoClip) => !c.speed_curve && !c.reverse && !c.freeze && c.speed > 0;
    if (!y || y.asset_id !== x.asset_id || !plain(x) || !plain(y) || !near(x.speed, y.speed, 1e-9)) return [];
    return [{ s0: x.start_s, e0: clipEnd(x), in0: x.in_s, s1: y.start_s, e1: clipEnd(y), in1: y.in_s, speed: x.speed }];
  });
  if (tail > 0 && by !== null) {
    const first = a[a.length - tail];
    // The rest began where its first clip began (a gap before it is part of the changed place, as a lift leaves it).
    const to = Math.max(from, first.start_s);
    return near(by, 0) ? null : { from, to, by: ms(by), kept };
  }
  // The edit reached the end of the picture: what was after it (texts past the end) moves with the end.
  const by2 = ms(pictureEnd(b) - pictureEnd(a));
  return near(by2, 0) ? null : { from, to: Math.max(from, pictureEnd(a)), by: by2, kept };
}

/** Where an item that started at `s` starts after the ripple (rules 1-4 above). */
export function shiftedStart(s: number, r: Ripple): number {
  if (s < r.from - 1e-9) return s;
  if (s >= r.to - 1e-9) return ms(Math.max(0, s + r.by));
  // over a clip that is still there: the same frame of it, held to the clip's new span
  const k = r.kept.find((c) => s >= c.s0 - 1e-9 && s < c.e0 - 1e-9);
  if (k) {
    const t = k.s1 + (k.in0 + (s - k.s0) * k.speed - k.in1) / k.speed;
    return ms(Math.min(Math.max(t, k.s1), k.e1));
  }
  // inside a part that was taken out: at the cut (where the changed part now ends, when it got shorter)
  return r.by < 0 ? ms(Math.max(r.from, Math.min(s, r.to + r.by))) : s;
}

/** The model's texts, sounds, overlays and shapes moved by ripple `r`, the locked lanes (and `skip`) left alone. */
export function applyRipple(model: EditorModel, r: Ripple, locks: SyncLocks, skip: readonly SyncLane[] = []): EditorModel {
  const on = (l: SyncLane) => !locks[l] && !skip.includes(l);
  let changed = false;
  const span = <T extends { start_s: number; end_s: number }>(x: T): T => {
    const s = shiftedStart(x.start_s, r);
    if (near(s, x.start_s, 1e-9)) return x;
    changed = true;
    return { ...x, start_s: s, end_s: ms(s + (ms(x.end_s) - ms(x.start_s))) };
  };
  const next: EditorModel = { ...model };
  if (on("texts")) next.texts = model.texts.map(span);
  if (on("overlays") && model.overlays) next.overlays = model.overlays.map(span);
  if (on("shapes") && model.shapes) next.shapes = model.shapes.map(span);
  if (on("sounds"))
    next.sounds = model.sounds.map((x) => {
      const s = shiftedStart(x.start_s, r);
      if (near(s, x.start_s, 1e-9)) return x;
      changed = true;
      return { ...x, start_s: s };
    });
  return changed ? next : model;
}

/**
 * `after` (a ripple edit of `before`'s picture lane) with the lanes that follow it moved in step. The same model
 * back when the edit moved nothing after it, or every lane is locked.
 */
export function syncLock(before: EditorModel, after: EditorModel, locks: SyncLocks, skip: readonly SyncLane[] = []): EditorModel {
  const r = rippleOf(before, after);
  return r ? applyRipple(after, r, locks, skip) : after;
}

/**
 * Ripple delete of a marked range with sync lock: the range [from, to] it was really taken at is the ripple (a
 * split at a mark gives the clip after it a new id, so the lanes cannot tell it). The sounds are cut by the range
 * itself when their lane follows (`extractRange`), and are not touched when it is locked.
 */
export function extractInSync(
  model: EditorModel,
  from: number,
  to: number,
  locks: SyncLocks,
): { model: EditorModel; removed: number; from: number; to: number } | { problem: RangeProblem } {
  const out = extractRange(model, from, to, { sounds: !locks.sounds });
  if ("problem" in out) return out;
  const r: Ripple = { from: out.from, to: out.to, by: ms(out.from - out.to), kept: [] };
  return { ...out, model: applyRipple(out.model, r, locks, ["sounds"]) };
}

/**
 * Insert a copy at the playhead with sync lock: what started at or after the place it went in moves later by its
 * length (an insert in the middle of a clip splits it, so here too the ripple is told, not read off the lanes).
 */
export function insertInSync(
  model: EditorModel,
  source: VideoClip,
  t: number,
  locks: SyncLocks,
): { model: EditorModel; id: string } | { problem: RangeProblem } {
  const out = insertAt(model, source, t);
  if ("problem" in out) return out;
  const laid = layout(out.model.clips);
  const i = laid.findIndex((c) => c.id === out.id);
  const at = laid[i].start_s;
  // What followed the copy moved as far as its first clip did (the copy's length, unless a cross-fade into that clip
  // changed); after a split that clip is the new right half, which starts where the copy ends.
  const after = laid[i + 1];
  const was = after ? layout(model.clips).find((c) => c.id === after.id) : undefined;
  const by = after && was ? after.start_s - was.start_s : clipLength(laid[i]);
  const r: Ripple = { from: at, to: at, by: ms(by), kept: [] };
  return { ...out, model: applyRipple(out.model, r, locks) };
}

// ── the locks, remembered in this browser ──────────────────────────────────

const STORE = "ns:editor:sync-locks:v1";

/** The saved locks, or none locked when there is nothing saved, it is not readable, or the browser will not say. */
export function loadLocks(): SyncLocks {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORE);
    if (!raw || raw.length > 256) return NO_LOCKS;
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return NO_LOCKS;
    const o = v as Record<string, unknown>;
    return { texts: o.texts === true, sounds: o.sounds === true, overlays: o.overlays === true, shapes: o.shapes === true };
  } catch {
    return NO_LOCKS;
  }
}

export function saveLocks(l: SyncLocks): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(l));
  } catch {
    /* a convenience only: the locks still work for this page */
  }
}
