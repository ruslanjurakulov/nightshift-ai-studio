/**
 * Undo / redo.
 * What would break without these: a slider drag that takes forty undo clicks, an undo that cannot be redone, a redo
 * branch that survives a new edit, a history that grows without end, or an undo that goes past the first state.
 */
import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, canRedo, canUndo, createHistory, push, redo, seal, undo } from "../lib/imageEditor/history";

describe("history", () => {
  it("starts empty: nothing to undo or redo", () => {
    const h = createHistory(0);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it("undoes and redoes step by step, back to exactly the same value", () => {
    let h = createHistory(0);
    h = push(h, 1);
    h = push(h, 2);
    h = push(h, 3);
    expect(h.present).toBe(3);
    h = undo(undo(h));
    expect(h.present).toBe(1);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present).toBe(2);
    h = redo(h);
    expect(h.present).toBe(3);
    expect(canRedo(h)).toBe(false);
    h = undo(undo(undo(undo(h))));
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);
  });

  it("a new edit after an undo drops the redo branch", () => {
    let h = push(push(createHistory(0), 1), 2);
    h = undo(h);
    h = push(h, 9);
    expect(canRedo(h)).toBe(false);
    expect(undo(h).present).toBe(1);
  });

  it("pushing the very same state is not a step", () => {
    const s = { a: 1 };
    const h = push(createHistory(s), s);
    expect(canUndo(h)).toBe(false);
  });

  it("a drag with one key is ONE step; another key, an undo or a seal starts a new one", () => {
    let h = createHistory(0);
    for (let v = 1; v <= 40; v += 1) h = push(h, v, "brightness");
    expect(h.present).toBe(40);
    expect(h.past).toEqual([0]);
    h = push(h, 50, "contrast");
    expect(h.past).toEqual([0, 40]);
    h = seal(h);
    h = push(h, 51, "contrast");
    expect(h.past).toEqual([0, 40, 50]);
    h = undo(h);
    h = push(h, 52, "contrast");
    expect(h.past).toEqual([0, 40, 50]);
    expect(undo(undo(undo(h))).present).toBe(0);
  });

  it("a coalesced edit still clears the redo branch", () => {
    let h = push(push(createHistory(0), 1, "k"), 2, "j");
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = push(h, 3, "k");
    h = push(h, 4, "k");
    expect(canRedo(h)).toBe(false);
  });

  it("keeps at most HISTORY_LIMIT steps, dropping only the oldest and only when it must", () => {
    const fill = (n: number) => {
      let h = createHistory(0);
      for (let v = 1; v <= n; v += 1) h = push(h, v);
      return h;
    };
    const oldest = (h: ReturnType<typeof fill>) => {
      let back = h;
      while (canUndo(back)) back = undo(back);
      return back.present;
    };
    expect(fill(HISTORY_LIMIT).past).toHaveLength(HISTORY_LIMIT);
    expect(oldest(fill(HISTORY_LIMIT))).toBe(0);
    expect(fill(HISTORY_LIMIT + 1).past).toHaveLength(HISTORY_LIMIT);
    expect(oldest(fill(HISTORY_LIMIT + 1))).toBe(1);
    expect(fill(HISTORY_LIMIT + 20).past).toHaveLength(HISTORY_LIMIT);
    expect(oldest(fill(HISTORY_LIMIT + 20))).toBe(20);
  });
});
