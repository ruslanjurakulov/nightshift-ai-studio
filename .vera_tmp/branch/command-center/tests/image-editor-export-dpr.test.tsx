// @vitest-environment jsdom
/**
 * The REAL Konva, at window.devicePixelRatio 3 (a phone), flattening a 1200 x 800 file.
 * Konva sizes a layer's canvas by the device pixel ratio and caches it on first use, so the ratio is set BEFORE Konva is
 * imported (which is why this is its own file).
 * What would break without this: a save that asks the browser for a 3600 x 2400 canvas to make a 1200 x 800 file. On iOS
 * Safari (16.7 MP) anything over about 1.8 MP of output would fail or come out blank; on a desktop at ratio 2 it wastes
 * hundreds of MB.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sizes: [number, number][] = [];
const original: { w?: PropertyDescriptor; h?: PropertyDescriptor } = {};
let Konva: typeof import("konva").default;
let exportPicture: typeof import("../components/imageEditor/scene").exportPicture;
let initialState: typeof import("../lib/imageEditor/state").initialState;
let newText: typeof import("../lib/imageEditor/layers").newText;
let newShape: typeof import("../lib/imageEditor/layers").newShape;

beforeAll(async () => {
  Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
  original.w = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width")!;
  original.h = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "height")!;
  Object.defineProperty(HTMLCanvasElement.prototype, "width", {
    configurable: true,
    get() { return original.w!.get!.call(this); },
    set(v) { sizes.push([v, this.height]); original.w!.set!.call(this, v); },
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "height", {
    configurable: true,
    get() { return original.h!.get!.call(this); },
    set(v) { sizes.push([this.width, v]); original.h!.set!.call(this, v); },
  });
  const ctx = new Proxy({}, {
    get: (_t, key) => (key === "measureText" ? (t: string) => ({ width: t.length * 8 }) : key === "getImageData" ? (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => undefined),
    set: () => true,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ctx) as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(((cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array(4)]))) as never);
  Konva = (await import("konva")).default;
  ({ exportPicture } = await import("../components/imageEditor/scene"));
  ({ initialState } = await import("../lib/imageEditor/state"));
  ({ newText, newShape } = await import("../lib/imageEditor/layers"));
});
afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "width", original.w!);
  Object.defineProperty(HTMLCanvasElement.prototype, "height", original.h!);
  vi.restoreAllMocks();
});

describe("exportPicture at devicePixelRatio 3", () => {
  it("sees the ratio the phone has (the check below is not vacuous)", () => {
    expect(window.devicePixelRatio).toBe(3);
    const probe = new Konva.Stage({ container: document.createElement("div"), width: 100, height: 100 });
    const layer = new Konva.Layer();
    probe.add(layer);
    expect(layer.getCanvas().getPixelRatio()).toBe(3);
    probe.destroy();
  });

  it("never allocates a canvas larger than the file", async () => {
    sizes.length = 0;
    const src = { width: 1600, height: 1000 };
    const state = { ...initialState(), crop: { x: 0, y: 0, w: 1200, h: 800 }, layers: [newText("t", src, "Hi"), newShape("r", "rect", src)] };
    await exportPicture(Konva, document.createElement("canvas"), src, state, "png");
    expect(sizes.length).toBeGreaterThan(0);
    for (const [w, h] of sizes) {
      expect(w, `canvas ${w}x${h}`).toBeLessThanOrEqual(1200);
      expect(h, `canvas ${w}x${h}`).toBeLessThanOrEqual(800);
    }
    expect(sizes.some(([w, h]) => w === 1200 && h === 800)).toBe(true);
  });
});
