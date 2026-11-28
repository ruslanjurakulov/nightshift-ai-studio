// @vitest-environment jsdom
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { BRAIN_ACTIVITY_EVENT, dispatchBrainCanvas, isBrainActivity, type BrainActivity } from "@/lib/brain/canvas-events";

/**
 * The canvas contract on nightshift:brain-activity (Atlas, 28 Nov): session_id is null only for "thinking" on a conversation's first
 * send. What breaks if these fail: S3's board treating "" or a null session as a real conversation, or drawing a storyboard for nobody.
 */

describe("BrainActivity type", () => {
  it("allows null only with thinking", () => {
    expectTypeOf<{ session_id: null; phase: "thinking" }>().toMatchTypeOf<BrainActivity>();
    expectTypeOf<{ session_id: "s1"; phase: "planning" }>().toMatchTypeOf<BrainActivity>();
    // @ts-expect-error a null session cannot be planning
    const bad: BrainActivity = { session_id: null, phase: "planning" };
    // @ts-expect-error a null session carries no plan
    const bad2: BrainActivity = { session_id: null, phase: "thinking", plan: { windows: 1, of: 2, chapters_written: 0, chapters: 2 } };
    void bad; void bad2;
  });
});

describe("isBrainActivity: the runtime guard", () => {
  it.each(["planning", "saving", "pricing", "end"])("refuses a null session on %s", (phase) => {
    expect(isBrainActivity({ session_id: null, phase })).toBe(false);
  });
  it("accepts null on thinking, refuses it with a plan", () => {
    expect(isBrainActivity({ session_id: null, phase: "thinking" })).toBe(true);
    expect(isBrainActivity({ session_id: null, phase: "thinking", plan: { windows: 0, of: 1, chapters_written: 0, chapters: 1 } })).toBe(false);
  });
  it('refuses "" (no sentinel), a missing id, a number and an unknown phase', () => {
    expect(isBrainActivity({ session_id: "", phase: "thinking" })).toBe(false);
    expect(isBrainActivity({ phase: "thinking" })).toBe(false);
    expect(isBrainActivity({ session_id: 7, phase: "thinking" })).toBe(false);
    expect(isBrainActivity({ session_id: "s1", phase: "typing" })).toBe(false);
  });
  it("accepts a real session on every phase", () => {
    for (const phase of ["thinking", "planning", "saving", "pricing", "end"]) expect(isBrainActivity({ session_id: "s1", phase })).toBe(true);
  });
});

describe("dispatchBrainCanvas", () => {
  afterEach(() => vi.restoreAllMocks());
  it("never sends an activity that breaks the contract", () => {
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(BRAIN_ACTIVITY_EVENT, on);
    expect(dispatchBrainCanvas({ kind: "activity", detail: { session_id: null, phase: "planning" } as unknown as BrainActivity })).toBe(false);
    expect(dispatchBrainCanvas({ kind: "activity", detail: { session_id: "", phase: "end" } })).toBe(false);
    expect(dispatchBrainCanvas({ kind: "activity", detail: { session_id: null, phase: "thinking" } })).toBe(true);
    expect(dispatchBrainCanvas({ kind: "activity", detail: { session_id: "s1", phase: "end" } })).toBe(true);
    window.removeEventListener(BRAIN_ACTIVITY_EVENT, on);
    expect(seen).toEqual([{ session_id: null, phase: "thinking" }, { session_id: "s1", phase: "end" }]);
  });
});
