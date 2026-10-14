/**
 * Speed curves and interpolated slow motion (modules/timeline.py RAMP_*,
 * INTERP_*; modules/speed_ramp.py). The arithmetic in lib/editorSpeedRamp.ts is
 * the same closed form as the backend's; the validator holds the same rules.
 * Shared cases (samples/timeline_doc_cases.json) are judged by both validators
 * in editor-timeline.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INTERP_MAX_FPS,
  INTERP_MAX_FRAMES,
  INTERP_MAX_FRAMES_DOC,
  RAMP_MAX_POINTS,
  RAMP_MIN_GAP,
  RAMP_MIN_POINTS,
  canSplit,
  clipAt,
  clipEnd,
  clipLength,
  interpolatedFrames,
  setSpeed,
  sourceTimeAt,
  toDoc,
  toModel,
  validateTimeline,
  type TimelineDoc,
} from "@/lib/editor";
import {
  rampAbsolute,
  rampOutLength,
  rampOutTime,
  rampSourceAt,
} from "@/lib/editorSpeedRamp";

const A = "11111111-1111-4111-8111-111111111111";
const RAMP = [
  { at: 0, speed: 1 },
  { at: 0.5, speed: 4 },
  { at: 1, speed: 0.5 },
];

function doc(clip: Record<string, unknown> = {}, frame: Record<string, number> = {}): TimelineDoc {
  return {
    version: 1,
    width: frame.width ?? 1280,
    height: frame.height ?? 720,
    fps: 30,
    tracks: [
      { id: "v1", kind: "V", clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 4, ...clip }] },
    ],
  };
}
const v = (clip: Record<string, unknown>, frame?: Record<string, number>) =>
  validateTimeline(doc(clip, frame)).join(";");

describe("the arithmetic is the backend's", () => {
  it("matches the Python values", () => {
    const pts = rampAbsolute(RAMP, 4);
    expect(rampOutLength(pts)).toBeCloseTo(2.112448550277928, 12);
    expect(rampOutTime(pts, 2)).toBeCloseTo(0.9241962407465937, 12);
    expect(rampOutTime(pts, 4)).toBeCloseTo(rampOutLength(pts), 12);
    expect(rampSourceAt(pts, rampOutTime(pts, 3.1))).toBeCloseTo(3.1, 6);
    expect(rampSourceAt(pts, -1)).toBe(0);
    expect(rampSourceAt(pts, 99)).toBe(4);
    expect(rampOutLength(rampAbsolute([{ at: 0, speed: 2 }, { at: 1, speed: 2 }], 3))).toBeCloseTo(1.5, 12);
  });
  it("the limits are the backend's", () => {
    const py = readFileSync(join(__dirname, "..", "..", "modules", "timeline.py"), "utf8");
    expect(/RAMP_MIN_POINTS, RAMP_MAX_POINTS = (\d+), (\d+)/.exec(py)!.slice(1).map(Number)).toEqual([
      RAMP_MIN_POINTS,
      RAMP_MAX_POINTS,
    ]);
    expect(Number(/RAMP_MIN_GAP = ([\d.]+)/.exec(py)![1])).toBe(RAMP_MIN_GAP);
    expect(Number(/INTERP_MAX_FPS = (\d+)/.exec(py)![1])).toBe(INTERP_MAX_FPS);
    expect(Number(/INTERP_MAX_FRAMES = (\d+)/.exec(py)![1])).toBe(INTERP_MAX_FRAMES);
    expect(Number(/INTERP_MAX_FRAMES_DOC = (\d+)/.exec(py)![1])).toBe(INTERP_MAX_FRAMES_DOC);
  });
});

describe("a speed curve", () => {
  it("takes 2 to 6 points from 0 to 1, in order and apart, with speeds in range", () => {
    expect(v({ speed_curve: RAMP })).toBe("");
    expect(v({ speed_curve: [{ at: 0, speed: 1 }, { at: 1, speed: 1 }] })).toBe("");
    for (const [bad, needle] of [
      [[], "list of 2 to 6"],
      [[{ at: 0, speed: 1 }], "list of 2 to 6"],
      [[{ at: 0.1, speed: 1 }, { at: 1, speed: 2 }], "first point must be at 0"],
      [[{ at: 0, speed: 1 }, { at: 0.9, speed: 2 }], "last at 1"],
      [[{ at: 0, speed: 1 }, { at: 0.6, speed: 2 }, { at: 0.5, speed: 3 }, { at: 1, speed: 1 }], "at least 0.01 apart"],
      [[{ at: 0, speed: 0.2 }, { at: 1, speed: 1 }], "speed must be"],
      [[{ at: 0, speed: 1 }, { at: 1, speed: 4.5 }], "speed must be"],
      [[{ at: 0, speed: 1 }, { at: 1 }], "speed is missing"],
      [[{ at: 0, speed: 1, ease: 1 }, { at: 1, speed: 1 }], "ease is not a known field"],
      ["fast", "list of 2 to 6"],
      [null, "list of 2 to 6"],
    ] as const)
      expect(v({ speed_curve: bad }), JSON.stringify(bad)).toContain(needle);
  });
  it("replaces speed and excludes reverse and freeze", () => {
    expect(v({ speed_curve: RAMP, speed: 1 })).toBe("");
    expect(v({ speed_curve: RAMP, speed: 2 })).toContain("replaces speed");
    expect(v({ speed_curve: RAMP, reverse: true })).toContain("cannot be combined with reverse");
    expect(v({ speed_curve: RAMP, freeze: true })).toContain("cannot be combined with freeze");
  });
  it("makes the clip last the integral, and the model follows", () => {
    const m = toModel(doc({ speed_curve: RAMP }));
    expect(m.clips[0].speed_curve).toEqual(RAMP);
    expect(clipLength(m.clips[0])).toBe(2.112);
    expect(clipEnd(m.clips[0])).toBe(2.112);
    expect(toDoc(m).tracks[0].clips[0]).toMatchObject({ speed_curve: RAMP });
    expect(clipAt(m, 0.9241962)!.sourceS).toBeCloseTo(2, 2);
    expect(sourceTimeAt(m.clips[0], 2.112)).toBeCloseTo(4, 2);
    // the next clip may start where this one ends, and not before
    const two = doc({ speed_curve: RAMP });
    two.tracks[0].clips.push({ id: "c2", asset_id: A, start_s: 2.112, in_s: 0, out_s: 1 });
    expect(validateTimeline(two)).toEqual([]);
    two.tracks[0].clips[1].start_s = 2.0;
    expect(validateTimeline(two).join(";")).toContain("overlap");
  });
  it("is not split, and a constant speed replaces it", () => {
    const m = toModel(doc({ speed_curve: RAMP }));
    expect(canSplit(m, "c1", 1)).toBe(false);
    const s = setSpeed(m, "c1", 2).clips[0];
    expect(s.speed).toBe(2);
    expect(s.speed_curve).toBeUndefined();
    expect(JSON.stringify(toDoc(toModel(doc())))).not.toContain("speed_curve");
  });
});

describe("interpolated slow motion", () => {
  it("is for slow motion, forward only, inside its budget", () => {
    expect(v({ speed: 0.5, interpolate: true, out_s: 3 })).toBe("");
    expect(v({ speed_curve: RAMP, interpolate: true, out_s: 3 })).toBe("");
    expect(v({ interpolate: true })).toContain("slow motion");
    expect(v({ speed: 2, interpolate: true })).toContain("slow motion");
    expect(v({ speed_curve: [{ at: 0, speed: 2 }, { at: 1, speed: 4 }], interpolate: true })).toContain("slow motion");
    expect(v({ speed: 0.5, interpolate: true, reverse: true })).toContain("forward slow motion");
    expect(v({ speed: 0.5, interpolate: 1 })).toContain("interpolate must be true or false");
    expect(v({ speed: 0.5, interpolate: true, out_s: 11 })).toBe("");
    expect(v({ speed: 0.5, interpolate: true, out_s: 12 })).toContain("at most 300 per clip");
    expect(v({ speed: 0.5, interpolate: true, out_s: 4.9 }, { width: 1920, height: 1080 })).toBe("");
    expect(v({ speed: 0.5, interpolate: true, out_s: 5.1 }, { width: 1920, height: 1080 })).toContain("per clip");
    expect(interpolatedFrames(0, 1, 0.25, 60, 1920, 1080)).toBe(120);
  });
  it("has a budget for the whole document", () => {
    const d = doc({ speed: 0.5, interpolate: true }, { width: 1920, height: 1080 });
    for (const i of [1, 2])
      d.tracks[0].clips.push({ id: `d${i}`, asset_id: A, start_s: 8 * i, in_s: 0, out_s: 4, speed: 0.5, interpolate: true });
    expect(validateTimeline(d).join(";")).toContain("at most 600 per timeline");
    d.tracks[0].clips.pop();
    expect(validateTimeline(d)).toEqual([]);
  });
});
