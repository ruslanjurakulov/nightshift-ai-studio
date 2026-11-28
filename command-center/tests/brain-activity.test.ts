/**
 * The Nightshift AI panel's activity event (lib/studio/brainActivity.ts). What would break without these: a malformed or foreign event
 * read as "idle" (the board would drop its Planning state) or as a turn (it would switch the person's column), and a listener that
 * outlives its board.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAIN_ACTIVITY_EVENT, BRAIN_PHASES, emitBrainActivity, onBrainActivity, parseBrainActivity } from "../lib/studio/brainActivity";

const SID = "5e550000-0000-4000-8000-0000000000e1";

describe("parseBrainActivity", () => {
  it("takes each known phase, with a conversation or with none (a first turn)", () => {
    for (const phase of BRAIN_PHASES) {
      expect(parseBrainActivity({ session_id: SID, phase })).toEqual({ session_id: SID, phase });
      expect(parseBrainActivity({ session_id: null, phase })).toEqual({ session_id: null, phase });
    }
  });
  it("ignores anything malformed rather than guessing a phase", () => {
    for (const bad of [
      null,
      undefined,
      "thinking",
      42,
      [],
      [{ session_id: SID, phase: "thinking" }],
      {},
      { phase: "thinking" }, // no session_id at all is not "a new conversation"
      { session_id: SID },
      { session_id: SID, phase: "Thinking" },
      { session_id: SID, phase: "chapter_3_of_6" }, // a phase this build does not know
      { session_id: "not-a-uuid", phase: "idle" },
      { session_id: 7, phase: "idle" },
      { session_id: `${SID} `, phase: "idle" },
    ])
      expect(parseBrainActivity(bad)).toBeNull();
  });
  it("keeps only the fields it knows", () => {
    expect(parseBrainActivity({ session_id: SID, phase: "storyboard", progress: 0.5 })).toEqual({ session_id: SID, phase: "storyboard" });
  });
});

describe("emit and listen", () => {
  afterEach(() => vi.unstubAllGlobals());
  const fakeWindow = () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    return target;
  };
  it("a subscriber hears what the panel emits, and nothing after it unsubscribes", () => {
    fakeWindow();
    const seen: unknown[] = [];
    const off = onBrainActivity((a) => seen.push(a));
    emitBrainActivity({ session_id: null, phase: "thinking" });
    emitBrainActivity({ session_id: SID, phase: "idle" });
    off();
    emitBrainActivity({ session_id: SID, phase: "thinking" });
    expect(seen).toEqual([
      { session_id: null, phase: "thinking" },
      { session_id: SID, phase: "idle" },
    ]);
  });
  it("a malformed event under the same name never reaches the subscriber", () => {
    const w = fakeWindow();
    const handler = vi.fn();
    const off = onBrainActivity(handler);
    w.dispatchEvent(new CustomEvent(BRAIN_ACTIVITY_EVENT, { detail: { session_id: SID, phase: "done" } }));
    w.dispatchEvent(new CustomEvent(BRAIN_ACTIVITY_EVENT, { detail: "thinking" }));
    w.dispatchEvent(new Event(BRAIN_ACTIVITY_EVENT));
    off();
    expect(handler).not.toHaveBeenCalled();
  });
});
