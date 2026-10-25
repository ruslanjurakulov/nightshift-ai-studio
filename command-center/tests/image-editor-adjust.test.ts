/**
 * Brightness, contrast and saturation over RGBA bytes: ONE function used by the preview and by the saved file.
 * What would break without these: a neutral slider that still changes pixels, alpha touched, a value that wraps around
 * (255 + 10 -> 9) instead of clamping, saturation that shifts the brightness, or a slider value outside -100..100
 * reaching the maths.
 */
import { describe, expect, it } from "vitest";
import { ADJUST_MAX, ADJUST_MIN, NEUTRAL_ADJUST, applyAdjust, brightnessShift, clampAdjust, gain, isNeutral } from "../lib/imageEditor/adjust";

const px = (r: number, g: number, b: number, a = 255) => [r, g, b, a];
const run = (data: number[], adj: Partial<typeof NEUTRAL_ADJUST>) => {
  const d = [...data];
  applyAdjust(d, { ...NEUTRAL_ADJUST, ...adj });
  return d;
};
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe("applyAdjust", () => {
  it("leaves the pixels alone when every control is 0", () => {
    const data = [...px(10, 200, 99), ...px(255, 0, 128, 7)];
    expect(run(data, {})).toEqual(data);
    expect(isNeutral(NEUTRAL_ADJUST)).toBe(true);
    expect(isNeutral({ brightness: 0, contrast: 0, saturation: 1 })).toBe(false);
  });

  it("a neutral adjustment returns without reading a single pixel", () => {
    const trap = new Proxy([1, 2, 3, 255, 4, 5, 6, 255], {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) throw new Error("pixel read");
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => applyAdjust(trap, NEUTRAL_ADJUST)).not.toThrow();
    expect(() => applyAdjust(trap, { ...NEUTRAL_ADJUST, brightness: 1 })).toThrow("pixel read");
  });

  it("brightens and darkens every colour channel by the same amount, and clamps instead of wrapping", () => {
    expect(brightnessShift(100)).toBe(128);
    expect(run(px(100, 100, 100), { brightness: 50 }).slice(0, 3)).toEqual([164, 164, 164]);
    expect(run(px(100, 100, 100), { brightness: -50 }).slice(0, 3)).toEqual([36, 36, 36]);
    expect(run(px(250, 250, 250), { brightness: 100 }).slice(0, 3)).toEqual([255, 255, 255]);
    expect(run(px(5, 5, 5), { brightness: -100 }).slice(0, 3)).toEqual([0, 0, 0]);
  });

  it("never touches alpha", () => {
    for (const adj of [{ brightness: 100 }, { contrast: -100 }, { saturation: 100 }, { brightness: -30, contrast: 60, saturation: -20 }]) {
      expect(run(px(40, 90, 200, 33), adj)[3]).toBe(33);
    }
  });

  it("contrast pushes values away from mid grey, or pulls them to it", () => {
    expect(gain(0)).toBe(1);
    expect(gain(-100)).toBe(0);
    expect(gain(100)).toBe(3);
    const up = run(px(160, 100, 128), { contrast: 50 });
    expect(up[0]).toBeGreaterThan(160);
    expect(up[1]).toBeLessThan(100);
    expect(up[2]).toBe(128);
    expect(run(px(10, 240, 77), { contrast: -100 }).slice(0, 3)).toEqual([128, 128, 128]);
  });

  it("saturation -100 gives grey of the same luma, +100 spreads the colours, and neither moves the brightness of a grey", () => {
    const [r, g, b] = run(px(200, 80, 40), { saturation: -100 });
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(Math.abs(r - luma(200, 80, 40))).toBeLessThanOrEqual(1);
    const more = run(px(200, 80, 40), { saturation: 50 });
    expect(more[0] - more[2]).toBeGreaterThan(200 - 40);
    expect(run(px(90, 90, 90), { saturation: 100 }).slice(0, 3)).toEqual([90, 90, 90]);
  });

  it("works through a Uint8ClampedArray and ignores a trailing partial pixel", () => {
    const d = new Uint8ClampedArray([100, 100, 100, 255, 1, 2, 3]);
    applyAdjust(d, { brightness: 100, contrast: 0, saturation: 0 });
    expect([...d]).toEqual([228, 228, 228, 255, 1, 2, 3]);
  });
});

describe("clampAdjust", () => {
  it("rounds and holds a value inside -100..100; junk is 0", () => {
    expect(ADJUST_MIN).toBe(-100);
    expect(ADJUST_MAX).toBe(100);
    expect(clampAdjust(250)).toBe(100);
    expect(clampAdjust(-250)).toBe(-100);
    expect(clampAdjust(12.6)).toBe(13);
    expect(clampAdjust("40")).toBe(40);
    for (const junk of [NaN, Infinity, "x", undefined, null]) expect(clampAdjust(junk)).toBe(0);
  });
});
