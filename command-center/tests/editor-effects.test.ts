/**
 * Clip effects (modules/timeline.py FILTERS, UNIT_EFFECTS, BLUR_MAX, ROTATIONS):
 * the lists and limits are the backend's, the validator refuses what the worker
 * would, and the model keeps the fields through a round trip. The shared cases
 * (samples/timeline_doc_cases.json) are judged by both validators in
 * editor-timeline.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLUR_MAX,
  FILTERS,
  ROTATIONS,
  UNIT_EFFECTS,
  setSpeed,
  splitClip,
  toDoc,
  toModel,
  validateTimeline,
  type TimelineDoc,
} from "@/lib/editor";

const A = "11111111-1111-4111-8111-111111111111";

function doc(clip: Record<string, unknown> = {}): TimelineDoc {
  return {
    version: 1,
    width: 1280,
    height: 720,
    fps: 30,
    tracks: [
      {
        id: "v1",
        kind: "V",
        clips: [
          { id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 4, ...clip },
        ],
      },
    ],
  };
}

describe("the effect lists and limits are the backend's", () => {
  const py = readFileSync(
    join(__dirname, "..", "..", "modules", "timeline.py"),
    "utf8",
  );
  it("closed lists", () => {
    const list = (name: string) =>
      [
        ...new RegExp(`${name} = \\(([^)]*)\\)`).exec(py)![1].matchAll(/"([\w-]+)"/g),
      ].map((m) => m[1]);
    expect(list("FILTERS")).toEqual([...FILTERS]);
    expect(list("UNIT_EFFECTS")).toEqual([...UNIT_EFFECTS]);
    expect(
      [...(/ROTATIONS = \(([^)]*)\)/.exec(py)![1].matchAll(/\d+/g))].map((m) => Number(m[0])),
    ).toEqual([...ROTATIONS]);
    expect(Number(/BLUR_MAX = ([\d.]+)/.exec(py)![1])).toBe(BLUR_MAX);
  });
});

describe("validateTimeline and effects", () => {
  it("accepts every look and refuses the rest", () => {
    for (const f of FILTERS)
      expect(validateTimeline(doc({ filter: f })), f).toEqual([]);
    for (const bad of ["noir", "", "Mono", "mono ", "mono,movie=/etc/passwd", null, 1, ["mono"]])
      expect(validateTimeline(doc({ filter: bad })).join(";"), String(bad)).toContain("filter is not available");
  });

  it("holds each number to its range", () => {
    const ranges: [string, number][] = [
      ["vignette", 1],
      ["sharpen", 1],
      ["grain", 1],
      ["blur", BLUR_MAX],
    ];
    for (const [k, hi] of ranges) {
      for (const ok of [0, hi / 2, hi])
        expect(validateTimeline(doc({ [k]: ok })), `${k}=${ok}`).toEqual([]);
      for (const bad of [-0.001, hi + 0.001, NaN, Infinity, "1", null, true])
        expect(validateTimeline(doc({ [k]: bad })).length, `${k}=${String(bad)}`).toBeGreaterThan(0);
    }
    expect(validateTimeline(doc({ filter: "warm", filter_strength: 0.5 }))).toEqual([]);
    expect(validateTimeline(doc({ filter: "warm", filter_strength: 1.1 })).length).toBe(1);
    expect(validateTimeline(doc({ filter_strength: 0.5 })).join(";")).toContain("needs a filter");
  });

  it("takes only booleans for a mirror and only quarter turns", () => {
    for (const k of ["flip_h", "flip_v"]) {
      expect(validateTimeline(doc({ [k]: true }))).toEqual([]);
      for (const bad of [1, 0, "true", null])
        expect(validateTimeline(doc({ [k]: bad })).length, `${k}=${String(bad)}`).toBe(1);
    }
    for (const ok of ROTATIONS) expect(validateTimeline(doc({ rotate: ok }))).toEqual([]);
    for (const bad of [45, -90, 360, 90.5, "90", null, true])
      expect(validateTimeline(doc({ rotate: bad })).join(";"), String(bad)).toContain("rotate must be");
  });
});

describe("the model keeps the effects", () => {
  const rich = {
    filter: "cinematic",
    filter_strength: 0.6,
    vignette: 0.4,
    blur: 2.5,
    sharpen: 0.3,
    grain: 0.2,
    flip_h: true,
    flip_v: true,
    rotate: 90,
  };

  it("through toModel and toDoc, and across a split and a speed change", () => {
    const m = toModel(doc(rich));
    expect(m.clips[0]).toMatchObject(rich);
    expect(toDoc(m).tracks[0].clips[0]).toMatchObject(rich);
    const cut = splitClip(m, "c1", 2)!.model;
    expect(cut.clips).toHaveLength(2);
    for (const c of cut.clips) expect(c).toMatchObject(rich);
    expect(setSpeed(m, "c1", 2).clips[0]).toMatchObject(rich);
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });

  it("drops what means off, and adds nothing to a document without effects", () => {
    const off = toDoc(
      toModel(doc({ vignette: 0, blur: 0, flip_h: false, rotate: 0, grain: 0, sharpen: 0 })),
    );
    expect(JSON.stringify(off)).not.toMatch(/vignette|blur|flip_|rotate|grain|sharpen/);
    expect(JSON.stringify(toDoc(toModel(doc())))).not.toMatch(/filter|vignette|blur|flip_|rotate|grain|sharpen/);
  });
});
