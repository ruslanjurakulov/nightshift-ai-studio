/**
 * The panel's activity event (lib/studio/brainActivity.ts, a copy of #989's lib/brain/canvas-events.ts). What would break without
 * these: S1's shape (with its real plan counts) or this PR's first shape not understood while both panels meet in merges; a
 * malformed or foreign event read as "end" or as a send; a null conversation on anything but a first send's "thinking" taken as
 * one (Atlas); a count that contradicts itself drawn as a number; and a stale "thinking" replayed to a fresh column (Lens H2).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAIN_ACTIVITY_EVENT, BRAIN_PHASES, clearBrainActivity, dispatchBrainCanvas, onBrainActivity, parseBrainActivity } from "../lib/studio/brainActivity";

const SID = "5e550000-0000-4000-8000-0000000000e1";
const plan = { windows: 1, of: 2, chapters_written: 2, chapters: 6 };

describe("parseBrainActivity", () => {
  it("takes S1's shape: each phase, and 'end'", () => {
    for (const phase of [...BRAIN_PHASES, "end"] as const) expect(parseBrainActivity({ session_id: SID, phase })).toEqual({ session_id: SID, phase });
  });
  it("keeps S1's plan counts on 'planning', and only well-formed ones", () => {
    expect(parseBrainActivity({ session_id: SID, phase: "planning", plan })).toEqual({ session_id: SID, phase: "planning", plan });
    for (const bad of [{ ...plan, chapters_written: 7 }, { ...plan, windows: 3 }, { ...plan, chapters: 0 }, { ...plan, of: 1.5 }, { ...plan, of: "2" }, [1, 2], null])
      expect(parseBrainActivity({ session_id: SID, phase: "planning", plan: bad })).toEqual({ session_id: SID, phase: "planning" });
    // Counts belong to a storyboard being written: on another phase they are not carried.
    expect(parseBrainActivity({ session_id: SID, phase: "saving", plan })).toEqual({ session_id: SID, phase: "saving" });
  });
  it("takes this PR's first words, storyboard and idle, as planning and end", () => {
    expect(parseBrainActivity({ session_id: SID, phase: "storyboard" })).toEqual({ session_id: SID, phase: "planning" });
    expect(parseBrainActivity({ session_id: SID, phase: "idle" })).toEqual({ session_id: SID, phase: "end" });
  });
  it("a null conversation is a first send's 'thinking' only; on any other phase it is dropped (Atlas)", () => {
    expect(parseBrainActivity({ session_id: null, phase: "thinking" })).toEqual({ session_id: null, phase: "thinking" });
    for (const phase of ["planning", "saving", "pricing", "end", "storyboard", "idle"]) expect(parseBrainActivity({ session_id: null, phase }), phase).toBeNull();
    // No "" sentinel: an empty id is no id.
    expect(parseBrainActivity({ session_id: "", phase: "thinking" })).toBeNull();
  });
  it("ignores anything malformed rather than guessing a phase", () => {
    for (const bad of [null, undefined, "thinking", 42, [], {}, { phase: "thinking" }, { session_id: SID }, { session_id: SID, phase: "Thinking" },
      { session_id: SID, phase: "chapter_3_of_6" }, { session_id: SID, phase: "toString" }, { session_id: "not-a-uuid", phase: "end" }, { session_id: 7, phase: "end" }])
      expect(parseBrainActivity(bad)).toBeNull();
  });
});

describe("dispatch, listen and replay", () => {
  afterEach(() => vi.unstubAllGlobals());
  const fakeWindow = () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    return target;
  };
  const act = (detail: Parameters<typeof dispatchBrainCanvas>[0] extends infer E ? (E extends { kind: "activity"; detail: infer D } ? D : never) : never) =>
    dispatchBrainCanvas({ kind: "activity", detail });
  it("a subscriber hears what the panel dispatches, and nothing after it unsubscribes", () => {
    fakeWindow();
    const seen: unknown[] = [];
    const off = onBrainActivity((a) => seen.push(a));
    act({ session_id: null, phase: "thinking" });
    act({ session_id: SID, phase: "end" });
    off();
    act({ session_id: SID, phase: "thinking" });
    expect(seen).toEqual([{ session_id: null, phase: "thinking" }, { session_id: SID, phase: "end" }]);
  });
  it("a malformed event under the same name never reaches the subscriber", () => {
    const w = fakeWindow();
    const handler = vi.fn();
    const off = onBrainActivity(handler);
    w.dispatchEvent(new CustomEvent(BRAIN_ACTIVITY_EVENT, { detail: { session_id: SID, phase: "done" } }));
    w.dispatchEvent(new CustomEvent(BRAIN_ACTIVITY_EVENT, { detail: { session_id: null, phase: "end" } }));
    w.dispatchEvent(new Event(BRAIN_ACTIVITY_EVENT));
    off();
    expect(handler).not.toHaveBeenCalled();
  });
  it("a late listener hears an in-flight storyboard first, marked replayed; never a stale send", () => {
    fakeWindow();
    act({ session_id: SID, phase: "planning", plan });
    const seen: unknown[] = [];
    onBrainActivity((a) => seen.push(a))();
    expect(seen).toEqual([{ session_id: SID, phase: "planning", plan, replayed: true }]);
    act({ session_id: SID, phase: "thinking" });
    const late: unknown[] = [];
    onBrainActivity((a) => late.push(a))();
    expect(late).toEqual([]);
  });
  it("nothing is replayed once the panel cleared it (unmount, New chat)", () => {
    fakeWindow();
    act({ session_id: SID, phase: "planning" });
    clearBrainActivity();
    const seen: unknown[] = [];
    onBrainActivity((a) => seen.push(a))();
    expect(seen).toEqual([]);
  });
});
