/**
 * The editing core (model half): rolling, slip and slide edits and ripple trim to the playhead (lib/editor.ts), in /
 * out marks with ripple delete, lift and insert at the playhead, and the one-click J / L cut (lib/editorRange.ts),
 * the cut-to-cut jumps, the shuttle and the key map (lib/editor-shortcuts.ts), and the preview's guides
 * (lib/editorGuides.ts). What would break without these: a roll that changes the timeline's length, a slip past
 * the end of its file, a slide that moves the clips after it, a range delete that leaves a sliver under a frame or
 * eats the whole picture, a lift that moves what comes after it, a J / L cut that plays a sound twice or past its
 * file, a key that fires in a text field, or a document either validator refuses. A seeded run of 5,000 edits
 * holds every operation to `validateTimeline` after the editor's own settling.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_DOC_BYTES,
  MAX_EDITOR_CLIPS,
  MAX_EDITOR_SOUNDS,
  clipEnd,
  clipLength,
  crossfadeOf,
  docAssetProblems,
  docBytes,
  editPoints,
  layout,
  modelDuration,
  nextEditPoint,
  rippleTrimTo,
  rollEdit,
  rollRange,
  slideClip,
  slideRange,
  slipClip,
  slipRange,
  splitClip,
  toDoc,
  toModel,
  validateTimeline,
  type EditorModel,
  type SoundClip,
  type VideoClip,
} from "@/lib/editor";
import {
  LIFT_MASK,
  NO_MARKS,
  extractRange,
  insertAt,
  isLiftHold,
  liftRange,
  markedRange,
  setMark,
  splitEdit,
} from "@/lib/editorRange";
import { settleAll } from "@/lib/editorSettle";
import {
  SHORTCUT_HELP,
  focusKind,
  nextShuttle,
  resolveModShortcut,
  resolveShortcut,
  SHUTTLE_MAX,
} from "@/lib/editor-shortcuts";
import { ACTION_SAFE, TITLE_SAFE, appAreas, isVerticalNineSixteen, loadGuides, safeRect } from "@/lib/editorGuides";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const A = "11111111-1111-4111-8111-111111111111"; // a 10 s video
const B = "22222222-2222-4222-8222-222222222222"; // a 6 s video
const P = "33333333-3333-4333-8333-333333333333"; // a picture
const LEN: Record<string, number | null> = { [A]: 10, [B]: 6, [P]: null };
const KIND: Record<string, "video" | "image"> = { [A]: "video", [B]: "video", [P]: "image" };
const sourceOf = (id: string) => LEN[id] ?? null;
const kindOf = (id: string) => KIND[id];

const clip = (id: string, extra: Partial<VideoClip> = {}): VideoClip => ({
  id,
  asset_id: A,
  start_s: 0,
  in_s: 0,
  out_s: 4,
  speed: 1,
  audio: true,
  ...extra,
});
const model = (clips: VideoClip[], extra: Partial<EditorModel> = {}): EditorModel => ({
  width: 1920,
  height: 1080,
  fps: 30,
  clips: layout(clips),
  texts: [],
  sounds: [],
  keep: [],
  ...extra,
});
/** c1 [0,4] A 0-4, c2 [4,8] A 2-6, c3 [8,10] A 1-3. */
const three = (c2: Partial<VideoClip> = {}, c1: Partial<VideoClip> = {}, c3: Partial<VideoClip> = {}) =>
  model([clip("c1", c1), clip("c2", { in_s: 2, out_s: 6, ...c2 }), clip("c3", { in_s: 1, out_s: 3, ...c3 })]);
const byId = (m: EditorModel, id: string) => layout(m.clips).find((c) => c.id === id)!;
const valid = (m: EditorModel) => {
  const doc = toDoc(m);
  expect(validateTimeline(doc)).toEqual([]);
  expect(docAssetProblems(doc, { [A]: "video", [B]: "video", [P]: "image" })).toEqual([]);
  expect(docBytes(doc)).toBeLessThanOrEqual(MAX_DOC_BYTES);
};
const near = (a: number, b: number, eps = 0.0021) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe("rolling edit", () => {
  it("moves the cut: the clip before ends later, this one starts later, nothing else moves", () => {
    const m = three();
    const r = rollEdit(m, "c2", 0.5, sourceOf);
    expect([byId(r, "c1").out_s, byId(r, "c2").in_s]).toEqual([4.5, 2.5]);
    expect([byId(r, "c2").start_s, clipEnd(byId(r, "c2")), byId(r, "c3").start_s]).toEqual([4.5, 8, 8]);
    expect(modelDuration(r)).toBe(modelDuration(m));
    valid(r);
  });

  it("stops where a side would be under its shortest piece or past its file", () => {
    const m = three();
    // c2 can give back only its 2 s before in_s: the cut stops 2 s earlier.
    const back = rollEdit(m, "c2", -5, sourceOf);
    expect([byId(back, "c1").out_s, byId(back, "c2").in_s]).toEqual([2, 0]);
    // later: c2 keeps 0.1 s (its shortest piece), c1 has the file to 7.9
    const fwd = rollEdit(m, "c2", 7, sourceOf);
    expect([byId(fwd, "c1").out_s, byId(fwd, "c2").in_s]).toEqual([7.9, 5.9]);
    near(clipLength(byId(fwd, "c2")), 0.1);
    valid(back);
    valid(fwd);
    // the file's end: c1 on B (6 s) out at 4 can roll 2 s later at most
    const capped = rollEdit(three({}, { asset_id: B }), "c2", 3, sourceOf);
    expect(byId(capped, "c1").out_s).toBe(6);
  });

  it("is not there for the first clip, a missing id or a speed curve, and a zero roll is the same model", () => {
    const m = three();
    expect(rollEdit(m, "c1", 1, sourceOf)).toBe(m);
    expect(rollEdit(m, "nope", 1, sourceOf)).toBe(m);
    expect(rollEdit(m, "c2", 0, sourceOf)).toBe(m);
    expect(rollRange(m, "c1", sourceOf)).toBeNull();
    const curved = three({ speed_curve: [{ at: 0, speed: 1 }, { at: 1, speed: 2 }] });
    expect(rollEdit(curved, "c2", 0.5, sourceOf)).toBe(curved);
  });

  it("counts a fast clip's source at its speed and runs a reversed clip from its end", () => {
    const fast = three({ speed: 2 }); // c2 2-6 at 2x lasts 2 s
    const r = rollEdit(fast, "c2", 0.5, sourceOf);
    expect(byId(r, "c2").in_s).toBe(3);
    expect(modelDuration(r)).toBe(modelDuration(fast));
    // a reversed clip before the cut grows at its tail by playing more of its START
    const rev = three({}, { in_s: 1, out_s: 5, reverse: true });
    const r2 = rollEdit(rev, "c2", 0.5, sourceOf);
    expect([byId(r2, "c1").in_s, byId(r2, "c1").out_s]).toEqual([0.5, 5]);
    // a reversed clip at in 0 has nothing more to give
    const stuck = three({}, { in_s: 0, out_s: 4, reverse: true });
    expect(rollEdit(stuck, "c2", 0.5, sourceOf)).toBe(stuck);
    valid(r);
    valid(r2);
  });

  it("holds a frozen clip's frame and changes only its hold", () => {
    const m = three({}, { freeze: true, audio: false, in_s: 3, out_s: 7 });
    const r = rollEdit(m, "c2", 1, sourceOf);
    expect([byId(r, "c1").in_s, byId(r, "c1").out_s]).toEqual([3, 8]);
    valid(r);
  });

  it("keeps a cross-fade at the cut whole, so the timeline keeps its length", () => {
    const m = three({ transition: { type: "crossfade", duration_s: 1 } });
    const r = rollEdit(m, "c2", -3.5, sourceOf);
    expect(crossfadeOf(byId(r, "c2"))).toBe(1);
    expect(modelDuration(r)).toBe(modelDuration(m));
    // c1 must keep the 1 s c2's cross-fade uses (and a millisecond's margin)
    const short = rollEdit(three({ in_s: 5, out_s: 9, transition: { type: "crossfade", duration_s: 1 } }), "c2", -5, sourceOf);
    expect(clipLength(byId(short, "c1"))).toBeGreaterThanOrEqual(1);
    expect(crossfadeOf(byId(short, "c2"))).toBe(1);
    valid(r);
    valid(short);
  });

  it("holds the clips' fades and entrances to their new length", () => {
    const m = three({ fade_in_s: 3, in_s: 2, out_s: 6 });
    const r = rollEdit(m, "c2", 3.5, sourceOf);
    expect(byId(r, "c2").fade_in_s! + (byId(r, "c2").fade_out_s ?? 0)).toBeLessThanOrEqual(clipLength(byId(r, "c2")));
    valid(r);
  });
});

describe("slip edit", () => {
  it("shows another part of the file, in the same place and for as long", () => {
    const m = three();
    const r = slipClip(m, "c2", 1, sourceOf);
    expect([byId(r, "c2").in_s, byId(r, "c2").out_s, byId(r, "c2").start_s]).toEqual([3, 7, 4]);
    expect(layout(r.clips).map((c) => c.start_s)).toEqual(layout(m.clips).map((c) => c.start_s));
    valid(r);
  });

  it("stops at either end of the file, and never guesses a file it does not know", () => {
    const m = three();
    expect([byId(slipClip(m, "c2", 10, sourceOf), "c2").in_s, byId(slipClip(m, "c2", 10, sourceOf), "c2").out_s]).toEqual([6, 10]);
    expect(byId(slipClip(m, "c2", -10, sourceOf), "c2").in_s).toBe(0);
    expect(slipRange(m, "c2", () => null)).toBeNull();
    expect(slipClip(m, "c2", 1, () => null)).toBe(m);
    // a picture has no time inside it to slip through
    const still = three({ asset_id: P, in_s: 0, out_s: 3, audio: false });
    expect(slipClip(still, "c2", 1, sourceOf)).toBe(still);
  });

  it("slips a fast, a reversed and a curved clip with their range, and a frozen one by its frame", () => {
    const fast = slipClip(three({ speed: 2 }), "c2", 1, sourceOf);
    expect([byId(fast, "c2").in_s, byId(fast, "c2").out_s]).toEqual([3, 7]);
    const rev = slipClip(three({ reverse: true }), "c2", -1, sourceOf);
    expect([byId(rev, "c2").in_s, byId(rev, "c2").out_s]).toEqual([1, 5]);
    const curve = [{ at: 0, speed: 1 }, { at: 1, speed: 2 }];
    const curved = slipClip(three({ speed_curve: curve }), "c2", 2, sourceOf);
    expect(byId(curved, "c2").speed_curve).toEqual(curve);
    expect(byId(curved, "c2").in_s).toBe(4);
    const frozen = slipClip(three({ freeze: true, audio: false, in_s: 2, out_s: 6 }), "c2", 7, sourceOf);
    expect(byId(frozen, "c2").in_s).toBeLessThan(10);
    near(clipLength(byId(frozen, "c2")), 4);
    for (const r of [fast, rev, curved, frozen]) valid(r);
  });
});

describe("slide edit", () => {
  it("moves the clip between its neighbours, which give and take, so the timeline keeps its length", () => {
    const m = three();
    const r = slideClip(m, "c2", 1, sourceOf);
    expect([byId(r, "c1").out_s, byId(r, "c2").start_s, byId(r, "c2").in_s, byId(r, "c3").in_s]).toEqual([5, 5, 2, 2]);
    expect(clipEnd(byId(r, "c3"))).toBe(10);
    expect(modelDuration(r)).toBe(modelDuration(m));
    valid(r);
  });

  it("stops at what the neighbours have, and is not there for the first or last clip", () => {
    const m = three();
    const r = slideClip(m, "c2", 3, sourceOf);
    near(clipLength(byId(r, "c3")), 0.1);
    // back: c3 can give back only the 1 s before its in_s
    const back = slideClip(m, "c2", -10, sourceOf);
    expect([byId(back, "c1").out_s, byId(back, "c3").in_s]).toEqual([3, 0]);
    expect(slideClip(m, "c1", 1, sourceOf)).toBe(m);
    expect(slideClip(m, "c3", 1, sourceOf)).toBe(m);
    expect(slideRange(m, "c3", sourceOf)).toBeNull();
    valid(r);
    valid(back);
  });

  it("slides a fast clip without changing it, and a neighbour at another speed by its speed", () => {
    const m = three({ speed: 2 }, {}, { speed: 0.5, in_s: 1, out_s: 2 }); // c3 lasts 2 s
    const r = slideClip(m, "c2", 0.5, sourceOf);
    expect([byId(r, "c2").in_s, byId(r, "c2").out_s, byId(r, "c2").speed]).toEqual([2, 6, 2]);
    expect(byId(r, "c3").in_s).toBe(1.25);
    expect(modelDuration(r)).toBe(modelDuration(m));
    valid(r);
  });
});

describe("ripple trim to the playhead (Q / W)", () => {
  it("Q takes off what plays before the playhead and closes up; the playhead goes to the clip's start", () => {
    const m = three();
    const out = rippleTrimTo(m, 5, "head")!;
    expect(byId(out.model, "c2").in_s).toBe(3);
    expect(out.playhead).toBe(4);
    expect(modelDuration(out.model)).toBe(9);
    valid(out.model);
  });

  it("W takes off what plays from the playhead on; the playhead stays", () => {
    const out = rippleTrimTo(three(), 5, "tail")!;
    expect(byId(out.model, "c2").out_s).toBe(3);
    expect(out.playhead).toBe(5);
    expect(modelDuration(out.model)).toBe(7);
    valid(out.model);
  });

  it("does nothing on a clip's first frame, past the picture, on a curve, or where a sliver would be left", () => {
    const m = three();
    expect(rippleTrimTo(m, 4, "head")).toBeNull();
    expect(rippleTrimTo(m, 12, "head")).toBeNull();
    expect(rippleTrimTo(three({ speed_curve: [{ at: 0, speed: 1 }, { at: 1, speed: 2 }] }), 5, "head")).toBeNull();
    expect(rippleTrimTo(m, 7.95, "head")).toBeNull();
  });

  it("works on the first and last clip, a fast one and a reversed one", () => {
    const first = rippleTrimTo(three(), 1, "head")!;
    expect([byId(first.model, "c1").in_s, first.playhead]).toEqual([1, 0]);
    const last = rippleTrimTo(three(), 9, "tail")!;
    expect(byId(last.model, "c3").out_s).toBe(2);
    const fast = rippleTrimTo(three({ speed: 2 }), 5, "head")!; // 1 s of timeline is 2 s of source
    expect(byId(fast.model, "c2").in_s).toBe(4);
    const rev = rippleTrimTo(three({ reverse: true }), 5, "head")!; // backwards: the first second is the range's end
    expect([byId(rev.model, "c2").in_s, byId(rev.model, "c2").out_s]).toEqual([2, 5]);
    for (const r of [first, last, fast, rev]) valid(r.model);
  });

  it("carries a move on from where it had reached", () => {
    const m = three({ move: { from: { zoom: 1 }, to: { zoom: 2 } } });
    const out = rippleTrimTo(m, 6, "head")!;
    expect(byId(out.model, "c2").move).toEqual({ from: { zoom: 1.5, x: 0.5, y: 0.5 }, to: { zoom: 2 } });
    valid(out.model);
  });
});

describe("cut to cut (Up / Down)", () => {
  it("lists every cut once and steps from one to the next", () => {
    const m = three();
    expect(editPoints(m)).toEqual([0, 4, 8, 10]);
    expect(nextEditPoint(m, 0, 1)).toBe(4);
    expect(nextEditPoint(m, 4, 1)).toBe(8);
    expect(nextEditPoint(m, 4.01, -1)).toBe(4);
    // parked on a cut (within half a millisecond) is AT it: the key goes on
    expect(nextEditPoint(m, 4.0001, -1)).toBe(0);
    expect(nextEditPoint(m, 4, -1)).toBe(0);
    expect(nextEditPoint(m, 10, 1)).toBeNull();
    expect(nextEditPoint(m, 0, -1)).toBeNull();
  });

  it("knows both edges of a cross-fade", () => {
    const m = three({ transition: { type: "crossfade", duration_s: 1 } });
    expect(editPoints(m)).toEqual([0, 3, 4, 7, 9]);
  });
});

describe("in and out marks", () => {
  it("sit on a frame inside the timeline", () => {
    expect(setMark(NO_MARKS, "in", 1.01, 30, 10)).toEqual({ in: 1, out: null });
    expect(setMark(NO_MARKS, "out", 99, 30, 10)).toEqual({ in: null, out: 10 });
    expect(setMark(NO_MARKS, "in", -3, 30, 10).in).toBe(0);
  });

  it("read in order; one mark runs to an end; under a frame is no range", () => {
    expect(markedRange(NO_MARKS, 10, 30)).toBeNull();
    expect(markedRange({ in: 5, out: 3 }, 10, 30)).toEqual([3, 5]);
    expect(markedRange({ in: 2, out: null }, 10, 30)).toEqual([2, 10]);
    expect(markedRange({ in: null, out: 4 }, 10, 30)).toEqual([0, 4]);
    expect(markedRange({ in: 3, out: 3 }, 10, 30)).toBeNull();
    expect(markedRange({ in: 3, out: 3.01 }, 10, 30)).toBeNull();
    // a timeline that got shorter holds the marks to its end
    expect(markedRange({ in: 8, out: 12 }, 9, 30)).toEqual([8, 9]);
  });
});

describe("ripple delete between the marks", () => {
  it("cuts at both marks, takes the part out and closes up", () => {
    const out = extractRange(three(), 2, 6);
    if ("problem" in out) throw new Error(out.problem);
    expect(out.removed).toBe(2);
    const c = layout(out.model.clips);
    expect(c.map((x) => [x.start_s, x.in_s, x.out_s])).toEqual([[0, 0, 2], [2, 4, 6], [4, 1, 3]]);
    expect(modelDuration(out.model)).toBe(6);
    valid(out.model);
  });

  it("takes a whole clip at its own cuts without splitting, and a mark within half a frame of a cut is that cut", () => {
    const out = extractRange(three(), 4.01, 8);
    if ("problem" in out) throw new Error(out.problem);
    expect(layout(out.model.clips).map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("removes the first or the last clip's part", () => {
    const head = extractRange(three(), 0, 1);
    const tail = extractRange(three(), 9, 10);
    if ("problem" in head || "problem" in tail) throw new Error("refused");
    expect(layout(head.model.clips)[0].in_s).toBe(1);
    expect(byId(tail.model, "c3").out_s).toBe(2);
    valid(head.model);
    valid(tail.model);
  });

  it("says why when it cannot: nothing marked, the whole picture, only text past the picture, a curve, a full lane", () => {
    const m = three();
    expect(extractRange(m, 3, 3)).toEqual({ problem: "no_range" });
    expect(extractRange(m, 0, 10)).toEqual({ problem: "whole" });
    expect(extractRange(m, 10.5, 12)).toEqual({ problem: "no_range" });
    expect(extractRange(three({ speed_curve: [{ at: 0, speed: 1 }, { at: 1, speed: 2 }] }), 5, 6)).toEqual({ problem: "curve" });
    const full = model(Array.from({ length: MAX_EDITOR_CLIPS }, (_, i) => clip(`c${i + 1}`, { audio: false })));
    expect(extractRange(full, 1, 2)).toEqual({ problem: "clips_full" });
    // at whole-clip cuts it needs no split, so a full lane can still lose a clip
    expect("model" in extractRange(full, 4, 8)).toBe(true);
  });

  it("will not leave a sliver against a cross-fade", () => {
    // c1 at 0.25x needs 0.4 s of timeline for its shortest piece; c2 fades in over its last 0.3 s (from 3.7)
    const m = model([clip("c1", { out_s: 1, speed: 0.25 }), clip("c2", { transition: { type: "crossfade", duration_s: 0.3 } })]);
    expect(extractRange(m, 1, 3.65)).toEqual({ problem: "too_close" });
  });

  it("takes a mark inside a cross-fade to where it ends, so a lift keeps the timeline's length", () => {
    const m = three({ transition: { type: "crossfade", duration_s: 1 } }); // c2 fades in over 3..4
    const out = liftRange(m, 1, 3.5, kindOf);
    if ("problem" in out) throw new Error(out.problem);
    expect(modelDuration(out.model)).toBe(modelDuration(m));
    const hold = byId(out.model, out.id);
    expect([hold.start_s, clipEnd(hold)]).toEqual([1, 4]);
    valid(out.model);
  });

  it("handles fast, reversed and frozen clips and a cross-fade inside the range", () => {
    for (const c2 of [{ speed: 2 }, { reverse: true }, { freeze: true, audio: false }, { transition: { type: "crossfade" as const, duration_s: 1 } }]) {
      const out = extractRange(three(c2), 3, 6.5);
      if ("problem" in out) throw new Error(`${JSON.stringify(c2)}: ${out.problem}`);
      valid(out.model);
    }
  });
});

describe("lift between the marks", () => {
  it("leaves black and silence for exactly as long, so nothing after it moves", () => {
    const m = three();
    const out = liftRange(m, 2, 6, kindOf);
    if ("problem" in out) throw new Error(out.problem);
    const hold = byId(out.model, out.id);
    expect(hold).toMatchObject({ start_s: 2, in_s: 2, out_s: 6, speed: 1, audio: false, freeze: true, mask: { ...LIFT_MASK } });
    expect(isLiftHold(hold)).toBe(true);
    expect(modelDuration(out.model)).toBe(modelDuration(m));
    expect(byId(out.model, "c3").start_s).toBe(8);
    valid(out.model);
  });

  it("holds a picture as a still (a picture cannot freeze), and the whole picture may be lifted", () => {
    const m = model([clip("c1", { asset_id: P, out_s: 3, audio: false }), clip("c2")]);
    const out = liftRange(m, 1, 2, kindOf);
    if ("problem" in out) throw new Error(out.problem);
    const hold = byId(out.model, out.id);
    expect(hold.freeze).toBeUndefined();
    expect([hold.in_s, hold.out_s]).toEqual([0, 1]);
    valid(out.model);
    const all = liftRange(three(), 0, 10, kindOf);
    if ("problem" in all) throw new Error(all.problem);
    expect(layout(all.model.clips)).toHaveLength(1);
    valid(all.model);
  });

  it("never guesses a file it does not know", () => {
    expect(liftRange(three(), 2, 6, () => undefined)).toEqual({ problem: "unknown_file" });
  });

  it("lifts across a cross-fade and a reversed or fast clip and keeps the length", () => {
    for (const c2 of [{ transition: { type: "crossfade" as const, duration_s: 1 } }, { reverse: true }, { speed: 2 }]) {
      const m = three(c2);
      const out = liftRange(m, 2.5, 6.5, kindOf);
      if ("problem" in out) throw new Error(out.problem);
      near(modelDuration(out.model), modelDuration(m));
      valid(out.model);
    }
  });

  it("is valid in a 4K frame, where a mask may not sit on a cross-faded clip (the hold has cuts both sides)", () => {
    const m = { ...three({ transition: { type: "crossfade", duration_s: 1 } }, {}, { transition: { type: "crossfade", duration_s: 0.5 } }), width: 3840, height: 2160 };
    const out = liftRange(m, 4.5, 6, kindOf);
    if ("problem" in out) throw new Error(out.problem);
    expect(crossfadeOf(byId(out.model, out.id))).toBe(0);
    valid(out.model);
  });
});

describe("insert at the playhead", () => {
  const copy = clip("x", { in_s: 1, out_s: 3, transition: { type: "crossfade", duration_s: 0.5 } });
  it("splits the clip under the playhead and puts the copy in, everything after it later", () => {
    const out = insertAt(three(), copy, 6);
    if ("problem" in out) throw new Error(out.problem);
    const c = layout(out.model.clips);
    expect(c.map((x) => x.start_s)).toEqual([0, 4, 6, 8, 10]);
    const ins = byId(out.model, out.id);
    expect([ins.start_s, ins.in_s, ins.out_s, ins.transition]).toEqual([6, 1, 3, undefined]);
    expect(modelDuration(out.model)).toBe(12);
    valid(out.model);
  });

  it("goes in at a cut, at the start, and past the end it is appended", () => {
    for (const [t, at] of [[4, 1], [0, 0], [10, 3], [25, 3]] as const) {
      const out = insertAt(three(), copy, t);
      if ("problem" in out) throw new Error(out.problem);
      expect(layout(out.model.clips).findIndex((c) => c.id === out.id)).toBe(at);
      valid(out.model);
    }
  });

  it("is refused on a full lane, and on an empty one it is the first clip", () => {
    const full = model(Array.from({ length: MAX_EDITOR_CLIPS }, (_, i) => clip(`c${i + 1}`, { audio: false })));
    expect(insertAt(full, copy, 1)).toEqual({ problem: "clips_full" });
    const almost = model(Array.from({ length: MAX_EDITOR_CLIPS - 1 }, (_, i) => clip(`c${i + 1}`, { audio: false })));
    // mid-clip needs a split and the copy: two places
    expect(insertAt(almost, copy, 1)).toEqual({ problem: "clips_full" });
    expect("model" in insertAt(almost, copy, 4)).toBe(true);
    const empty = model([]);
    const out = insertAt(empty, copy, 3);
    if ("problem" in out) throw new Error(out.problem);
    expect(layout(out.model.clips)[0].start_s).toBe(0);
  });
});

describe("one-click J / L cut", () => {
  const sounds = (m: EditorModel) => Object.fromEntries(m.sounds.map((x) => [x.id, x] as const));
  it("L: the clip before keeps sounding into this one; this one's sound starts as much later", () => {
    const m = three();
    const out = splitEdit(m, "c2", "l", 12, sourceOf, kindOf);
    if ("problem" in out) throw new Error(out.problem);
    expect(out.frames).toBe(12);
    expect(out.sounds).toHaveLength(2);
    const [a, b] = out.sounds.map((id) => sounds(out.model)[id]);
    expect([a.start_s, a.in_s, a.out_s]).toEqual([0, 0, 4.4]);
    expect([b.start_s, b.in_s, b.out_s]).toEqual([4.4, 2.4, 6]);
    expect(byId(out.model, "c1").audio).toBe(false);
    expect(byId(out.model, "c2").audio).toBe(false);
    // the picture did not move
    expect(layout(out.model.clips).map((c) => [c.start_s, c.in_s, c.out_s])).toEqual(layout(m.clips).map((c) => [c.start_s, c.in_s, c.out_s]));
    valid(out.model);
  });

  it("J: this clip's sound starts under the end of the one before", () => {
    const out = splitEdit(three(), "c2", "j", 12, sourceOf, kindOf);
    if ("problem" in out) throw new Error(out.problem);
    const [a, b] = out.sounds.map((id) => out.model.sounds.find((x) => x.id === id)!);
    expect(a.out_s).toBe(3.6);
    expect([b.start_s, b.in_s]).toEqual([3.6, 1.6]);
    valid(out.model);
  });

  it("is held to what the files have, and says when there is no frame to give", () => {
    const l = splitEdit(three({}, { out_s: 9.9, in_s: 5.9 }), "c2", "l", 12, sourceOf, kindOf);
    if ("problem" in l) throw new Error(l.problem);
    expect(l.frames).toBe(3);
    const j = splitEdit(three({ in_s: 0.1, out_s: 4 }), "c2", "j", 12, sourceOf, kindOf);
    if ("problem" in j) throw new Error(j.problem);
    expect(j.frames).toBe(3);
    expect(splitEdit(three({ in_s: 0, out_s: 4 }), "c2", "j", 12, sourceOf, kindOf)).toEqual({ problem: "no_room" });
    expect(splitEdit(three(), "c2", "l", 0, sourceOf, kindOf)).toEqual({ problem: "no_room" });
  });

  it("with one side already silent (its sound detached before) moves only the other side's sound", () => {
    const m = three({}, { audio: false });
    const out = splitEdit(m, "c2", "l", 6, sourceOf, kindOf);
    if ("problem" in out) throw new Error(out.problem);
    expect(out.sounds).toHaveLength(1);
    expect(out.model.sounds[0]).toMatchObject({ start_s: 4.2, in_s: 2.2 });
    valid(out.model);
  });

  it("says why it cannot: the first clip, no sound either side, a picture, a retimed clip, a full mix", () => {
    expect(splitEdit(three(), "c1", "l", 6, sourceOf, kindOf)).toEqual({ problem: "no_cut" });
    expect(splitEdit(three({ audio: false }, { audio: false }), "c2", "l", 6, sourceOf, kindOf)).toEqual({ problem: "no_sound" });
    expect(splitEdit(three({ asset_id: P }), "c2", "l", 6, sourceOf, kindOf)).toEqual({ problem: "not_video" });
    expect(splitEdit(three({ speed: 2 }), "c2", "l", 6, sourceOf, kindOf)).toEqual({ problem: "retimed" });
    expect(splitEdit(three({ reverse: true }), "c2", "l", 6, sourceOf, kindOf)).toEqual({ problem: "retimed" });
    const s = (id: string): SoundClip => ({ id, asset_id: B, start_s: 0, in_s: 0, out_s: 1, gain_db: 0, fade_in_s: 0, fade_out_s: 0 });
    const busy = { ...three(), sounds: Array.from({ length: MAX_EDITOR_SOUNDS - 1 }, (_, i) => s(`m${i + 10}`)) };
    expect(splitEdit(busy, "c2", "l", 6, sourceOf, kindOf)).toEqual({ problem: "sounds_full" });
  });

  it("over a cross-fade too", () => {
    const out = splitEdit(three({ transition: { type: "crossfade", duration_s: 1 } }), "c2", "j", 12, sourceOf, kindOf);
    if ("problem" in out) throw new Error(out.problem);
    valid(out.model);
  });
});

describe("the shuttle (J / K / L)", () => {
  it("L plays, more L doubles up to the top, K stops, J turns round at 1x", () => {
    let s = { playing: false, rate: 1 };
    s = nextShuttle(s, "shuttleForward");
    expect(s).toEqual({ playing: true, rate: 1 });
    for (const want of [2, 4, 8, 8]) {
      s = nextShuttle(s, "shuttleForward");
      expect(s.rate).toBe(want);
    }
    expect(SHUTTLE_MAX).toBe(8);
    s = nextShuttle(s, "shuttleBack");
    expect(s).toEqual({ playing: true, rate: -1 });
    s = nextShuttle(s, "shuttleBack");
    expect(s.rate).toBe(-2);
    expect(nextShuttle(s, "shuttleStop")).toEqual({ playing: false, rate: 1 });
    expect(nextShuttle({ playing: false, rate: 1 }, "shuttleBack")).toEqual({ playing: true, rate: -1 });
  });
});

describe("the key map", () => {
  const k = (key: string, extra = {}, focus: Parameters<typeof resolveShortcut>[1] = "other") =>
    resolveShortcut({ key, ...extra }, focus);
  it("has the editing core's keys", () => {
    const want: Record<string, string> = {
      j: "shuttleBack", k: "shuttleStop", l: "shuttleForward", i: "markIn", o: "markOut", q: "rippleHead", w: "rippleTail",
      v: "toolTrim", n: "toolRoll", y: "toolSlip", u: "toolSlide", ";": "lift", "'": "extract", ",": "insert",
      ArrowUp: "prevEdit", ArrowDown: "nextEdit",
    };
    for (const [key, action] of Object.entries(want)) expect(k(key), key).toBe(action);
    expect(k("J")).toBe("shuttleBack"); // Caps Lock
    // M: there is no marker the document can keep yet, so it is not taken
    expect(k("m")).toBeNull();
  });

  it("follows the physical key on a Cyrillic layout, but a Latin letter by what it says", () => {
    expect(resolveShortcut({ key: "о", code: "KeyJ" }, "other")).toBe("shuttleBack");
    expect(resolveShortcut({ key: "ш", code: "KeyI" }, "other")).toBe("markIn");
    expect(resolveShortcut({ key: "ж", code: "Semicolon" }, "other")).toBe("lift");
    expect(resolveShortcut({ key: "э", code: "Quote" }, "other")).toBe("extract");
    expect(resolveShortcut({ key: "б", code: "Comma" }, "other")).toBe("insert");
    expect(resolveShortcut({ key: "q", code: "KeyA" }, "other")).toBe("rippleHead"); // AZERTY's A position types q
  });

  it("never fires in a text field or on a slider, with Ctrl / Alt, held down, or with Shift", () => {
    for (const key of ["j", "k", "l", "i", "o", "q", "w", ";", "'", ",", "ArrowUp", "ArrowDown", "v", "n", "y", "u"]) {
      expect(k(key, {}, "text"), key).toBeNull();
      expect(k(key, {}, "slider"), key).toBeNull();
      expect(k(key, { ctrlKey: true }), key).toBeNull();
      expect(k(key, { altKey: true }), key).toBeNull();
      expect(k(key, { shiftKey: true }), key).toBeNull();
    }
    for (const key of ["j", "l", "i", "q", ";"]) expect(k(key, { repeat: true }), key).toBeNull();
    // Up / Down repeat (hold to run through the cuts), but a radio group keeps them
    expect(k("ArrowDown", { repeat: true })).toBe("nextEdit");
    expect(k("ArrowDown", {}, "choice")).toBeNull();
    expect(k("ArrowUp", {}, "control")).toBe("prevEdit");
  });

  it("Ctrl / Cmd + K splits, but not in a text field, with Shift or Alt, or held", () => {
    expect(resolveModShortcut({ key: "k", ctrlKey: true }, "other")).toBe("split");
    expect(resolveModShortcut({ key: "k", metaKey: true }, "control")).toBe("split");
    expect(resolveModShortcut({ key: "л", code: "KeyK", ctrlKey: true }, "other")).toBe("split");
    expect(resolveModShortcut({ key: "k", ctrlKey: true }, "text")).toBeNull();
    expect(resolveModShortcut({ key: "k", ctrlKey: true }, "slider")).toBeNull();
    expect(resolveModShortcut({ key: "k", ctrlKey: true, shiftKey: true }, "other")).toBeNull();
    expect(resolveModShortcut({ key: "k", ctrlKey: true, altKey: true }, "other")).toBeNull();
    expect(resolveModShortcut({ key: "k", ctrlKey: true, repeat: true }, "other")).toBeNull();
    expect(resolveModShortcut({ key: "k" }, "other")).toBeNull();
    expect(resolveShortcut({ key: "k", ctrlKey: true }, "other")).toBeNull();
  });

  it("keeps every key it had", () => {
    expect(k("s")).toBe("split");
    expect(k(" ")).toBe("play");
    expect(k("ArrowLeft")).toBe("left");
    expect(k("0")).toBe("zoomFit");
    expect(focusKind({ tag: "INPUT", inputType: "range" })).toBe("slider");
  });

  it("lists every new key in the help once, with a label in every language", () => {
    const actions = SHORTCUT_HELP.map((r) => r.action);
    expect(new Set(actions).size).toBe(actions.length);
    for (const a of ["shuttleBack", "shuttleStop", "shuttleForward", "prevEdit", "markIn", "markOut", "extract", "lift", "insert", "rippleHead", "rippleTail", "toolTrim", "toolRoll", "toolSlip", "toolSlide"])
      expect(actions, a).toContain(a);
    expect(SHORTCUT_HELP.find((r) => r.action === "split")!.keys).toEqual([["S"], ["Ctrl", "K"]]);
    for (const d of [en, ru, uz]) {
      const keys = d.editor.core.keys as Record<string, string>;
      for (const a of actions.filter((x) => x in en.editor.core.keys)) expect(keys[a]?.length, a).toBeGreaterThan(0);
    }
  });
});

describe("the preview's guides", () => {
  it("draws the app areas on a 9:16 frame only", () => {
    expect(isVerticalNineSixteen({ width: 1080, height: 1920 })).toBe(true);
    expect(isVerticalNineSixteen({ width: 2160, height: 3840 })).toBe(true);
    expect(isVerticalNineSixteen({ width: 1920, height: 1080 })).toBe(false);
    expect(isVerticalNineSixteen({ width: 1080, height: 1080 })).toBe(false);
    expect(appAreas({ width: 1920, height: 1080 }, "tiktok")).toEqual([]);
    expect(appAreas({ width: 1080, height: 1920 }, null)).toEqual([]);
    for (const app of ["shorts", "tiktok", "reels"] as const) {
      const areas = appAreas({ width: 1080, height: 1920 }, app);
      expect(areas.length).toBeGreaterThanOrEqual(4);
      for (const r of areas) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
        expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
    // Reels: 14 % top, 35 % bottom
    const reels = appAreas({ width: 1080, height: 1920 }, "reels");
    expect(reels[0].h).toBe(0.14);
    expect(reels[1].h).toBe(0.35);
  });

  it("title and action safe are SMPTE ST 2046-1's 90 % and 93 %, centred", () => {
    expect([TITLE_SAFE, ACTION_SAFE]).toEqual([0.9, 0.93]);
    const r = safeRect(0.9);
    expect([r.x, r.y, r.w, r.h].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0.05, 0.05, 0.9, 0.9]);
  });

  it("reads back nothing it cannot use", () => {
    expect(loadGuides()).toEqual({ app: null, safe: false, grid: false });
  });

  it("are never part of the document", () => {
    const doc = JSON.stringify(toDoc(three()));
    expect(doc).not.toMatch(/guide|safe|marks/i);
  });
});

// ── 5,000 seeded edits ─────────────────────────────────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomModel(r: () => number): EditorModel {
  const n = 1 + Math.floor(r() * 6);
  const clips: VideoClip[] = [];
  for (let i = 0; i < n; i += 1) {
    const kind = r();
    const asset = kind < 0.15 ? P : kind < 0.55 ? A : B;
    const len = LEN[asset] ?? 8;
    const a = Math.round(r() * (len - 1) * 10) / 10;
    const b = Math.min(len, Math.round((a + 0.5 + r() * (len - a - 0.5)) * 10) / 10);
    const c: VideoClip = { id: `c${i + 1}`, asset_id: asset, start_s: 0, in_s: asset === P ? 0 : a, out_s: asset === P ? 1 + Math.round(r() * 40) / 10 : b, speed: 1, audio: asset !== P && r() < 0.8 };
    const v = r();
    if (asset !== P && v < 0.15) c.speed = [0.5, 2, 3][Math.floor(r() * 3)];
    else if (asset !== P && v < 0.22) c.reverse = true;
    else if (asset !== P && v < 0.27) {
      c.freeze = true;
      c.audio = false;
    }
    if (i > 0 && r() < 0.3) c.transition = { type: "crossfade", duration_s: 0.3 + Math.round(r() * 7) / 10 };
    if (r() < 0.2) c.fade_in_s = 0.2;
    if (r() < 0.2) c.fade_out_s = 0.3;
    if ((c.fade_in_s ?? 0) + (c.fade_out_s ?? 0) > (c.out_s - c.in_s) / c.speed - 0.05) {
      delete c.fade_in_s;
      delete c.fade_out_s;
    }
    if (r() < 0.1 && !c.fade_in_s) c.anim_in = "zoom";
    clips.push(c);
  }
  const vertical = r() < 0.3;
  return model(clips, vertical ? { width: 1080, height: 1920 } : {});
}

describe("5,000 seeded edits keep the document valid after the editor's settling", () => {
  it("every operation, on any timeline, gives a document both checks accept", () => {
    const r = rng(20261112);
    let edits = 0;
    let changed = 0;
    const byOp = new Array(11).fill(0) as number[];
    for (let doc = 0; doc < 250; doc += 1) {
      let m = settleAll(randomModel(r)).model;
      valid(m);
      let marks = NO_MARKS;
      let clipboard: VideoClip | null = null;
      for (let step = 0; step < 20; step += 1) {
        const clips = layout(m.clips);
        const total = modelDuration(m);
        const pick = clips.length ? clips[Math.floor(r() * clips.length)] : null;
        const t = Math.round(r() * total * m.fps) / m.fps;
        const d = (r() - 0.5) * 6;
        const op = Math.floor(r() * 11);
        let next = m;
        let keepsLength = false;
        if (op === 0 && pick) {
          next = rollEdit(m, pick.id, d, sourceOf);
          keepsLength = true;
        } else if (op === 1 && pick) {
          next = slipClip(m, pick.id, d, sourceOf);
          keepsLength = true;
        } else if (op === 2 && pick) {
          next = slideClip(m, pick.id, d, sourceOf);
          keepsLength = true;
        } else if (op === 3) next = rippleTrimTo(m, t, r() < 0.5 ? "head" : "tail")?.model ?? m;
        else if (op === 4) marks = setMark(marks, r() < 0.5 ? "in" : "out", t, m.fps, total);
        else if (op === 5) {
          const rg = markedRange(marks, total, m.fps);
          const out = rg ? extractRange(m, rg[0], rg[1]) : null;
          if (out && "model" in out) next = out.model;
        } else if (op === 6) {
          const rg = markedRange(marks, total, m.fps);
          const out = rg ? liftRange(m, rg[0], rg[1], kindOf) : null;
          if (out && "model" in out) {
            next = out.model;
            near(modelDuration(next), total, 0.003);
          }
        } else if (op === 7 && clipboard) {
          const out = insertAt(m, clipboard, t);
          if ("model" in out) next = out.model;
        } else if (op === 8 && pick) clipboard = pick;
        else if (op === 9 && pick) {
          const out = splitEdit(m, pick.id, r() < 0.5 ? "j" : "l", 1 + Math.floor(r() * 24), sourceOf, kindOf);
          if ("model" in out) next = out.model;
        } else if (op === 10 && pick) next = splitClip(m, pick.id, t)?.model ?? m;
        edits += 1;
        if (next === m) continue;
        changed += 1;
        byOp[op] += 1;
        if (keepsLength && Math.abs(modelDuration(next) - total) > 0.003)
          throw new Error(`op ${op} changed the length ${total} -> ${modelDuration(next)}: ${JSON.stringify(m.clips)} -> ${JSON.stringify(next.clips)}`);
        const settled = settleAll(next, m).model;
        const why = validateTimeline(toDoc(settled));
        if (why.length) throw new Error(`op ${op}: ${why.join("; ")}\n${JSON.stringify(m.clips)}\n${JSON.stringify(next.clips)}`);
        valid(settled);
        m = settled;
      }
    }
    expect(edits).toBe(5000);
    // the run must actually exercise the operations, not refuse its way through (4 sets a mark, 8 copies)
    expect(changed).toBeGreaterThan(1500);
    for (const op of [0, 1, 2, 3, 5, 6, 7, 9, 10]) expect(byOp[op], `op ${op}`).toBeGreaterThan(40);
  });
});
