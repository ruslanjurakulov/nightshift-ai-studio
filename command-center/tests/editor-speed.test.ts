/**
 * Speed 0.25-4, reverse and freeze (modules/timeline.py SPEED_*, REVERSE_*): the
 * limits are the backend's, the memory bound for a reversed range is the same
 * arithmetic, a frozen clip refuses what contradicts it, and the model keeps the
 * flags. Shared cases (samples/timeline_doc_cases.json) are judged by both
 * validators in editor-timeline.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REVERSE_BYTES_PER_PIXEL,
  REVERSE_MAX_BYTES,
  SPEED_MAX,
  SPEED_MIN,
  canSplit,
  reverseMaxSeconds,
  setSpeed,
  splitClip,
  toDoc,
  toModel,
  validateTimeline,
  type TimelineDoc,
} from "@/lib/editor";

const A = "11111111-1111-4111-8111-111111111111";

function doc(
  clip: Record<string, unknown> = {},
  frame: { width?: number; height?: number; fps?: number } = {},
): TimelineDoc {
  return {
    version: 1,
    width: frame.width ?? 640,
    height: frame.height ?? 360,
    fps: frame.fps ?? 30,
    tracks: [
      { id: "v1", kind: "V", clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 4, ...clip }] },
    ],
  };
}

describe("the constants are the backend's", () => {
  it("speed range and reverse memory", () => {
    const py = readFileSync(join(__dirname, "..", "..", "modules", "timeline.py"), "utf8");
    expect(/SPEED_MIN, SPEED_MAX = ([\d.]+), ([\d.]+)/.exec(py)!.slice(1).map(Number)).toEqual([SPEED_MIN, SPEED_MAX]);
    expect(REVERSE_MAX_BYTES).toBe(512 * 1024 ** 2);
    expect(REVERSE_BYTES_PER_PIXEL).toBe(1.5);
    expect(py).toContain("REVERSE_MAX_BYTES = 512 * 1024 * 1024");
  });
});

describe("speed", () => {
  it("runs from a quarter to four times", () => {
    for (const ok of [0.25, 0.3, 1, 3, 4]) expect(validateTimeline(doc({ speed: ok })), String(ok)).toEqual([]);
    for (const bad of [0.249, 4.001, 0, -1, "2", null, NaN])
      expect(validateTimeline(doc({ speed: bad })).join(";"), String(bad)).toContain("speed must be");
    expect(setSpeed(toModel(doc()), "c1", 10).clips[0].speed).toBe(4);
    expect(setSpeed(toModel(doc()), "c1", 0.01).clips[0].speed).toBe(0.25);
  });
});

describe("reverse and freeze", () => {
  it("are booleans", () => {
    for (const k of ["reverse", "freeze"]) {
      expect(validateTimeline(doc({ [k]: true }))).toEqual([]);
      for (const bad of [1, "true", null])
        expect(validateTimeline(doc({ [k]: bad })).join(";"), `${k}=${String(bad)}`).toContain(`${k} must be true or false`);
    }
  });
  it("a frozen clip has no speed, sound or reverse", () => {
    expect(validateTimeline(doc({ freeze: true, speed: 1, audio: false }))).toEqual([]);
    expect(validateTimeline(doc({ freeze: true, speed: 2 })).join(";")).toContain("no speed");
    expect(validateTimeline(doc({ freeze: true, audio: true })).join(";")).toContain("no sound");
    expect(validateTimeline(doc({ freeze: true, reverse: true })).join(";")).toContain("cannot also be reversed");
  });
  it("a reversed range fits the memory it holds, by the backend's arithmetic", () => {
    const big = { width: 1920, height: 1080, fps: 30 };
    expect(reverseMaxSeconds(1920, 1080, 30)).toBe(5.753);
    expect(validateTimeline(doc({ reverse: true, out_s: 5.7 }, big))).toEqual([]);
    expect(validateTimeline(doc({ reverse: true, out_s: 5.8 }, big)).join(";")).toContain("reverse holds every frame");
    expect(validateTimeline(doc({ out_s: 600 }, big))).toEqual([]);
    expect(validateTimeline(doc({ reverse: true, out_s: 0.7 }, { width: 3840, height: 2160, fps: 60 }))).toEqual([]);
    expect(validateTimeline(doc({ reverse: true, out_s: 0.8 }, { width: 3840, height: 2160, fps: 60 })).length).toBe(1);
  });
  it("survive the model, a split and a speed change", () => {
    const m = toModel(doc({ reverse: true }));
    expect(m.clips[0].reverse).toBe(true);
    expect(toDoc(m).tracks[0].clips[0].reverse).toBe(true);
    const cut = splitClip(m, "c1", 2)!.model;
    for (const c of cut.clips) expect(c.reverse).toBe(true);
    // played backwards, the first half on the timeline is the LATER part of the range
    expect(cut.clips.map((c) => [c.in_s, c.out_s])).toEqual([[2, 4], [0, 2]]);
    expect(setSpeed(m, "c1", 2).clips[0].reverse).toBe(true);
    // not the middle: a 0..10 clip played backwards, cut 3 s in, is 7..10 then 0..7
    const long = toModel(doc({ reverse: true, in_s: 0, out_s: 10 }));
    expect(canSplit(long, "c1", 3)).toBe(true);
    const off = splitClip(long, "c1", 3)!.model;
    expect(off.clips.map((c) => [c.in_s, c.out_s])).toEqual([[7, 10], [0, 7]]);
    expect(off.clips.map((c) => c.start_s)).toEqual([0, 3]);
    expect(validateTimeline(toDoc(off))).toEqual([]);
    const fast = splitClip(toModel(doc({ reverse: true, in_s: 1, out_s: 5, speed: 2 })), "c1", 0.5)!.model;
    expect(fast.clips.map((c) => [c.in_s, c.out_s])).toEqual([[4, 5], [1, 4]]);
    // too close to the end it plays from: refused
    expect(canSplit(long, "c1", 9.99)).toBe(false);
    expect(canSplit(long, "c1", 0.01)).toBe(false);
    expect(JSON.stringify(toDoc(toModel(doc({ reverse: false, freeze: false }))))).not.toMatch(/reverse|freeze/);
    expect(toModel(doc({ freeze: true })).clips[0].freeze).toBe(true);
    const frozen = splitClip(toModel(doc({ freeze: true, in_s: 1, out_s: 4 })), "c1", 1)!.model;
    expect(frozen.clips.map((c) => [c.in_s, c.out_s, c.freeze])).toEqual([[1, 2, true], [1, 3, true]]);
  });
});
