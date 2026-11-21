/**
 * Keeping the document one the export accepts after ANY edit (lib/editorSettle.ts):
 * a frame shape that makes a backwards part, smoothing or steadying too big, a
 * deleted clip that shrinks the export's time allowance, a new cross-fade on a big
 * frame. Each case is checked against the validator itself, and the changes made
 * are reported so the editor can say them.
 */
import { describe, expect, it } from "vitest";
import {
  XFADE_LARGE_ZOOM_MAX,
  addClip,
  newDocForAsset,
  removeClip,
  setCrossfade,
  toDoc,
  toModel,
  validateTimeline,
  type EditorAsset,
  type EditorModel,
} from "@/lib/editor";
import { setFrame } from "@/lib/editorFrame";
import { reverseLimit, trimLimited } from "@/lib/editorMotion";
import { settleAll } from "@/lib/editorSettle";

const A = "11111111-1111-4111-8111-111111111111";
const LONGV: EditorAsset = { id: A, kind: "video", name: "v", durationS: 300, width: 1080, height: 1080, viewUrl: "/v", thumbUrl: null };
const base = (): EditorModel => toModel(newDocForAsset(LONGV)!); // a 1:1 project
const valid = (m: EditorModel) => expect(validateTimeline(toDoc(m))).toEqual([]);
const set = (m: EditorModel, i: number, patch: Record<string, unknown>): EditorModel => ({
  ...m,
  clips: m.clips.map((c, k) => (k === i ? { ...c, ...patch } : c)),
});
const to169 = (m: EditorModel) => settleAll(setFrame(m, "16:9"));

describe("a project that is fine is left alone", () => {
  it("the same model back and no changes", () => {
    const m = base();
    expect(settleAll(m)).toEqual({ model: m, changes: [] });
    const rev = set(m, 0, { out_s: 4, reverse: true });
    const out = settleAll(rev);
    expect(out.model).toBe(rev);
    expect(out.changes).toEqual([]);
  });
});

describe("switching the frame shape", () => {
  it("a backwards part that no longer fits is shortened to the new limit, and the change is reported", () => {
    const m = set(base(), 0, { out_s: 10.2, reverse: true });
    valid(m); // fine on a square frame
    expect(setFrame(m, "16:9").clips[0].out_s).toBe(10.2); // the bare preset change would break it
    expect(validateTimeline(toDoc(setFrame(m, "16:9"))).join(" ")).toContain("at most 5.733 s");
    const out = to169(m);
    const limit = reverseLimit(out.model);
    expect(limit).toBe(5.733);
    expect(out.model.clips[0].out_s).toBeCloseTo(limit, 3);
    expect(out.changes).toEqual([{ kind: "reverse", clip: 1, max: limit }]);
    valid(out.model);
    expect(out.model.clips[0].reverse).toBe(true);
    // the other tall shape too
    const tall = settleAll(setFrame(m, "9:16"));
    valid(tall.model);
  });

  it("smoothing that no longer fits is switched off, and the change is reported", () => {
    // 8.8 s at 0.5x: 297 frames on a square frame, 528 on a wide one (the per-clip budget is 300)
    const m = set(base(), 0, { out_s: 8.8, speed: 0.5, interpolate: true });
    valid(m);
    const out = to169(m);
    expect(out.model.clips[0].interpolate).toBeUndefined();
    expect(out.changes).toEqual([{ kind: "interpolate", clip: 1 }]);
    valid(out.model);
  });

  it("steadying that no longer fits the export's time allowance is switched off, and the change is reported", () => {
    // a minute of steadying: 205 s of work on a square frame (300 s allowed), 317 s on a wide one
    const m = set(base(), 0, { out_s: 60, stabilize: true });
    valid(m);
    const out = to169(m);
    expect(out.model.clips[0].stabilize).toBeUndefined();
    expect(out.changes).toEqual([{ kind: "stabilize", clip: 1 }]);
    valid(out.model);
  });

  it("a shape that still fits changes nothing", () => {
    const m = set(base(), 0, { out_s: 4, reverse: true });
    const out = to169(m);
    expect(out.changes).toEqual([]);
    expect(out.model.width).toBe(1920);
  });
});

describe("other edits that move a limit", () => {
  it("deleting a clip shrinks the export's time allowance: the steadying that no longer fits goes", () => {
    let m = addClip(base(), LONGV);
    m = set(m, 1, { out_s: 60, stabilize: true });
    m = setFrame(m, "16:9"); // the plain clip's length is what lets 60 s of steadying fit
    const plain = settleAll(m);
    expect(plain.changes).toEqual([]);
    valid(plain.model);
    const without = settleAll(removeClip(plain.model, plain.model.clips[0].id));
    expect(without.model.clips[0].stabilize).toBeUndefined();
    expect(without.changes).toEqual([{ kind: "stabilize", clip: 1 }]);
    valid(without.model);
  });

  it("shortening another clip (a trim) does the same", () => {
    let m = addClip(setFrame(base(), "16:9"), LONGV);
    m = set(m, 1, { out_s: 60, stabilize: true });
    expect(settleAll(m).changes).toEqual([]);
    const shorter = settleAll(trimLimited(m, m.clips[0].id, "out", 1, 300));
    expect(shorter.changes.map((c) => c.kind)).toEqual(["stabilize"]);
    valid(shorter.model);
  });

  it("when several do not fit together, the dearest goes first and the rest stay", () => {
    // a 1 s clip, then 40 s and 60 s steadied on a wide frame: 529 s of work against 423 s allowed
    let m = setFrame(base(), "16:9");
    m = set(m, 0, { out_s: 1 });
    m = addClip(addClip(m, LONGV), LONGV);
    m = set(set(m, 1, { out_s: 40, stabilize: true }), 2, { out_s: 60, stabilize: true });
    expect(validateTimeline(toDoc(m)).join(" ")).toContain("would take about");
    const out = settleAll(m);
    expect(out.changes).toEqual([{ kind: "stabilize", clip: 3 }]);
    expect(out.model.clips[1].stabilize).toBe(true);
    expect(out.model.clips[2].stabilize).toBeUndefined();
    valid(out.model);
  });

  it("a new cross-fade on a clip in a frame above 1440p takes its blur away and lowers its zoom", () => {
    let m = addClip(base(), LONGV);
    m = { ...m, width: 3840, height: 2160 };
    m = set(m, 0, { blur: 12, move: { from: { zoom: 1 }, to: { zoom: 3 } } });
    valid(m); // no cross-fade yet: fine
    const faded = setCrossfade(m, m.clips[1].id, 1);
    expect(validateTimeline(toDoc(faded)).join(" ")).toContain("blur is not offered");
    const out = settleAll(faded);
    expect(out.model.clips[0].blur).toBeUndefined();
    expect(out.model.clips[0].move).toEqual({ from: { zoom: 1 }, to: { zoom: XFADE_LARGE_ZOOM_MAX } });
    expect(out.changes).toEqual([
      { kind: "blur", clip: 1 },
      { kind: "zoom", clip: 1, max: XFADE_LARGE_ZOOM_MAX },
    ]);
    valid(out.model);
  });

  it("a normal frame keeps its blur and zoom with a cross-fade", () => {
    let m = addClip(base(), LONGV);
    m = set(m, 0, { blur: 12, move: { from: { zoom: 1 }, to: { zoom: 3 } } });
    const faded = setCrossfade(m, m.clips[1].id, 1);
    const out = settleAll(faded);
    expect(out.changes).toEqual([]);
    expect(out.model.clips[0].blur).toBe(12);
  });
});
