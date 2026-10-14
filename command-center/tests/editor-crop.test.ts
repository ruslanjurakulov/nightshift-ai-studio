/** Crop and a free angle (modules/timeline.py CROP_MIN, ANGLE_MAX): the limits
 *  are the backend's, the rectangle must lie inside the picture, and the model
 *  keeps both. Shared cases (samples/timeline_doc_cases.json) are judged by
 *  editor-timeline.test.ts. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANGLE_MAX,
  CROP_MIN,
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
  tracks: [
    { id: "v1", kind: "V", clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 4, ...clip }] },
  ],
});
const v = (clip: Record<string, unknown>) => validateTimeline(doc(clip)).join(";");

describe("crop and angle", () => {
  it("the limits are the backend's", () => {
    const py = readFileSync(join(__dirname, "..", "..", "modules", "timeline.py"), "utf8");
    expect(Number(/CROP_MIN = ([\d.]+)/.exec(py)![1])).toBe(CROP_MIN);
    expect(Number(/ANGLE_MAX = ([\d.]+)/.exec(py)![1])).toBe(ANGLE_MAX);
  });
  it("a crop is a rectangle inside the picture", () => {
    expect(v({ crop: { x: 0.25, y: 0.1, w: 0.5, h: 0.8 } })).toBe("");
    expect(v({ crop: {} })).toBe("");
    expect(v({ crop: { x: 0.5, w: 0.5 } })).toBe("");
    expect(v({ crop: { x: 0.6, w: 0.5 } })).toContain("x + w must not go past");
    expect(v({ crop: { y: 0.9, h: 0.2 } })).toContain("y + h must not go past");
    for (const bad of [-0.01, 1.01, NaN, "0.5", null])
      expect(v({ crop: { x: bad } }), String(bad)).toContain("x must be");
    for (const bad of [0.049, 0, 1.01])
      expect(v({ crop: { w: bad } }), String(bad)).toContain("w must be");
    expect(v({ crop: { z: 1 } })).toContain("z is not a known field");
    for (const bad of [[], null, 1, "x"]) expect(v({ crop: bad })).toContain("must be an object");
  });
  it("an angle is a number from -180 to 180", () => {
    for (const ok of [0, 45.5, -180, 180]) expect(v({ angle: ok }), String(ok)).toBe("");
    for (const bad of [180.001, -181, NaN, "45", null, true])
      expect(v({ angle: bad }), String(bad)).toContain("angle must be");
  });
  it("the model keeps both through a round trip and a split, and adds nothing when off", () => {
    const crop = { x: 0.25, w: 0.5 };
    const m = toModel(doc({ crop, angle: -12.5 }));
    expect(m.clips[0]).toMatchObject({ crop, angle: -12.5 });
    expect(toDoc(m).tracks[0].clips[0]).toMatchObject({ crop, angle: -12.5 });
    for (const c of splitClip(m, "c1", 2)!.model.clips) expect(c).toMatchObject({ crop, angle: -12.5 });
    expect(JSON.stringify(toDoc(toModel(doc({ angle: 0 }))))).not.toContain("angle");
  });
});
