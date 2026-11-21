/**
 * Moves (modules/timeline.py MOVE_*): a clip's two-point Ken Burns window and an
 * overlay's end keyframe. The shared cases (samples/timeline_doc_cases.json) are
 * judged by both validators in editor-timeline.test.ts; this pins the
 * constants, the strictness and the round trip through the model.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MOVE_POINT_DEFAULTS,
  MOVE_ZOOM_MAX,
  MOVE_ZOOM_MIN,
  splitClip,
  toDoc,
  toModel,
  validateTimeline,
  type TimelineDoc,
} from "@/lib/editor";

const A = "11111111-1111-4111-8111-111111111111";

function doc(
  clip: Record<string, unknown> = {},
  overlay?: Record<string, unknown>,
): TimelineDoc {
  const d: TimelineDoc = {
    version: 1,
    width: 1280,
    height: 720,
    fps: 30,
    tracks: [
      {
        id: "v1",
        kind: "V",
        clips: [{ id: "c1", asset_id: A, start_s: 0, in_s: 0, out_s: 4, ...clip }],
      },
    ],
  };
  if (overlay)
    d.overlays = [{ id: "o1", asset_id: A, start_s: 1, end_s: 3, ...overlay }];
  return d;
}

describe("the move constants are the backend's", () => {
  it("zoom range and defaults", () => {
    const py = readFileSync(join(__dirname, "..", "..", "modules", "timeline.py"), "utf8");
    expect(/MOVE_ZOOM_MIN, MOVE_ZOOM_MAX = ([\d.]+), ([\d.]+)/.exec(py)!.slice(1).map(Number)).toEqual([
      MOVE_ZOOM_MIN,
      MOVE_ZOOM_MAX,
    ]);
    expect(MOVE_POINT_DEFAULTS).toEqual({ zoom: 1, x: 0.5, y: 0.5 });
  });
});

describe("validateTimeline and a clip's move", () => {
  const mv = (z1: unknown = 2, extra: Record<string, unknown> = {}) => ({
    from: { zoom: 1 },
    to: { zoom: z1, ...extra },
  });
  it("takes two points with optional keys inside their ranges", () => {
    expect(validateTimeline(doc({ move: mv(4, { x: 0, y: 1 }) }))).toEqual([]);
    expect(validateTimeline(doc({ move: { from: {}, to: {} } }))).toEqual([]);
    for (const bad of [0.99, 4.01, NaN, "2", null, true])
      expect(validateTimeline(doc({ move: mv(bad) })).join(";"), String(bad)).toContain("zoom must be");
    for (const bad of [-0.01, 1.01, "0.5"])
      expect(validateTimeline(doc({ move: mv(2, { x: bad }) })).join(";"), String(bad)).toContain("x must be");
  });
  it("is strict about its shape", () => {
    expect(validateTimeline(doc({ move: { from: {} } })).join(";")).toContain("to is missing");
    expect(validateTimeline(doc({ move: { to: {} } })).join(";")).toContain("from is missing");
    expect(validateTimeline(doc({ move: { from: {}, to: {}, via: {} } })).join(";")).toContain("via is not a known field");
    expect(validateTimeline(doc({ move: { from: { angle: 1 }, to: {} } })).join(";")).toContain("angle is not a known field");
    for (const bad of [[], null, 1, "x"])
      expect(validateTimeline(doc({ move: bad })).join(";")).toContain("must be an object");
  });
});

describe("validateTimeline and an overlay's move", () => {
  const v = (move: unknown) => validateTimeline(doc({}, { move })).join(";");
  it("names what changes", () => {
    expect(v({ to: { x: 0.8, y: 0.1, w: 0.5, opacity: 0 } })).toBe("");
    expect(v({ to: {} })).toContain("give at least one");
    expect(v({})).toContain("to is missing");
    expect(v({ to: { zoom: 2 } })).toContain("zoom is not a known field");
    expect(v({ from: { x: 1 }, to: { x: 0.5 } })).toContain("from is not a known field");
    expect(v({ to: { x: 1.5 } })).toContain("x must be");
    expect(v({ to: { w: 0.01 } })).toContain("w must be");
    expect(v({ to: { opacity: "1" } })).toContain("opacity must be");
  });
});

describe("the model keeps the moves", () => {
  it("through toModel / toDoc and a split", () => {
    const move = { from: { zoom: 1 }, to: { zoom: 2, x: 0.25 } };
    const d = doc({ move }, { move: { to: { x: 0.8 } } });
    const m = toModel(d);
    expect(m.clips[0].move).toEqual(move);
    const back = toDoc(m);
    expect(back.tracks[0].clips[0].move).toEqual(move);
    expect(back.overlays![0]).toMatchObject({ move: { to: { x: 0.8 } } });
    const cut = splitClip(m, "c1", 2)!.model;
    const mid = { zoom: 1.5, x: 0.375, y: 0.5 };
    expect(cut.clips[0].move).toEqual({ from: move.from, to: mid });
    expect(cut.clips[1].move).toEqual({ from: mid, to: move.to });
    expect(validateTimeline(back)).toEqual([]);
  });
  it("adds nothing when there is none", () => {
    expect(JSON.stringify(toDoc(toModel(doc({}, {}))))).not.toContain("move");
  });
});
