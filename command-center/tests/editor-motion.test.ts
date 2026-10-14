/**
 * The model edits behind the Zoom and pan, overlay end position, speed,
 * backwards play, freeze, speed curve and slow-motion panels
 * (lib/editorMotion.ts). What would break without these: a control that writes
 * a combination the validator refuses (Save fails after a click), a limit
 * copied instead of imported, an edit that is not "the same model back" when
 * nothing changed, a trim that walks past a limit the document enforces.
 */
import { describe, expect, it } from "vitest";
import {
  INTERP_MAX_FRAMES,
  INTERP_SECONDS_PER_FRAME,
  MAX_EDITOR_CLIPS,
  MAX_PARTIAL_OPACITY_MOVES,
  XFADE_LARGE_ZOOM_MAX,
  MOVE_ZOOM_MAX,
  setCrossfade,
  partialOpacityMove,
  RAMP_MAX_POINTS,
  RAMP_MIN_GAP,
  RAMP_MIN_POINTS,
  SPEED_MAX,
  SPEED_MIN,
  addClip,
  canSplit,
  clipLength,
  newDocForAsset,
  renderTimeoutS,
  reverseMaxSeconds,
  setClipAudio,
  stabilizeSeconds,
  sourceTimeAt,
  splitClip,
  toDoc,
  toModel,
  validateTimeline,
  type EditorAsset,
  type EditorModel,
} from "@/lib/editor";
import { addOverlay, updateOverlay } from "@/lib/editorOverlay";
import { fitOf, previewObjectFit, setClipFit } from "@/lib/editorFrame";
import {
  CURVE_PRESETS,
  MOVE_PRESETS,
  addCurvePoint,
  canAddCurvePoint,
  centreHeld,
  clearOverlayMove,
  curveFromSpeeds,
  curveOf,
  freezeAtPlayhead,
  interpolateCheck,
  interpolateMaxSeconds,
  maxRangeFor,
  renderWork,
  moveOf,
  canPartialOpacity,
  partialMovesElsewhere,
  zoomLimit,
  movePresetOf,
  overlayAt,
  overlayEndOf,
  removeCurvePoint,
  reverseCheck,
  reverseLimit,
  setClipCurve,
  setClipFreeze,
  setClipInterpolate,
  setClipMove,
  setClipReverse,
  setClipSpeed,
  setCurvePoint,
  setMovePoint,
  setOverlayEnd,
  slowOpacityMove,
  slowestSpeed,
  startOverlayMove,
  trimLimited,
} from "@/lib/editorMotion";

const A = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";
const VIDEO: EditorAsset = {
  id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080,
  viewUrl: "/v", thumbUrl: null,
};
const PHOTO: EditorAsset = {
  id: P, kind: "image", name: "p.jpg", durationS: null, width: 1200, height: 800,
  viewUrl: "/p", thumbUrl: null,
};
const base = (): EditorModel => toModel(newDocForAsset(VIDEO)!);
const valid = (m: EditorModel) => expect(validateTimeline(toDoc(m))).toEqual([]);
const c0 = (m: EditorModel) => m.clips[0];
const id0 = (m: EditorModel) => m.clips[0].id;
/** A clip whose range is short enough to reverse. */
const short = (): EditorModel => {
  const m = base();
  return { ...m, clips: [{ ...c0(m), out_s: 4 }] };
};

describe("blurred-background fit (the third option)", () => {
  it("fitOf reports blur as blur, not contain; contain removes the field", () => {
    const m = base();
    const id = id0(m);
    const blur = setClipFit(m, id, "blur");
    expect(fitOf(c0(blur))).toBe("blur");
    expect(c0(blur).fit).toBe("blur");
    valid(blur);
    expect(setClipFit(blur, id, "blur")).toBe(blur);
    const back = setClipFit(blur, id, "contain");
    expect(c0(back).fit).toBeUndefined();
    expect(JSON.stringify(toDoc(back))).toBe(JSON.stringify(toDoc(m)));
    expect(fitOf(c0(toModel(toDoc(blur))))).toBe("blur");
  });

  it("the picture itself is drawn whole (contain) over the blurred copy", () => {
    expect(previewObjectFit({ fit: "blur" }, false)).toBe("contain");
    expect(previewObjectFit({ fit: "blur" }, true)).toBe("cover");
  });
});

describe("zoom and pan of a clip", () => {
  it("a preset is stored in full and found again; None removes the move", () => {
    const m0 = base();
    const id = id0(m0);
    for (const k of Object.keys(MOVE_PRESETS) as (keyof typeof MOVE_PRESETS)[]) {
      const m = setClipMove(m0, id, MOVE_PRESETS[k]);
      expect(movePresetOf(c0(m))).toBe(k);
      valid(m);
    }
    const on = setClipMove(m0, id, MOVE_PRESETS.zoomIn);
    expect(setClipMove(on, id, MOVE_PRESETS.zoomIn)).toBe(on);
    const off = setClipMove(on, id, null);
    expect(c0(off).move).toBeUndefined();
    expect(JSON.stringify(toDoc(off))).toBe(JSON.stringify(toDoc(m0)));
    expect(setClipMove(m0, id, null)).toBe(m0);
  });

  it("one end changes at a time, clamped to the document's range", () => {
    const m0 = base();
    const id = id0(m0);
    let m = setMovePoint(m0, id, "to", { zoom: 99, x: -3, y: 4 });
    expect(moveOf(c0(m))!.to).toEqual({ zoom: 4, x: 0, y: 1 });
    m = setMovePoint(m, id, "from", { zoom: 0 });
    expect(moveOf(c0(m))!.from.zoom).toBe(1);
    m = setMovePoint(m, id, "to", { zoom: Number.NaN });
    expect(moveOf(c0(m))!.to.zoom).toBe(4);   // not a number: the number is left as it was
    expect(movePresetOf(c0(m))).toBeNull();
    valid(m);
  });

  it("a window near the edge is reported as held inside the picture", () => {
    expect(centreHeld({ zoom: 2, x: 0, y: 0.5 })).toBe(true);
    expect(centreHeld({ zoom: 2, x: 0.25, y: 0.75 })).toBe(false);
    expect(centreHeld({ zoom: 1, x: 0.5, y: 0.5 })).toBe(false);
  });

  it("a split carries the move across the cut (the editor's own splitClip)", () => {
    const m = setClipMove(base(), "c1", MOVE_PRESETS.zoomIn);
    const out = splitClip(m, "c1", 5)!;
    const [a, b] = out.model.clips;
    expect(a.move!.to.zoom).toBeCloseTo(1.25);
    expect(b.move!.from.zoom).toBeCloseTo(1.25);
    valid(out.model);
  });
});

describe("an overlay's end position", () => {
  const withOverlay = () => {
    const out = addOverlay(base(), PHOTO, 0, () => false)!;
    return { model: out.model, id: out.id };
  };

  it("turning it on gives a visible move; each end value is dropped when it equals the start; no value left = no move", () => {
    const { model, id } = withOverlay();
    const on = startOverlayMove(model, id);
    const o = on.overlays![0];
    expect(o.move!.to.x).toBe(0.75);
    valid(on);
    expect(startOverlayMove(on, id)).toBe(on);
    const withW = setOverlayEnd(on, id, "w", 0.6);
    expect(withW.overlays![0].move!.to).toEqual({ x: 0.75, w: 0.6 });
    // back to the overlay's own width: that value is not stored
    const sameW = setOverlayEnd(withW, id, "w", withW.overlays![0].w);
    expect(sameW.overlays![0].move!.to).toEqual({ x: 0.75 });
    // x back to its start: nothing moves, so the move goes
    const none = setOverlayEnd(sameW, id, "x", sameW.overlays![0].x);
    expect(none.overlays![0].move).toBeUndefined();
    expect(JSON.stringify(toDoc(none))).toBe(JSON.stringify(toDoc(model)));
  });

  it("end values are clamped to the document's ranges (size from its own minimum)", () => {
    const { model, id } = withOverlay();
    let m = setOverlayEnd(model, id, "w", 0);
    expect(m.overlays![0].move!.to.w).toBe(0.05);
    m = setOverlayEnd(m, id, "opacity", 9);
    expect(m.overlays![0].move!.to.opacity).toBe(1 === m.overlays![0].opacity ? undefined : 1);
    m = setOverlayEnd(m, id, "x", -4);
    expect(m.overlays![0].move!.to.x).toBe(0);
    valid(m);
    expect(clearOverlayMove(m, id).overlays![0].move).toBeUndefined();
  });

  it("the overlay is where the straight line has it at a time; the end defaults to its own values", () => {
    const { model, id } = withOverlay();
    let m = setOverlayEnd(model, id, "x", 0.9);
    m = setOverlayEnd(m, id, "opacity", 0.2);
    const o = m.overlays![0];
    expect(overlayEndOf(o)).toEqual({ x: 0.9, y: o.y, w: o.w, opacity: 0.2 });
    expect(overlayAt(o, o.start_s)).toEqual({ x: o.x, y: o.y, w: o.w, opacity: o.opacity });
    const mid = overlayAt(o, (o.start_s + o.end_s) / 2);
    expect(mid.x).toBeCloseTo((o.x + 0.9) / 2);
    expect(mid.opacity).toBeCloseTo((1 + 0.2) / 2);
    expect(overlayAt(o, o.end_s + 10).x).toBeCloseTo(0.9);
    expect(overlayAt({ ...o, move: undefined }, 1).x).toBe(o.x);
  });

  it("only an opacity change to somewhere other than clear is called slow", () => {
    const { model, id } = withOverlay();
    const mid = setOverlayEnd(model, id, "opacity", 0.5);
    expect(slowOpacityMove(mid.overlays![0])).toBe(true);
    const clear = setOverlayEnd(model, id, "opacity", 0);
    expect(slowOpacityMove(clear.overlays![0])).toBe(false);
    expect(slowOpacityMove(model.overlays![0])).toBe(false);
  });
});

describe("speed, backwards, freeze", () => {
  it("the speed is clamped to the document's range and replaces a curve", () => {
    const m0 = base();
    const id = id0(m0);
    expect(c0(setClipSpeed(m0, id, 99)).speed).toBe(SPEED_MAX);
    expect(c0(setClipSpeed(m0, id, 0)).speed).toBe(SPEED_MIN);
    expect(setClipSpeed(m0, id, 1)).toBe(m0);
    expect(setClipSpeed(m0, id, Number.NaN)).toBe(m0);
    const curved = setClipCurve(m0, id, curveFromSpeeds(CURVE_PRESETS.hero));
    const flat = setClipSpeed(curved, id, 2);
    expect(c0(flat).speed_curve).toBeUndefined();
    expect(clipLength(c0(flat))).toBe(5);
    valid(flat);
  });

  it("backwards is limited by the document's memory cap, and says by how much", () => {
    const long = base();
    const limit = reverseLimit(long);
    // never more than the engine's own number, and a range at it always validates
    expect(limit).toBeLessThanOrEqual(reverseMaxSeconds(long.width, long.height, long.fps));
    expect(limit).toBe(5.733);
    const atLimit = { ...long, clips: [{ ...c0(long), out_s: limit }] };
    valid(atLimit);
    const check = reverseCheck(long, c0(long));
    expect(check).toMatchObject({ ok: false, reason: "too_long", max: limit, range: 10 });
    expect(setClipReverse(long, id0(long), true)).toBe(long);
    const ok = short();
    expect(reverseCheck(ok, c0(ok)).ok).toBe(true);
    const on = setClipReverse(ok, id0(ok), true);
    expect(c0(on).reverse).toBe(true);
    valid(on);
    expect(setClipReverse(on, id0(on), true)).toBe(on);
    expect(c0(setClipReverse(on, id0(on), false)).reverse).toBeUndefined();
  });

  it("freeze: speed 1, no sound, no backwards, no curve, nothing to interpolate or stabilise", () => {
    let m = short();
    const id = id0(m);
    m = setClipSpeed(m, id, 0.5);
    m = setClipInterpolate(m, id, true);
    m = { ...m, clips: [{ ...c0(m), stabilize: true, audio: true }] };
    expect(c0(m).interpolate).toBe(true);
    const f = setClipFreeze(m, id, true);
    expect(c0(f)).toMatchObject({ freeze: true, speed: 1, audio: false });
    expect(c0(f).interpolate).toBeUndefined();
    expect(c0(f).stabilize).toBeUndefined();
    valid(f);
    // the speed and the sound cannot be turned back on while frozen
    expect(setClipSpeed(f, id, 2)).toBe(f);
    expect(setClipAudio(f, id, true)).toBe(f);
    // backwards takes the freeze off
    const r = setClipReverse(f, id, true);
    expect(c0(r)).toMatchObject({ reverse: true });
    expect(c0(r).freeze).toBeUndefined();
    valid(r);
    const back = setClipFreeze(f, id, false);
    expect(c0(back).freeze).toBeUndefined();
  });

  it("a frozen clip lasts the gap between its points, whatever the file's length", () => {
    const m = setClipFreeze(short(), "c1", true);
    expect(clipLength(c0(m))).toBe(4);
    // trimming its end past the file's length is fine (the file only has to reach the start)
    const longer = trimLimited(m, "c1", "out", 30, 10);
    expect(c0(longer).out_s).toBe(30);
    valid(longer);
    // its start cannot go past the file
    const late = trimLimited(m, "c1", "in", 50, 10);
    expect(c0(late).in_s).toBeLessThan(10);
  });

  it("the preview's source time follows backwards play and holds a frozen frame", () => {
    const m = setClipReverse(short(), "c1", true);
    const c = c0(m);
    expect(sourceTimeAt(c, c.start_s)).toBe(c.out_s);
    expect(sourceTimeAt(c, c.start_s + 1)).toBe(c.out_s - 1);
    const z = setClipFreeze(short(), "c1", true);
    expect(sourceTimeAt(c0(z), 2)).toBe(c0(z).in_s);
    expect(sourceTimeAt(c0(short()), 1)).toBe(1);
  });

  it("splitting backwards or frozen clips keeps the picture continuous (and stays valid)", () => {
    const r = setClipReverse(short(), "c1", true);
    const out = splitClip(r, "c1", 1)!;
    const [a, b] = out.model.clips;
    // the part that comes first plays the LATER part of the source: the halves meet at one source time
    expect(a.in_s).toBe(b.out_s);
    expect(a.out_s).toBe(4);
    expect(b.in_s).toBe(0);
    expect(a.reverse && b.reverse).toBe(true);
    valid(out.model);
    const z = setClipFreeze(short(), "c1", true);
    const sz = splitClip(z, "c1", 1)!;
    expect(sz.model.clips[0].in_s).toBe(sz.model.clips[1].in_s);
    valid(sz.model);
  });

  it("freeze frame at the playhead: split, a held clip between, everything after moved", () => {
    const m = base();
    const out = freezeAtPlayhead(m, "c1", 4)!;
    expect(out.model.clips).toHaveLength(3);
    const [a, held, b] = out.model.clips;
    expect(held).toMatchObject({ freeze: true, speed: 1, audio: false, in_s: 4, out_s: 6 });
    expect(a.out_s).toBe(4);
    expect(b.in_s).toBe(4);
    expect(held.start_s).toBe(4);
    expect(b.start_s).toBe(6);
    expect(held.id).toBe(out.newId);
    valid(out.model);
    // not at an edge, not on a curve or backwards, not without room
    expect(freezeAtPlayhead(m, "c1", 0)).toBeNull();
    expect(freezeAtPlayhead(setClipReverse(short(), "c1", true), "c1", 1)).toBeNull();
    const curved = setClipCurve(m, "c1", curveFromSpeeds(CURVE_PRESETS.hero));
    expect(freezeAtPlayhead(curved, "c1", 1)).toBeNull();
    let full = m;
    while (full.clips.length < MAX_EDITOR_CLIPS - 1) full = addClip(full, VIDEO);
    expect(freezeAtPlayhead(full, full.clips[0].id, 2)).toBeNull();
  });

  it("the held frame looks like its clip (fit, effects) but has no sound or transition", () => {
    const m = base();
    const styled = { ...m, clips: [{ ...c0(m), fit: "blur" as const, filter: "warm" as const, audio: true, fade_out_s: 1 }] };
    const out = freezeAtPlayhead(styled, "c1", 4)!;
    const held = out.model.clips[1];
    expect(held).toMatchObject({ fit: "blur", filter: "warm", audio: false });
    expect(held.fade_out_s).toBeUndefined();
    valid(out.model);
  });
});

describe("speed curve", () => {
  it("turning it on replaces speed, backwards and freeze; turning it off is a constant 1", () => {
    let m = short();
    const id = id0(m);
    m = setClipReverse(setClipSpeed(m, id, 2), id, true);
    const on = setClipCurve(m, id, curveFromSpeeds(CURVE_PRESETS.slowEnd));
    expect(c0(on)).toMatchObject({ speed: 1 });
    expect(c0(on).reverse).toBeUndefined();
    expect(curveOf(c0(on))).toHaveLength(3);
    valid(on);
    expect(canSplit(on, id, 1)).toBe(false);
    const off = setClipCurve(on, id, null);
    expect(c0(off).speed_curve).toBeUndefined();
    expect(c0(off).speed).toBe(1);
    expect(setClipCurve(off, id, null)).toBe(off);
    valid(off);
  });

  it("a curve that breaks the rules is refused; speeds are brought into range", () => {
    const m = base();
    const id = id0(m);
    expect(setClipCurve(m, id, [{ at: 0, speed: 1 }])).toBe(m);
    expect(setClipCurve(m, id, [{ at: 0, speed: 1 }, { at: 0.005, speed: 1 }, { at: 1, speed: 1 }])).toBe(m);
    const many = Array.from({ length: RAMP_MAX_POINTS + 1 }, (_, i) => ({ at: i / RAMP_MAX_POINTS, speed: 1 }));
    expect(setClipCurve(m, id, many)).toBe(m);
    const wild = setClipCurve(m, id, [{ at: 0.2, speed: 99 }, { at: 0.7, speed: 0 }]);
    expect(curveOf(c0(wild))).toEqual([{ at: 0, speed: SPEED_MAX }, { at: 1, speed: SPEED_MIN }]);
    valid(wild);
  });

  it("points: the ends stay at 0 and 1, interior points keep their gaps, add and remove work within the limits", () => {
    let m = setClipCurve(base(), "c1", curveFromSpeeds(CURVE_PRESETS.hero));
    expect(curveOf(c0(m))).toEqual([{ at: 0, speed: 1 }, { at: 0.5, speed: 0.25 }, { at: 1, speed: 1 }]);
    expect(setCurvePoint(m, "c1", 0, { at: 0.3 })).toBe(m);
    m = setCurvePoint(m, "c1", 1, { at: 5, speed: 2 });
    expect(curveOf(c0(m))![1]).toEqual({ at: 1 - RAMP_MIN_GAP, speed: 2 });
    m = setCurvePoint(m, "c1", 1, { at: 0.4 });
    while (canAddCurvePoint(c0(m))) m = addCurvePoint(m, "c1");
    expect(curveOf(c0(m))).toHaveLength(RAMP_MAX_POINTS);
    expect(addCurvePoint(m, "c1")).toBe(m);
    valid(m);
    while (curveOf(c0(m))!.length > RAMP_MIN_POINTS) m = removeCurvePoint(m, "c1", 1);
    expect(removeCurvePoint(m, "c1", 1)).toBe(m);
    expect(removeCurvePoint(m, "c1", 0)).toBe(m);
    valid(m);
  });

  it("a curve's length is the document's (ramp integral), and the slowest point decides slow motion", () => {
    const m = setClipCurve(short(), "c1", [{ at: 0, speed: 1 }, { at: 0.5, speed: 4 }, { at: 1, speed: 0.5 }]);
    // the doc's own example: 2.112 s for a 4 s range
    expect(clipLength(c0(m))).toBeCloseTo(2.112, 2);
    expect(slowestSpeed(c0(m))).toBe(0.5);
    expect(slowestSpeed(c0(base()))).toBe(1);
  });
});

describe("smoother slow motion (interpolation) and its budget", () => {
  const slow = (range = 4, speed = 0.5): EditorModel => {
    const m = base();
    return setClipSpeed({ ...m, clips: [{ ...c0(m), out_s: range }] }, "c1", speed);
  };

  it("needs a part below normal speed and a forward, unfrozen clip", () => {
    const fast = base();
    expect(interpolateCheck(fast, c0(fast))).toMatchObject({ ok: false, reason: "not_slow" });
    const m = slow();
    expect(interpolateCheck(m, c0(m)).ok).toBe(true);
    const rev = setClipReverse(m, "c1", true);
    expect(interpolateCheck(rev, c0(rev)).ok).toBe(false);
    const on = setClipInterpolate(m, "c1", true);
    expect(c0(on).interpolate).toBe(true);
    valid(on);
    // making it faster than normal drops it (the document refuses interpolation there)
    const faster = setClipSpeed(on, "c1", 2);
    expect(c0(faster).interpolate).toBeUndefined();
    valid(faster);
    // a curve with a slow part counts too
    const curved = setClipCurve(base(), "c1", curveFromSpeeds(CURVE_PRESETS.hero));
    expect(interpolateCheck(curved, c0(curved)).ok).toBe(false); // 10 s is over budget
  });

  it("a range over the per-clip budget is refused with the longest range that fits", () => {
    const m = slow(10, 0.5);
    const r = interpolateCheck(m, c0(m));
    expect(r).toMatchObject({ ok: false, reason: "clip_budget" });
    if (r.ok || r.reason !== "clip_budget") throw new Error("budget");
    expect(r.frames).toBeGreaterThan(INTERP_MAX_FRAMES);
    expect(r.maxS).toBe(interpolateMaxSeconds(m, 0.5));
    // 0.5x at 30 fps, 1080p: 60 frames per second -> 300 frames = 5 s (the doc's example)
    expect(r.maxS).toBe(5);
    expect(setClipInterpolate(m, "c1", true)).toBe(m);
    // at 720p the same budget reaches further
    expect(interpolateMaxSeconds({ fps: 30, width: 1280, height: 720 }, 0.5)).toBe(11.2);
  });

  const LONGV: EditorAsset = { ...VIDEO, durationS: 300 };
  /** A project with a long plain clip first, so the export has time for slow work. */
  const roomy = (): EditorModel => addClip(base(), LONGV);
  const slowClip = (m: EditorModel, range: number, speed: number): EditorModel => {
    const m2 = addClip(m, VIDEO);
    const last = m2.clips[m2.clips.length - 1];
    return {
      ...m2,
      clips: m2.clips.map((c) => (c.id === last.id ? { ...c, out_s: range, speed } : c)),
    };
  };

  it("the project's frame budget is shared: a third clip is refused when two used it up", () => {
    let m = roomy();
    for (let i = 0; i < 3; i += 1) {
      m = slowClip(m, 5, 0.5);
      const last = m.clips[m.clips.length - 1];
      if (i < 2) m = setClipInterpolate(m, last.id, true);
    }
    // two clips use 300 + 300 of the project's 600: the third has nothing left
    expect(m.clips.filter((c) => c.interpolate)).toHaveLength(2);
    const third = m.clips[m.clips.length - 1];
    expect(interpolateCheck(m, third)).toMatchObject({ ok: false, reason: "doc_budget" });
    expect(setClipInterpolate(m, third.id, true)).toBe(m);
  });

  it("the export's time allowance is shared too: slow work on a short timeline is refused with the estimate", () => {
    // two clips of 300 frames each on a 20 s timeline: 20 + 0.4 x 600 = 260 s against 3 x 20 + 120 = 180 s
    let m = slowClip(slowClip(base(), 5, 0.5), 5, 0.5);
    m = { ...m, clips: m.clips.slice(1) };
    const first = m.clips[0];
    const on = setClipInterpolate(m, first.id, true);
    expect(on.clips[0].interpolate).toBe(true);
    const r = interpolateCheck(on, on.clips[1]);
    expect(r).toMatchObject({ ok: false, reason: "render_time" });
    if (r.ok || !r.render) throw new Error("render");
    expect(r.render.length).toBe(20);
    expect(r.render.work).toBeCloseTo(20 + INTERP_SECONDS_PER_FRAME * 600, 6);
    expect(r.render.allowed).toBe(renderTimeoutS(20));
    expect(setClipInterpolate(on, on.clips[1].id, true)).toBe(on);
    // a longer timeline has the time
    const longer = addClip(on, LONGV);
    expect(interpolateCheck(longer, longer.clips[1]).ok).toBe(true);
    // renderWork is the validator's rule
    expect(renderWork(base()).ok).toBe(true);
    expect(renderWork(on).ok).toBe(true);
    const both = { ...on, clips: on.clips.map((c, i) => (i === 1 ? { ...c, interpolate: true } : c)) };
    expect(renderWork(both).ok).toBe(false);
    expect(validateTimeline(toDoc(both)).join(" ")).toContain("would take about");
  });

  it("steadying counts against the same allowance, weighted by frame size", () => {
    let m = base();
    m = { ...m, clips: [{ ...c0(m), stabilize: true }] };
    expect(renderWork(m).stabEst).toBeCloseTo(stabilizeSeconds(c0(m) as never, 30, 1920, 1080), 6);
    // a longer slow part makes a short timeline fail, and the model says so
    const forty = { ...m, clips: [{ ...c0(m), out_s: 40, stabilize: true }] };
    expect(renderWork(forty).ok).toBe(true);
    const slowDown = setClipSpeed(forty, "c1", 4);
    // 4x: the timeline shrinks to 10 s (allowed 150 s), 40 s of steadying needs about 181 s: it is switched off
    expect(c0(slowDown).stabilize).toBeUndefined();
    valid(slowDown);
  });

  it("changing a clip that smooths slow motion drops the smoothing when the allowance no longer fits", () => {
    let m = slowClip(slowClip(roomy(), 5, 0.5), 5, 0.5);
    const a = m.clips[2].id;
    const b = m.clips[3].id;
    m = setClipInterpolate(setClipInterpolate(m, a, true), b, true);
    expect(m.clips.filter((c) => c.interpolate)).toHaveLength(2);
    expect(renderWork(m).ok).toBe(true);
    // shorten the long clip: 600 frames cost 240 s, the allowance falls to 3 x length + 120
    const short = { ...m, clips: m.clips.map((c, i) => (i === 1 ? { ...c, out_s: 1 } : c)) };
    expect(renderWork(short).ok).toBe(false);
    // the panel's notice says so with the validator's numbers
    expect(validateTimeline(toDoc(short)).join(" ")).toContain("would take about");
    // an edit of one of the two re-settles it: that clip's smoothing goes, the document is valid again
    const settled = setClipSpeed(short, b, 0.75);
    expect(settled.clips[3].interpolate).toBeUndefined();
    expect(settled.clips[2].interpolate).toBe(true);
    valid(settled);
  });

  it("interpolation is not offered above 1440p, whatever the length", () => {
    const m = { ...slowClip(roomy(), 2, 0.5), width: 3840, height: 2160 };
    const last = m.clips[m.clips.length - 1];
    expect(interpolateCheck(m, last)).toMatchObject({ ok: false, reason: "frame_size" });
    expect(setClipInterpolate(m, last.id, true)).toBe(m);
    const p1440 = { ...m, width: 2560, height: 1440 };
    expect(interpolateCheck(p1440, p1440.clips[p1440.clips.length - 1]).ok).toBe(true);
  });

  it("trimming a clip that interpolates stops where the export's allowance is used up", () => {
    // 20 s of long clip, then a slow clip: 0.4 s per frame limits how much of it fits
    let m = slowClip(addClip(base(), { ...VIDEO, durationS: 20 }), 3, 0.5);
    const id = m.clips[m.clips.length - 1].id;
    m = setClipInterpolate(m, id, true);
    expect(m.clips[m.clips.length - 1].interpolate).toBe(true);
    const t = trimLimited(m, id, "out", 10, 10);
    const got = t.clips[t.clips.length - 1];
    expect(got.out_s).toBeGreaterThanOrEqual(3);
    expect(renderWork(t).ok).toBe(true);
    valid(t);
  });

  it("trimming stops at what the clip's own settings allow (backwards, interpolation)", () => {
    const rev = setClipReverse(short(), "c1", true);
    const cap = reverseLimit(rev);
    const trimmed = trimLimited(rev, "c1", "out", 10, 10);
    expect(c0(trimmed).out_s).toBeCloseTo(cap, 3);
    valid(trimmed);
    const fromIn = trimLimited({ ...rev, clips: [{ ...c0(rev), in_s: 4, out_s: 8 }] }, "c1", "in", 0, 10);
    expect(c0(fromIn).out_s - c0(fromIn).in_s).toBeLessThanOrEqual(cap + 1e-9);
    valid(fromIn);
    const m = setClipInterpolate(slow(4, 0.5), "c1", true);
    expect(maxRangeFor(m, c0(m))).toBe(5);
    const t2 = trimLimited(m, "c1", "out", 10, 10);
    expect(c0(t2).out_s).toBe(5);
    valid(t2);
    // a plain clip is not limited by any of it
    const plain = base();
    expect(maxRangeFor(plain, c0(plain))).toBe(Number.POSITIVE_INFINITY);
    expect(c0(trimLimited(plain, "c1", "out", 7, 10)).out_s).toBe(7);
    expect(trimLimited(plain, "nope", "out", 7, 10)).toBe(plain);
  });
});

describe("zoom on a cross-faded clip in a frame above 1440p", () => {
  const two = (w: number, h: number, fade = true): EditorModel => {
    let m = addClip(base(), VIDEO);
    m = { ...m, width: w, height: h };
    return fade ? setCrossfade(m, m.clips[1].id, 1) : m;
  };
  it("is held to the document's own cap on either side of the blend, and free otherwise", () => {
    const big = two(3840, 2160);
    expect(XFADE_LARGE_ZOOM_MAX).toBe(2);
    expect(zoomLimit(big, big.clips[0].id)).toBe(XFADE_LARGE_ZOOM_MAX);
    expect(zoomLimit(big, big.clips[1].id)).toBe(XFADE_LARGE_ZOOM_MAX);
    const m = setMovePoint(big, big.clips[0].id, "to", { zoom: 4 });
    expect(moveOf(m.clips[0])!.to.zoom).toBe(XFADE_LARGE_ZOOM_MAX);
    valid(m);
    // a cut, a smaller frame, or a clip away from the blend zoom to the full range
    const cut = two(3840, 2160, false);
    expect(zoomLimit(cut, cut.clips[0].id)).toBe(MOVE_ZOOM_MAX);
    const small = two(1920, 1080);
    expect(moveOf(setMovePoint(small, small.clips[0].id, "to", { zoom: 4 }).clips[0])!.to.zoom).toBe(MOVE_ZOOM_MAX);
    const three = addClip(big, VIDEO);
    expect(zoomLimit(three, three.clips[2].id)).toBe(MOVE_ZOOM_MAX);
  });
});

describe("overlays that move between two visible opacities (at most a few)", () => {
  const overlays = (n: number) => {
    let m = base();
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const out = addOverlay(m, PHOTO, 0, () => false)!;
      m = out.model;
      ids.push(out.id);
    }
    return { m, ids };
  };
  it("the allowance is the document's; a fade to or from clear never uses it", () => {
    expect(MAX_PARTIAL_OPACITY_MOVES).toBe(2);
    const { m, ids } = overlays(MAX_PARTIAL_OPACITY_MOVES + 1);
    let cur = m;
    for (const id of ids.slice(0, 2)) cur = setOverlayEnd(cur, id, "opacity", 0.5);
    expect(partialMovesElsewhere(cur, ids[2])).toBe(2);
    expect(canPartialOpacity(cur, ids[2])).toBe(false);
    expect(canPartialOpacity(cur, ids[0])).toBe(true);
    // the third cannot be given a partial opacity ...
    expect(setOverlayEnd(cur, ids[2], "opacity", 0.4)).toBe(cur);
    // ... but may fade to clear
    const faded = setOverlayEnd(cur, ids[2], "opacity", 0);
    expect(faded.overlays![2].move!.to.opacity).toBe(0);
    expect(partialOpacityMove(faded.overlays![2])).toBe(false);
    valid(faded);
    // one that already has it can change it
    expect(setOverlayEnd(cur, ids[0], "opacity", 0.2)).not.toBe(cur);
    valid(cur);
    expect((cur.overlays ?? []).filter(partialOpacityMove)).toHaveLength(2);
  });
  it("changing an overlay's own opacity cannot make a third one (the move's opacity end goes, its other ends stay)", () => {
    const { m, ids } = overlays(3);
    let cur = m;
    for (const id of ids.slice(0, 2)) cur = setOverlayEnd(cur, id, "opacity", 0.5);
    // an imported third overlay: its opacity end equals its own (not a partial move yet), and it also moves sideways
    cur = {
      ...cur,
      overlays: cur.overlays!.map((o) => (o.id === ids[2] ? { ...o, opacity: 0.6, move: { to: { opacity: 0.6, x: 0.8 } } } : o)),
    };
    expect(partialOpacityMove(cur.overlays![2])).toBe(false);
    const changed = updateOverlay(cur, ids[2], { opacity: 0.9 });
    expect(changed.overlays![2].opacity).toBe(0.9);
    expect(changed.overlays![2].move).toEqual({ to: { x: 0.8 } });
    expect((changed.overlays ?? []).filter(partialOpacityMove)).toHaveLength(2);
    valid(changed);
    // with room it is allowed (one of the others is not partial)
    const roomy = setOverlayEnd(cur, ids[0], "opacity", 0);
    expect(updateOverlay(roomy, ids[2], { opacity: 0.9 }).overlays![2].move).toEqual({ to: { opacity: 0.6, x: 0.8 } });
  });
});
