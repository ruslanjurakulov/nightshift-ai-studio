/**
 * Undo / redo as a plain immutable stack of whole states. A state is small (a few numbers and at most MAX_LAYERS
 * layers), so snapshots are simpler and safer than inverse operations.
 *
 * A slider drag produces dozens of states; `push(h, next, key)` with the SAME key as the previous push replaces the
 * present instead of stacking, so one drag is one undo step. Undo, redo and `seal` end the group.
 */
export const HISTORY_LIMIT = 100;

export interface History<T> {
  past: readonly T[];
  present: T;
  future: readonly T[];
  /** Key of the group the last push belongs to, or null. */
  key: string | null;
}

export function createHistory<T>(initial: T): History<T> {
  return { past: [], present: initial, future: [], key: null };
}

export function push<T>(h: History<T>, next: T, key: string | null = null): History<T> {
  if (Object.is(next, h.present)) return h;
  if (key !== null && h.key === key) return { ...h, present: next, future: [] };
  const past = [...h.past, h.present];
  return { past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past, present: next, future: [], key };
}

/** The next push starts a new step even if it carries the same key (a drag ended). */
export const seal = <T>(h: History<T>): History<T> => (h.key === null ? h : { ...h, key: null });

export const canUndo = <T>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T>(h: History<T>): boolean => h.future.length > 0;

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], key: null };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), key: null };
}
