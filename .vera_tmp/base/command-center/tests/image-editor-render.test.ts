// @vitest-environment jsdom
/**
 * The picture pass (render.ts) against a recording 2D context.
 * What would break without these: the preview and the file drawing the picture with different matrices, the colour
 * pass skipped or applied twice, a transparent PNG saved as JPEG with a black background, a crop window drawn from the
 * wrong corner, a 16-megapixel pass asked to run on a context that does not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_LONG_SIDE, previewScale, renderBase } from "../components/imageEditor/render";
import { baseMatrix } from "../lib/imageEditor/state";
import { NEUTRAL_ADJUST } from "../lib/imageEditor/adjust";

const ops: unknown[][] = [];
let pixels = new Uint8ClampedArray([100, 100, 100, 255]);
let hasContext = true;
const ctx = {
  fillStyle: "",
  imageSmoothingEnabled: false,
  imageSmoothingQuality: "",
  fillRect: (...a: number[]) => ops.push(["fillRect", ...a]),
  setTransform: (...a: number[]) => ops.push(["setTransform", ...a]),
  drawImage: (...a: unknown[]) => ops.push(["drawImage", ...a]),
  getImageData: (...a: number[]) => {
    ops.push(["getImageData", ...a]);
    return { data: pixels };
  },
  putImageData: (...a: unknown[]) => ops.push(["putImageData", ...a.slice(1)]),
};

beforeEach(() => {
  ops.length = 0;
  pixels = new Uint8ClampedArray([100, 100, 100, 255]);
  hasContext = true;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => (hasContext ? ctx : null)) as never);
});
afterEach(() => vi.restoreAllMocks());

const SRC = { width: 400, height: 300 };
const spec = { rotation: 90 as const, mirrored: true, adjust: NEUTRAL_ADJUST };

describe("renderBase", () => {
  it("draws the whole source with the shared matrix, moved by the window's corner and multiplied by the scale", () => {
    const canvas = renderBase({} as CanvasImageSource, SRC, spec, { x: 30, y: 20, w: 100, h: 60 }, 0.5)!;
    expect(canvas.width).toBe(50);
    expect(canvas.height).toBe(30);
    const [a, b, c, d, e, f] = baseMatrix(SRC, 90, true);
    expect(ops[0]).toEqual(["setTransform", a * 0.5, b * 0.5, c * 0.5, d * 0.5, (e - 30) * 0.5, (f - 20) * 0.5]);
    expect(ops[1]).toEqual(["drawImage", {}, 0, 0, 400, 300]);
    expect(ops[2]).toEqual(["setTransform", 1, 0, 0, 1, 0, 0]);
  });

  it("does not read a pixel when the colours are neutral", () => {
    renderBase({} as CanvasImageSource, SRC, spec, { x: 0, y: 0, w: 10, h: 10 }, 1);
    expect(ops.some((o) => o[0] === "getImageData")).toBe(false);
  });

  it("runs the colour pass once over the drawn pixels and puts them back", () => {
    renderBase({} as CanvasImageSource, SRC, { ...spec, adjust: { brightness: 50, contrast: 0, saturation: 0 } }, { x: 0, y: 0, w: 10, h: 10 }, 1);
    expect(ops.filter((o) => o[0] === "getImageData")).toHaveLength(1);
    expect(ops.filter((o) => o[0] === "putImageData")).toHaveLength(1);
    expect([...pixels]).toEqual([164, 164, 164, 255]);
  });

  it("opaque (JPEG) paints white first, before the picture", () => {
    renderBase({} as CanvasImageSource, SRC, spec, { x: 0, y: 0, w: 10, h: 10 }, 1, true);
    expect(ops[0]).toEqual(["fillRect", 0, 0, 10, 10]);
    expect(ctx.fillStyle).toBe("#ffffff");
    expect(ops.findIndex((o) => o[0] === "drawImage")).toBeGreaterThan(0);
    ops.length = 0;
    renderBase({} as CanvasImageSource, SRC, spec, { x: 0, y: 0, w: 10, h: 10 }, 1, false);
    expect(ops.some((o) => o[0] === "fillRect")).toBe(false);
  });

  it("is null, not an exception, when the browser gives no 2D context; and never makes a zero-size canvas", () => {
    hasContext = false;
    expect(renderBase({} as CanvasImageSource, SRC, spec, { x: 0, y: 0, w: 10, h: 10 }, 1)).toBeNull();
    hasContext = true;
    const tiny = renderBase({} as CanvasImageSource, SRC, spec, { x: 0, y: 0, w: 1, h: 1 }, 0.01)!;
    expect(tiny.width).toBe(1);
    expect(tiny.height).toBe(1);
  });
});

describe("previewScale", () => {
  it("shrinks big pictures to the preview's long side and never enlarges a small one", () => {
    expect(PREVIEW_LONG_SIDE).toBe(1600);
    expect(previewScale({ width: 4000, height: 3000 })).toBe(0.4);
    expect(previewScale({ width: 800, height: 600 })).toBe(1);
    expect(previewScale({ width: 1600, height: 10 })).toBe(1);
  });
});
