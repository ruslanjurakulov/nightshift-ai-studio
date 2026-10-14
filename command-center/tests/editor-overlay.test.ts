/**
 * Picture overlays: the document's validation (judged on the shared cases in
 * the other test file; here the rules that need more than a verdict), the pure
 * model edits, the round trip through toModel / toDoc, and the preview
 * geometry pinned to the fixture the Python parity test measures a real
 * ffmpeg export against (samples/overlay_preview.json,
 * tests/test_editor_overlay.py).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_OVERLAYS,
  MAX_OVERLAY_VIDEOS,
  addClip,
  addText,
  appendAssetToDoc,
  docAssetIds,
  docAssetProblems,
  freshId,
  modelDuration,
  newDocForAsset,
  removeClip,
  setClipAudio,
  splitClip,
  toDoc,
  toModel,
  validateTimeline,
  type EditorModel,
  type PictureOverlay,
  type TimelineDoc,
} from "@/lib/editor";
import {
  OVERLAY_DEFAULT_S,
  OVERLAY_RANGES,
  addOverlay,
  canAddOverlay,
  moveOverlay,
  nudgeOverlay,
  overlayById,
  overlayLength,
  overlayPreviewStyle,
  overlayRect,
  overlayWarnings,
  overlaysAt,
  removeOverlay,
  resetOverlay,
  updateOverlay,
} from "@/lib/editorOverlay";

const A = "11111111-1111-4111-8111-111111111111";
const PIC = "33333333-3333-4333-8333-333333333333";
const VID = "44444444-4444-4444-8444-444444444444";
const fixture = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "samples", "overlay_preview.json"),
    "utf8",
  ),
);

/** A 10 s video, laid out as the editor does. */
const base = (): EditorModel =>
  toModel(newDocForAsset({ id: A, durationS: 10, width: 1920, height: 1080 })!);
const image = { id: PIC, kind: "image", durationS: null } as const;
const video = { id: VID, kind: "video", durationS: 6 } as const;
const withOverlay = (m = base(), at = 1) => addOverlay(m, image, at)!;

describe("the preview geometry is the fixture the export is measured against", () => {
  it("overlayRect reproduces every fixture case", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
    for (const c of fixture.cases) {
      const r = overlayRect(c.overlay, c.frame, c.asset.width / c.asset.height);
      for (const k of ["left", "top", "width", "height"] as const)
        expect(r[k]).toBeCloseTo(c.rect[k], 6);
    }
  });

  it("is a centred box of w of the frame, whatever the resolution", () => {
    const o = { x: 0.25, y: 0.75, w: 0.4 };
    const small = overlayRect(o, { width: 640, height: 360 }, 2);
    const big = overlayRect(o, { width: 3840, height: 2160 }, 2);
    for (const k of ["left", "top", "width", "height"] as const)
      expect(big[k] / 6).toBeCloseTo(small[k], 6);
    expect(small.left + small.width / 2).toBeCloseTo(0.25 * 640, 9);
    expect(small.top + small.height / 2).toBeCloseTo(0.75 * 360, 9);
  });

  it("the preview style is the same fractions in percent, centred", () => {
    const s = overlayPreviewStyle({ x: 0.25, y: 0.75, w: 0.4, opacity: 0.5 });
    expect(s).toMatchObject({
      position: "absolute",
      left: "25%",
      top: "75%",
      width: "40%",
      height: "auto",
      transform: "translate(-50%, -50%)",
      opacity: 0.5,
    });
    expect(s.pointerEvents).toBe("none");
    // no pixel unit anywhere: it fits any preview size
    expect(JSON.stringify(s)).not.toMatch(/px/);
  });
});

describe("validation (beyond the shared cases)", () => {
  const doc = (overlays: unknown): TimelineDoc =>
    ({ ...newDocForAsset({ id: A, durationS: 10, width: 1920, height: 1080 })!, overlays }) as TimelineDoc;
  const ov = (extra: Record<string, unknown> = {}) => ({
    id: "o1",
    asset_id: PIC,
    start_s: 1,
    end_s: 3,
    ...extra,
  });

  it("accepts every range at both ends and refuses just outside", () => {
    const ranges: Record<string, [number, number]> = {
      x: [0, 1],
      y: [0, 1],
      opacity: [0, 1],
      w: [0.05, 1],
    };
    for (const [k, [lo, hi]] of Object.entries(ranges)) {
      for (const good of [lo, hi, (lo + hi) / 2])
        expect(validateTimeline(doc([ov({ [k]: good })]))).toEqual([]);
      for (const bad of [lo - 0.001, hi + 0.001, lo - 5, hi + 5, NaN, Infinity])
        expect(validateTimeline(doc([ov({ [k]: bad })])).length).toBeGreaterThan(0);
    }
  });

  it("counts frames the way Python's round() does when a time is exactly half a frame", () => {
    // 50 fps: 0.01 s = 0.5 frames (Python rounds to 0), 0.03 = 1.5 (to 2), 0.05 = 2.5 (to 2)
    const at50 = (s: number, e: number) =>
      validateTimeline({ ...doc([ov({ start_s: s, end_s: e })]), fps: 50 });
    expect(at50(0, 0.01)).toContain("overlay o1: shorter than one frame");
    expect(at50(0.03, 0.05)).toContain("overlay o1: shorter than one frame");
    expect(at50(0.01, 0.03)).toEqual([]);
    expect(
      validateTimeline(doc([ov({ start_s: 1, end_s: 1.01 })])),
    ).toContain("overlay o1: shorter than one frame");
    expect(validateTimeline(doc([ov({ start_s: 1, end_s: 1.034 })]))).toEqual([]);
  });

  it("refuses a list over the cap without reading its elements", () => {
    const many = Array.from({ length: 200_000 }, (_, i) => ov({ id: `o${i}` }));
    const t0 = Date.now();
    const problems = validateTimeline(doc(many));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(problems.filter((p) => /at most 16/.test(p))).toHaveLength(1);
    expect(problems.length).toBeLessThan(5);
  });

  it("does not let overlays lengthen the timeline or fill an empty one", () => {
    expect(modelDuration({ ...base(), overlays: [{ ...ov(), x: 0.5, y: 0.5, w: 0.3, opacity: 1, end_s: 99 } as PictureOverlay] })).toBe(10);
    const empty = doc([ov()]);
    empty.tracks[0].clips = [];
    expect(validateTimeline(empty)).toContain("timeline: nothing to render");
  });
});

describe("assets", () => {
  const doc = (list: unknown[]): TimelineDoc =>
    ({ ...newDocForAsset({ id: A, durationS: 10, width: 1920, height: 1080 })!, overlays: list }) as TimelineDoc;
  const o = (id: string, asset: string) => ({ id, asset_id: asset, start_s: 0, end_s: 1 });

  it("an overlay's file is one of the document's files (lower-case, once)", () => {
    expect(docAssetIds(doc([o("o1", PIC.toUpperCase()), o("o2", A)]))).toEqual(
      [A, PIC].sort(),
    );
  });

  it("takes a picture or a video, never a sound, and at most four videos", () => {
    const kinds = { [A]: "video", [PIC]: "image", [VID]: "video", s: "audio" };
    expect(docAssetProblems(doc([o("o1", PIC), o("o2", VID)]), kinds)).toEqual([]);
    const snd = "55555555-5555-4555-8555-555555555555";
    expect(
      docAssetProblems(doc([o("o1", snd)]), { ...kinds, [snd]: "audio" }).join(),
    ).toMatch(/an overlay takes video or image, not audio/);
    const four = [1, 2, 3, 4].map((i) => o(`o${i}`, VID));
    expect(docAssetProblems(doc(four), kinds)).toEqual([]);
    expect(
      docAssetProblems(doc([...four, o("o5", VID)]), kinds).join(),
    ).toMatch(/at most 4 video overlays/);
    expect(MAX_OVERLAY_VIDEOS).toBe(4);
  });

  it("an overlay file the caller cannot read is not available", () => {
    expect(
      docAssetProblems(doc([o("o1", PIC)]), { [A]: "video" }).join(),
    ).toContain(`asset ${PIC} is not available`);
  });
});

describe("the document round trip (toModel / toDoc)", () => {
  it("a document without overlays is the document it was", () => {
    const d = newDocForAsset({ id: A, durationS: 10, width: 1920, height: 1080 })!;
    const out = toDoc(toModel(d));
    expect(out).toEqual(toDoc(toModel(out)));
    expect("overlays" in out).toBe(false);
    expect("overlays" in toModel(d)).toBe(false);
    expect(JSON.stringify(toDoc(base()))).toBe(JSON.stringify(toDoc(toModel(toDoc(base())))));
  });

  it("overlays survive the model and back, defaults filled, order kept", () => {
    let m = withOverlay().model;
    m = addOverlay(m, { id: A, kind: "image", durationS: null }, 2)!.model;
    m = updateOverlay(m, "o1", { x: 0.2, opacity: 0.4 });
    const doc = toDoc(m);
    expect(doc.overlays).toHaveLength(2);
    expect(validateTimeline(doc)).toEqual([]);
    expect(toDoc(toModel(doc))).toEqual(doc);
    expect(toModel(doc).overlays).toEqual(m.overlays);
    // a document that leaves the optional fields out gets the defaults in the model
    const sparse = {
      ...doc,
      overlays: [{ id: "o1", asset_id: PIC, start_s: 0, end_s: 2 }],
    } as TimelineDoc;
    expect(toModel(sparse).overlays).toEqual([
      { id: "o1", asset_id: PIC, start_s: 0, end_s: 2, x: 0.5, y: 0.5, w: 0.3, opacity: 1 },
    ]);
    expect(validateTimeline(toDoc(toModel(sparse)))).toEqual([]);
  });

  it("keeps them through every other edit the editor makes", () => {
    let m = withOverlay().model;
    const before = m.overlays;
    m = addClip(m, { id: PIC, durationS: 3 });
    m = setClipAudio(m, m.clips[0].id, false);
    m = splitClip(m, m.clips[0].id, 4)!.model;
    m = addText(m, 1, "Hi")!.model;
    m = removeClip(m, m.clips[1].id);
    expect(m.overlays).toEqual(before);
    expect(toDoc(m).overlays).toHaveLength(1);
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });

  it("keeps them when a file is appended to a saved project (send to editor)", () => {
    const doc = toDoc(withOverlay().model);
    const out = appendAssetToDoc(doc, { id: VID, kind: "video", durationS: 4 });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.doc.overlays).toEqual(doc.overlays);
      expect(out.doc.tracks[0].clips).toHaveLength(2);
    }
  });

  it("an overlay id never collides with a clip, text or sound id or a track id", () => {
    let m = base();
    m = addText(m, 0, "t")!.model;
    const ids = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const r = addOverlay(m, image, 0)!;
      m = r.model;
      ids.add(r.id);
    }
    expect(ids.size).toBe(6);
    const doc = toDoc(m);
    const all = [
      ...doc.tracks.flatMap((t) => [t.id, ...t.clips.map((c) => String(c.id))]),
      ...(doc.overlays as { id: string }[]).map((x) => x.id),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(validateTimeline(doc)).toEqual([]);
    // an id a foreign tool gave an overlay is avoided by the next fresh one
    const odd: EditorModel = { ...base(), overlays: [{ ...withOverlay().model.overlays![0], id: "t1" }] };
    const withText = addText(odd, 0, "x")!.model;
    expect(validateTimeline(toDoc(withText))).toEqual([]);
    expect(freshId(odd, "o")).not.toBe("t1");
  });
});

describe("adding", () => {
  it("starts at the playhead, in the middle, a third wide, opaque, and is valid", () => {
    const r = addOverlay(base(), image, 2)!;
    expect(r.model.overlays).toEqual([
      {
        id: r.id,
        asset_id: PIC,
        start_s: 2,
        end_s: 2 + OVERLAY_DEFAULT_S,
        x: 0.5,
        y: 0.5,
        w: 0.3,
        opacity: 1,
      },
    ]);
    expect(validateTimeline(toDoc(r.model))).toEqual([]);
  });

  it("is cut short where the picture ends and never starts past it", () => {
    const near = addOverlay(base(), image, 8)!.model.overlays![0];
    expect([near.start_s, near.end_s]).toEqual([8, 10]);
    const past = addOverlay(base(), image, 99)!.model.overlays![0];
    expect(past.start_s).toBeCloseTo(9.9, 6);
    expect(past.end_s).toBeCloseTo(10, 6);
    expect(overlayLength(past)).toBeGreaterThanOrEqual(0.1 - 1e-9);
    const early = addOverlay(base(), image, -3)!.model.overlays![0];
    expect(early.start_s).toBe(0);
  });

  it("a video overlay is no longer than the video", () => {
    const o = addOverlay(base(), { ...video, durationS: 2.5 }, 0)!.model.overlays![0];
    expect(overlayLength(o)).toBe(2.5);
    const long = addOverlay(base(), video, 0)!.model.overlays![0];
    expect(overlayLength(long)).toBe(OVERLAY_DEFAULT_S);
  });

  it("refuses a sound, a video of unknown length, and the sixteenth + one", () => {
    expect(addOverlay(base(), { id: PIC, kind: "audio", durationS: 5 }, 0)).toBeNull();
    expect(addOverlay(base(), { ...video, durationS: null }, 0)).toBeNull();
    expect(addOverlay(base(), { ...video, durationS: 0 }, 0)).toBeNull();
    let m = base();
    for (let i = 0; i < MAX_OVERLAYS; i += 1) m = addOverlay(m, image, 0)!.model;
    expect(m.overlays).toHaveLength(MAX_OVERLAYS);
    expect(canAddOverlay(m, "image")).toBe(false);
    expect(addOverlay(m, image, 0)).toBeNull();
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });

  it("counts video overlays when told which ones they are", () => {
    let m = base();
    const isVideo = (id: string) => id === VID;
    for (let i = 0; i < MAX_OVERLAY_VIDEOS; i += 1)
      m = addOverlay(m, video, 0, isVideo)!.model;
    expect(canAddOverlay(m, "video", isVideo)).toBe(false);
    expect(addOverlay(m, video, 0, isVideo)).toBeNull();
    expect(canAddOverlay(m, "image", isVideo)).toBe(true);
  });
});

describe("changing", () => {
  it("keeps every number inside its range, to three decimals", () => {
    const { model, id } = withOverlay();
    const m = updateOverlay(model, id, { x: 9, y: -9, w: 0.001, opacity: 7 });
    expect(overlayById(m, id)).toMatchObject({ x: 1, y: 0, w: 0.05, opacity: 1 });
    const m2 = updateOverlay(model, id, { x: 0.123456, w: 5 });
    expect(overlayById(m2, id)).toMatchObject({ x: 0.123, w: 1 });
    const bad = updateOverlay(model, id, { x: NaN, opacity: Infinity });
    expect(overlayById(bad, id)).toMatchObject({ x: 0.5, opacity: 1 });
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });

  it("returns the same model when nothing changes (not an undo step)", () => {
    const { model, id } = withOverlay();
    expect(updateOverlay(model, id, { x: 0.5 })).toBe(model);
    expect(updateOverlay(model, id, {})).toBe(model);
    expect(updateOverlay(model, "nope", { x: 0.1 })).toBe(model);
    expect(resetOverlay(model, id)).toBe(model);
    expect(nudgeOverlay(model, id, 0, 0)).toBe(model);
  });

  it("a new start slides the span; a new end changes its length; both set both", () => {
    const { model, id } = withOverlay(base(), 1);
    const o = overlayById(model, id)!;
    const slid = overlayById(updateOverlay(model, id, { start_s: 3 }), id)!;
    expect([slid.start_s, overlayLength(slid)]).toEqual([3, overlayLength(o)]);
    const longer = overlayById(updateOverlay(model, id, { end_s: 8 }), id)!;
    expect([longer.start_s, longer.end_s]).toEqual([1, 8]);
    const both = overlayById(updateOverlay(model, id, { start_s: 2, end_s: 4 }), id)!;
    expect([both.start_s, both.end_s]).toEqual([2, 4]);
    const tiny = overlayById(updateOverlay(model, id, { end_s: 1.001 }), id)!;
    expect(overlayLength(tiny)).toBeCloseTo(0.1, 6);
    const neg = overlayById(updateOverlay(model, id, { start_s: -4 }), id)!;
    expect(neg.start_s).toBe(0);
  });

  it("a video overlay cannot be made longer than its video", () => {
    const { model, id } = addOverlay(base(), video, 0)!;
    const m = updateOverlay(model, id, { end_s: 9 }, 6);
    expect(overlayLength(overlayById(m, id)!)).toBe(6);
    const slid = updateOverlay(model, id, { start_s: 4 }, 6);
    expect(overlayById(slid, id)!.end_s).toBe(9);
  });

  it("Reset returns position, size and opacity and keeps the span and the file", () => {
    const { model, id } = withOverlay();
    const moved = updateOverlay(model, id, { x: 0.1, y: 0.9, w: 0.8, opacity: 0.2, start_s: 3 });
    const back = resetOverlay(moved, id);
    expect(overlayById(back, id)).toMatchObject({ x: 0.5, y: 0.5, w: 0.3, opacity: 1, start_s: 3, asset_id: PIC });
    expect(JSON.stringify(toDoc(resetOverlay(updateOverlay(model, id, { x: 0.1 }), id)))).toBe(
      JSON.stringify(toDoc(model)),
    );
  });

  it("nudges by whole steps and stops at the frame's edge", () => {
    const { model, id } = withOverlay();
    const right = nudgeOverlay(model, id, 1, 0);
    expect(overlayById(right, id)!.x).toBeCloseTo(0.5 + OVERLAY_RANGES.x.step, 9);
    const up = nudgeOverlay(model, id, 0, -3);
    expect(overlayById(up, id)!.y).toBeCloseTo(0.5 - 3 * OVERLAY_RANGES.y.step, 9);
    let m = model;
    for (let i = 0; i < 80; i += 1) m = nudgeOverlay(m, id, -1, 1);
    expect(overlayById(m, id)).toMatchObject({ x: 0, y: 1 });
    expect(nudgeOverlay(m, id, -1, 1)).toBe(m);
    expect(overlayById(nudgeOverlay(model, id, 1, 0, 0.1), id)!.x).toBeCloseTo(0.6, 9);
  });

  it("removing the last overlay removes the field, so the document is unchanged", () => {
    const plain = JSON.stringify(toDoc(base()));
    const { model, id } = withOverlay();
    const none = removeOverlay(model, id);
    expect("overlays" in none).toBe(false);
    expect(JSON.stringify(toDoc(none))).toBe(plain);
    expect(removeOverlay(model, "nope")).toBe(model);
    const two = addOverlay(model, image, 0)!.model;
    expect(removeOverlay(two, id).overlays).toHaveLength(1);
  });

  it("moves a layer up or down, and not past either end", () => {
    let m = withOverlay().model;
    m = addOverlay(m, image, 0)!.model;
    const [a, b] = m.overlays!.map((o) => o.id);
    expect(moveOverlay(m, a, 1).overlays!.map((o) => o.id)).toEqual([b, a]);
    expect(moveOverlay(m, a, -1)).toBe(m);
    expect(moveOverlay(m, b, 1)).toBe(m);
    expect(moveOverlay(m, "nope", 1)).toBe(m);
  });
});

describe("what is on screen, and what a person should be told", () => {
  it("lists the overlays at a time, bottom layer first", () => {
    let m = addOverlay(base(), image, 1)!.model; // 1..6
    m = addOverlay(m, image, 3)!.model; // 3..8
    expect(overlaysAt(m, 0.5)).toHaveLength(0);
    expect(overlaysAt(m, 1)).toHaveLength(1);
    expect(overlaysAt(m, 4).map((o) => o.id)).toEqual(m.overlays!.map((o) => o.id));
    expect(overlaysAt(m, 6)).toHaveLength(1);
    expect(overlaysAt(m, 8)).toHaveLength(0);
  });

  it("warns about one that is cut, one past the end and one that is invisible", () => {
    const m0 = base();
    const mk = (extra: Partial<PictureOverlay>, id: string): PictureOverlay => ({
      id,
      asset_id: PIC,
      start_s: 1,
      end_s: 4,
      x: 0.5,
      y: 0.5,
      w: 0.3,
      opacity: 1,
      ...extra,
    });
    const m: EditorModel = {
      ...m0,
      overlays: [
        mk({}, "fine"),
        mk({ end_s: 30 }, "cut"),
        mk({ start_s: 10, end_s: 12 }, "past"),
        mk({ opacity: 0 }, "ghost"),
      ],
    };
    expect(overlayWarnings(m)).toEqual({ cut: "cut_end", past: "past_end", ghost: "invisible" });
  });
});
