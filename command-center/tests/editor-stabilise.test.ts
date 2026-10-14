/** `stabilize` (modules/timeline.py STABILIZE_*): a boolean for video clips, not
 *  with freeze, with a budget (it decodes the clip twice). Shared cases are
 *  judged by editor-timeline.test.ts. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STABILIZE_MAX_DOC_S,
  STABILIZE_FPS_1080P,
  STABILIZE_MAX_S,
  stabilizeSeconds,
  splitClip,
  toDoc,
  toModel,
  validateTimeline,
  type TimelineDoc,
} from "@/lib/editor";

const A = "11111111-1111-4111-8111-111111111111";
const doc = (clip: Record<string, unknown> = {}): TimelineDoc => ({
  version: 1,
  width: 1280,
  height: 720,
  fps: 30,
  tracks: [{ id: "v1", kind: "V", clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 4, ...clip }] }],
});
const v = (clip: Record<string, unknown>) => validateTimeline(doc(clip)).join(";");

describe("stabilize", () => {
  it("the limits are the backend's", () => {
    const py = readFileSync(join(__dirname, "..", "..", "modules", "timeline.py"), "utf8");
    expect(Number(/STABILIZE_MAX_S = ([\d.]+)/.exec(py)![1])).toBe(STABILIZE_MAX_S);
    expect(Number(/STABILIZE_MAX_DOC_S = ([\d.]+)/.exec(py)![1])).toBe(STABILIZE_MAX_DOC_S);
  });
  it("is a boolean, not with freeze, and bounded", () => {
    expect(v({ stabilize: true })).toBe("");
    expect(v({ stabilize: false })).toBe("");
    for (const bad of [1, "true", null]) expect(v({ stabilize: bad })).toContain("stabilize must be true or false");
    expect(v({ stabilize: true, freeze: true })).toContain("nothing to stabilise");
    expect(v({ stabilize: true, out_s: 120 })).toBe("");
    expect(v({ stabilize: true, out_s: 121 })).toContain("more than 120 s");
    expect(v({ out_s: 500 })).toBe("");
  });
  it("is charged in estimated seconds that must fit the worker's timeout", () => {
    expect(STABILIZE_FPS_1080P).toBe(7);
    expect(stabilizeSeconds({ in_s: 0, out_s: 10 }, 30, 1920, 1080)).toBeCloseTo(300 / 7, 6);
    expect(stabilizeSeconds({ in_s: 0, out_s: 60 }, 30, 3840, 2160)).toBeCloseTo(1028.57, 1);
    const hd = { width: 1920, height: 1080 };
    const w = (clip: Record<string, unknown>, frame: { width: number; height: number }) =>
      validateTimeline({ ...doc(clip), ...frame }).join(";");
    expect(w({ stabilize: true, out_s: 20 }, hd)).toBe("");
    expect(w({ stabilize: true, out_s: 60 }, hd)).toMatch(
      /stabilising would take about 317 s to render, but a 60 s timeline is allowed 300 s — stabilise less of it/,
    );
    expect(w({ stabilize: true, out_s: 60 }, { width: 1280, height: 720 })).toBe("");
    expect(w({ stabilize: true, out_s: 60 }, { width: 3840, height: 2160 })).toContain("about 1089 s");
    const both = doc({ speed: 0.5, interpolate: true, out_s: 4.9 });
    Object.assign(both, hd);
    both.tracks[0].clips.push({ id: "d1", asset_id: A, start_s: 9.8, in_s: 0, out_s: 20, stabilize: true });
    expect(validateTimeline(both).join(";")).toMatch(
      /interpolated slow motion and stabilising would take.*slow less of it and stabilise less of it/,
    );
  });
  it("has a budget for the whole document", () => {
    const d = doc({ stabilize: true, out_s: 100 });
    for (const i of [1, 2])
      d.tracks[0].clips.push({ id: `d${i}`, asset_id: A, start_s: 100 * i, in_s: 0, out_s: 100, stabilize: true });
    expect(validateTimeline(d)).toEqual([]);
    d.tracks[0].clips.push({ id: "d3", asset_id: A, start_s: 300, in_s: 0, out_s: 1, stabilize: true });
    expect(validateTimeline(d).join(";")).toContain("at most 300 s of video can be stabilised");
  });
  it("survives the model and a split, and false adds nothing", () => {
    const m = toModel(doc({ stabilize: true }));
    expect(m.clips[0].stabilize).toBe(true);
    expect(toDoc(m).tracks[0].clips[0]).toMatchObject({ stabilize: true });
    for (const c of splitClip(m, "c1", 2)!.model.clips) expect(c.stabilize).toBe(true);
    expect(JSON.stringify(toDoc(toModel(doc({ stabilize: false }))))).not.toContain("stabilize");
  });
});
