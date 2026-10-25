/**
 * The image editor's geometry: what a turn, a flip and a crop do to each other, to the layers and to the saved size.
 * What would break without these: a flattened picture with its sides swapped, a text layer left behind when the picture
 * turns, a crop that leaves the picture, a crop shape that is not 4:5, a "square" crop that is 1 px off every time, or
 * a no-op crop (the whole canvas) counted as an edit so Save lights up for nothing.
 */
import { describe, expect, it } from "vitest";
import {
  baseMatrix,
  canvasSize,
  flipHorizontal,
  flipVertical,
  initialState,
  isEditableMime,
  isEdited,
  mapSourcePoint,
  outputSize,
  rotateCcw,
  rotateCw,
  tooManyPixels,
  withCrop,
  MAX_EDIT_PIXELS,
  type EditState,
  type Rotation,
} from "../lib/imageEditor/state";
import { ASPECTS, aspectRatio, clampCrop, fitAspect, fullRect, normalizeCrop, resizeCrop, MIN_CROP_PX } from "../lib/imageEditor/crop";
import {
  MAX_LAYERS,
  TEXT_MAX,
  addLayer,
  cleanText,
  lineFromPolar,
  lineToPolar,
  newShape,
  newText,
  normalizeColor,
  removeLayer,
  updateLayer,
  type Layer,
} from "../lib/imageEditor/layers";

const SRC = { width: 400, height: 300 };

/** A source point, followed through the state's own mirror and turn. */
const through = (s: Pick<EditState, "rotation" | "mirrored">, p: { x: number; y: number }) => mapSourcePoint(SRC, s.rotation, s.mirrored, p);

describe("canvas and output size", () => {
  it("swaps the sides for a quarter turn and keeps them for a half turn", () => {
    expect(canvasSize(SRC, 0)).toEqual({ width: 400, height: 300 });
    expect(canvasSize(SRC, 90)).toEqual({ width: 300, height: 400 });
    expect(canvasSize(SRC, 180)).toEqual({ width: 400, height: 300 });
    expect(canvasSize(SRC, 270)).toEqual({ width: 300, height: 400 });
  });

  it("saves the crop's own size, or the whole canvas when there is no crop", () => {
    expect(outputSize(SRC, { rotation: 90, crop: null })).toEqual({ width: 300, height: 400 });
    expect(outputSize(SRC, { rotation: 90, crop: { x: 10, y: 20, w: 120, h: 80 } })).toEqual({ width: 120, height: 80 });
  });

  it("refuses more than 16 megapixels and accepts exactly 16", () => {
    expect(MAX_EDIT_PIXELS).toBe(16_000_000);
    expect(tooManyPixels({ width: 4000, height: 4000 })).toBe(false);
    expect(tooManyPixels({ width: 4001, height: 4000 })).toBe(true);
  });

  it("opens only JPEG, PNG and WebP", () => {
    for (const ok of ["image/jpeg", "image/png", "image/webp", "IMAGE/PNG"]) expect(isEditableMime(ok), ok).toBe(true);
    for (const no of ["image/gif", "image/heic", "image/svg+xml", "video/mp4", "", undefined, null]) expect(isEditableMime(no), String(no)).toBe(false);
  });
});

describe("the base matrix (how the source is drawn onto the canvas)", () => {
  const apply = (m: number[], p: { x: number; y: number }) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

  it.each([0, 90, 180, 270] as Rotation[])("agrees with mapSourcePoint for every corner at %i degrees, mirrored or not", (rotation) => {
    for (const mirrored of [false, true]) {
      const m = baseMatrix(SRC, rotation, mirrored);
      for (const p of [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 0, y: 300 }, { x: 400, y: 300 }, { x: 123, y: 45 }]) {
        expect(apply(m, p)).toEqual(through({ rotation, mirrored }, p));
      }
    }
  });

  it("keeps every source corner inside the canvas", () => {
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const c = canvasSize(SRC, rotation);
      for (const mirrored of [false, true]) {
        for (const p of [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 0, y: 300 }, { x: 400, y: 300 }]) {
          const q = through({ rotation, mirrored }, p);
          expect(q.x).toBeGreaterThanOrEqual(0);
          expect(q.x).toBeLessThanOrEqual(c.width);
          expect(q.y).toBeGreaterThanOrEqual(0);
          expect(q.y).toBeLessThanOrEqual(c.height);
        }
      }
    }
  });

  it("turns the top-left corner of the source to the top-right after a quarter turn clockwise", () => {
    expect(through({ rotation: 90, mirrored: false }, { x: 0, y: 0 })).toEqual({ x: 300, y: 0 });
  });
});

const base = (): EditState => ({
  ...initialState(),
  crop: { x: 40, y: 30, w: 100, h: 60 },
  layers: [
    { id: "t", kind: "text", cx: 50, cy: 40, text: "hi", fontSize: 20, color: "#ffffff", family: "sans", bold: true },
    { id: "r", kind: "rect", cx: 200, cy: 100, w: 80, h: 30, color: "#ff0000", filled: false, strokeWidth: 3 },
    { id: "l", kind: "line", cx: 100, cy: 200, dx: 30, dy: 10, color: "#00ff00", strokeWidth: 2 },
  ],
});

describe("turning and flipping keep the crop and the layers attached to the same part of the picture", () => {
  it("a quarter turn clockwise moves the crop and every layer the same way the picture's pixels move", () => {
    const s = rotateCw(base(), SRC);
    expect(s.rotation).toBe(90);
    // The picture is 300 x 400 now. A point (x, y) of the old canvas (400 x 300) lands at (300 - y, x).
    expect(s.crop).toEqual({ x: 300 - 30 - 60, y: 40, w: 60, h: 100 });
    const text = s.layers[0];
    expect(text).toMatchObject({ cx: 300 - 40, cy: 50 });
    const rect = s.layers[1];
    expect(rect).toMatchObject({ cx: 300 - 100, cy: 200, w: 30, h: 80 });
    expect(s.layers[2]).toMatchObject({ cx: 300 - 200, cy: 100, dx: -10, dy: 30 });
  });

  it("four quarter turns in either direction are the identity, and left undoes right", () => {
    let s = base();
    for (let i = 0; i < 4; i += 1) s = rotateCw(s, SRC);
    expect(s).toEqual(base());
    for (let i = 0; i < 4; i += 1) s = rotateCcw(s, SRC);
    expect(s).toEqual(base());
    expect(rotateCcw(rotateCw(base(), SRC), SRC)).toEqual(base());
    expect(rotateCw(rotateCcw(base(), SRC), SRC)).toEqual(base());
  });

  it("a crop of a turned picture picks the same pixels as before the turn", () => {
    const before = base();
    const after = rotateCw(before, SRC);
    const topLeftBefore = { x: before.crop!.x, y: before.crop!.y };
    // The crop's corner that was top-left is the top-right of the turned crop.
    const corner = mapSourcePoint({ width: 400, height: 300 }, 90, false, topLeftBefore);
    expect(corner).toEqual({ x: after.crop!.x + after.crop!.w, y: after.crop!.y });
  });

  it("a flip mirrors the layers and the crop and never moves anything off the picture", () => {
    const s = flipHorizontal(base(), SRC);
    expect(s.crop).toEqual({ x: 400 - 40 - 100, y: 30, w: 100, h: 60 });
    expect(s.layers[0]).toMatchObject({ cx: 350, cy: 40 });
    expect(s.layers[2]).toMatchObject({ cx: 300, dx: -30, dy: 10 });
  });

  it("flipping twice is the identity, left-right or top-bottom", () => {
    expect(flipHorizontal(flipHorizontal(base(), SRC), SRC)).toEqual(base());
    expect(flipVertical(flipVertical(base(), SRC), SRC)).toEqual(base());
  });

  it("the state's mirror-then-turn form maps every source point where a flip of the canvas says it should", () => {
    // From any starting turn: flip the CANVAS left-right by hand (x -> W - x) and compare with what the new state does.
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      for (const mirrored of [false, true]) {
        const s: EditState = { ...initialState(), rotation, mirrored };
        const c = canvasSize(SRC, rotation);
        const h = flipHorizontal(s, SRC);
        const v = flipVertical(s, SRC);
        for (const p of [{ x: 10, y: 20 }, { x: 390, y: 5 }, { x: 200, y: 299 }]) {
          const q = through(s, p);
          expect(through(h, p), `H ${rotation} ${mirrored}`).toEqual({ x: c.width - q.x, y: q.y });
          expect(through(v, p), `V ${rotation} ${mirrored}`).toEqual({ x: q.x, y: c.height - q.y });
        }
      }
    }
  });

  it("a text layer stays upright through a turn (only its centre moves)", () => {
    const s = rotateCw(base(), SRC);
    expect(s.layers[0]).toMatchObject({ kind: "text", text: "hi", fontSize: 20 });
  });
});

describe("the crop", () => {
  it("is null when it covers the whole canvas, so a no-op never counts as an edit", () => {
    expect(normalizeCrop(fullRect(SRC), SRC)).toBeNull();
    expect(normalizeCrop(null, SRC)).toBeNull();
    expect(normalizeCrop({ x: 0, y: 0, w: 399, h: 300 }, SRC)).toEqual({ x: 0, y: 0, w: 399, h: 300 });
    const s = withCrop(initialState(), fullRect(SRC), SRC);
    expect(s.crop).toBeNull();
    expect(isEdited(s)).toBe(false);
  });

  it("setting the crop it already has hands back the SAME state, so it is not an undo step", () => {
    const s = withCrop(initialState(), { x: 10, y: 10, w: 100, h: 100 }, SRC);
    expect(withCrop(s, { x: 10, y: 10, w: 100, h: 100 }, SRC)).toBe(s);
    expect(withCrop(initialState(), null, SRC).crop).toBeNull();
    const none = initialState();
    expect(withCrop(none, fullRect(SRC), SRC)).toBe(none);
    expect(withCrop(s, { x: 11, y: 10, w: 100, h: 100 }, SRC)).not.toBe(s);
  });

  it("stays inside the picture and never gets smaller than the minimum", () => {
    expect(clampCrop({ x: -50, y: 290, w: 9999, h: 5 }, SRC)).toEqual({ x: 0, y: 284, w: 400, h: MIN_CROP_PX });
    const r = clampCrop({ x: 390, y: 290, w: 100, h: 100 }, SRC);
    expect(r.x + r.w).toBeLessThanOrEqual(400);
    expect(r.y + r.h).toBeLessThanOrEqual(300);
  });

  it("offers free, 1:1, 4:5, 9:16 and 16:9", () => {
    expect([...ASPECTS]).toEqual(["free", "1:1", "4:5", "9:16", "16:9"]);
    expect(aspectRatio("free")).toBeNull();
    expect(aspectRatio("1:1")).toBe(1);
    expect(aspectRatio("4:5")).toBeCloseTo(0.8);
    expect(aspectRatio("9:16")).toBeCloseTo(0.5625);
    expect(aspectRatio("16:9")).toBeCloseTo(16 / 9);
  });

  it.each(ASPECTS.filter((a) => a !== "free"))("%s: the largest centred rectangle of that shape, inside the one it came from, to within a pixel", (id) => {
    const ratio = aspectRatio(id)!;
    for (const from of [fullRect(SRC), { x: 20, y: 10, w: 200, h: 150 }, { x: 0, y: 0, w: 123, h: 321 }]) {
      const canvas = { width: 400, height: 400 };
      const r = fitAspect(from, ratio, canvas);
      expect(r.x).toBeGreaterThanOrEqual(from.x);
      expect(r.y).toBeGreaterThanOrEqual(from.y);
      expect(r.x + r.w).toBeLessThanOrEqual(from.x + from.w);
      expect(r.y + r.h).toBeLessThanOrEqual(from.y + from.h);
      expect(Math.abs(r.w / r.h - ratio)).toBeLessThan(1 / r.h + 1e-9);
      // largest: it touches the limiting side of the source rectangle
      expect(r.w === from.w || r.h === from.h).toBe(true);
    }
  });

  it("a 1:1 crop of a 400 x 300 picture is 300 x 300, centred", () => {
    expect(fitAspect(fullRect(SRC), 1, SRC)).toEqual({ x: 50, y: 0, w: 300, h: 300 });
  });

  it("typing a width on a locked shape moves the height with it, and never leaves the picture", () => {
    const r = resizeCrop({ x: 10, y: 10, w: 100, h: 100 }, { w: 200 }, 1, SRC);
    expect(r).toMatchObject({ w: 200, h: 200 });
    const tall = resizeCrop({ x: 10, y: 10, w: 100, h: 100 }, { w: 390 }, 1, SRC);
    expect(tall.w).toBe(300);
    expect(tall.h).toBe(300);
    expect(tall.x + tall.w).toBeLessThanOrEqual(400);
    expect(tall.y + tall.h).toBeLessThanOrEqual(300);
    const byHeight = resizeCrop({ x: 0, y: 0, w: 100, h: 125 }, { h: 250 }, 0.8, SRC);
    expect(byHeight).toMatchObject({ w: 200, h: 250 });
  });

  it("typing a side on a free crop changes only that side", () => {
    expect(resizeCrop({ x: 10, y: 10, w: 100, h: 100 }, { h: 40 }, null, SRC)).toEqual({ x: 10, y: 10, w: 100, h: 40 });
  });
});

describe("layers", () => {
  it("clean text: no control characters, line breaks kept, cut at the limit", () => {
    expect(cleanText("a\u0000b\u0007c")).toBe("abc");
    expect(cleanText("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
    expect(cleanText("x".repeat(TEXT_MAX + 50))).toHaveLength(TEXT_MAX);
    expect(cleanText(undefined)).toBe("");
  });

  it("colours are #rrggbb only: anything that could be markup falls back", () => {
    expect(normalizeColor("#FFAA00")).toBe("#ffaa00");
    expect(normalizeColor("#fa0")).toBe("#ffaa00");
    for (const bad of ["red", "url(javascript:1)", "#12345", "#gggggg", "<svg>", "", null, 5]) expect(normalizeColor(bad, "#123456")).toBe("#123456");
  });

  it("a layer can never be moved off the picture or given an out-of-range size, and a patch for another kind changes nothing", () => {
    const text = newText("a", SRC, "hello");
    const rect = newShape("b", "rect", SRC);
    const list: Layer[] = [text, rect];
    const moved = updateLayer(list, "a", { cx: -500, cy: 9999, fontSize: 5000, color: "javascript:x", w: 5 }, SRC)[0];
    expect(moved).toMatchObject({ cx: 0, cy: 300, fontSize: 400, color: "#ffffff" });
    expect(moved).not.toHaveProperty("w");
    const tiny = updateLayer(list, "b", { w: 0, h: -4, strokeWidth: 9999 }, SRC)[1];
    expect(tiny).toMatchObject({ w: 4, h: 4, strokeWidth: 80 });
    expect(updateLayer(list, "nope", { cx: 1 }, SRC)).toEqual(list);
  });

  it("only the three generic font families are accepted", () => {
    const text = newText("a", SRC, "x");
    expect(updateLayer([text], "a", { family: "mono" }, SRC)[0]).toMatchObject({ family: "mono" });
    expect(updateLayer([text], "a", { family: "Comic Sans MS" as never }, SRC)[0]).toMatchObject({ family: "sans" });
    expect(updateLayer([text], "a", { family: "url(x)" as never }, SRC)[0]).toMatchObject({ family: "sans" });
  });

  it("allows at most MAX_LAYERS", () => {
    let list: Layer[] = [];
    for (let i = 0; i < MAX_LAYERS; i += 1) {
      const r = addLayer(list, newText(`t${i}`, SRC, "x"));
      expect(r.ok).toBe(true);
      if (r.ok) list = r.layers;
    }
    expect(addLayer(list, newText("one-too-many", SRC, "x"))).toEqual({ ok: false, error: "layer_limit" });
    expect(removeLayer(list, "t0")).toHaveLength(MAX_LAYERS - 1);
  });

  it("a line is typed as a length and an angle and comes back to the same line", () => {
    expect(lineToPolar({ dx: 30, dy: 0 })).toEqual({ length: 60, angle: 0 });
    expect(lineToPolar({ dx: 0, dy: 20 })).toEqual({ length: 40, angle: 90 });
    expect(lineToPolar({ dx: -20, dy: 0 })).toEqual({ length: 40, angle: 180 });
    expect(lineToPolar({ dx: 0, dy: -20 })).toEqual({ length: 40, angle: 270 });
    expect(lineFromPolar(60, 0)).toEqual({ dx: 30, dy: 0 });
    expect(lineFromPolar(40, 90)).toEqual({ dx: 0, dy: 20 });
    expect(lineFromPolar(-5, 10)).toEqual({ dx: 0, dy: 0 });
  });
});
