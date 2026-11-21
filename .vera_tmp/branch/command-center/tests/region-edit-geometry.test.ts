/**
 * Region editor geometry (lib/regionEdit/geometry.ts).
 *
 * What would break without these: a rectangle that leaves the picture (the server refuses it, so the person sees an
 * error for something they drew), a sixth region, a region smaller than a model can use, a drag that shrinks a
 * rectangle at the edge instead of stopping it, a keyboard resize that jumps the region, and a view that maps a tap
 * to the wrong pixel. Constants are pinned equal to the Python compositor's, which is what enforces them for real.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FEATHER,
  FEATHER_MAX,
  FEATHER_MIN,
  MAX_REGIONS,
  MIN_REGION_PX,
  addRegion,
  clampRect,
  cleanLine,
  defaultRect,
  fitView,
  isFeather,
  moveRect,
  nextRegionNumber,
  removeRegion,
  resizeBy,
  resizeFromHandle,
  rectFromCorners,
  runnableRegions,
  toCanvasRect,
  toImagePoint,
  toImageRect,
  toWire,
  updateRegion,
  type EditorRegion,
  type Rect,
  type Size,
} from "@/lib/regionEdit/geometry";

const IMG: Size = { width: 400, height: 300 };
const inside = (r: Rect, b: Size) => r.x >= 0 && r.y >= 0 && r.x + r.w <= b.width && r.y + r.h <= b.height;

describe("clamping to the picture", () => {
  it("keeps any rectangle inside the picture, in whole pixels, at least the minimum", () => {
    const wild: Rect[] = [
      { x: -50, y: -50, w: 20, h: 20 },
      { x: 390, y: 290, w: 100, h: 100 },
      { x: 10.4, y: 10.6, w: 30.5, h: 30.5 },
      { x: 5, y: 5, w: 1, h: 1 },
      { x: 0, y: 0, w: 9999, h: 9999 },
      { x: NaN, y: Infinity, w: NaN, h: -5 },
    ];
    for (const r of wild) {
      const c = clampRect(r, IMG);
      expect(inside(c, IMG), JSON.stringify(c)).toBe(true);
      expect(c.w).toBeGreaterThanOrEqual(MIN_REGION_PX);
      expect(c.h).toBeGreaterThanOrEqual(MIN_REGION_PX);
      for (const v of Object.values(c)) expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("stops a rectangle dragged past an edge at the edge instead of shrinking it", () => {
    expect(moveRect({ x: 100, y: 100, w: 50, h: 40 }, 1000, 1000, IMG)).toEqual({ x: 350, y: 260, w: 50, h: 40 });
    expect(moveRect({ x: 100, y: 100, w: 50, h: 40 }, -1000, -1000, IMG)).toEqual({ x: 0, y: 0, w: 50, h: 40 });
  });

  it("works on a picture smaller than the minimum without leaving it", () => {
    const tiny: Size = { width: 10, height: 10 };
    const c = clampRect({ x: 3, y: 3, w: 50, h: 50 }, tiny);
    expect(inside(c, tiny)).toBe(true);
  });

  it("a rectangle drawn in any direction is the same rectangle", () => {
    const a = rectFromCorners({ x: 50, y: 60 }, { x: 150, y: 140 }, IMG);
    expect(rectFromCorners({ x: 150, y: 140 }, { x: 50, y: 60 }, IMG)).toEqual(a);
    expect(rectFromCorners({ x: 150, y: 60 }, { x: 50, y: 140 }, IMG)).toEqual(a);
    expect(a).toEqual({ x: 50, y: 60, w: 100, h: 80 });
  });

  it("a drag that leaves the picture ends on its edge; a tap makes a minimum-size region, not nothing", () => {
    const r = rectFromCorners({ x: 350, y: 250 }, { x: 900, y: 900 }, IMG);
    expect(inside(r, IMG)).toBe(true);
    expect(r.x + r.w).toBe(400);
    const tap = rectFromCorners({ x: 100, y: 100 }, { x: 101, y: 101 }, IMG);
    expect(tap.w).toBe(MIN_REGION_PX);
  });

  it("a default region is centred, inside, and a usable size", () => {
    const d = defaultRect({ x: 200, y: 150 }, IMG);
    expect(inside(d, IMG)).toBe(true);
    expect(d.w).toBe(60);
    expect(defaultRect({ x: 0, y: 0 }, IMG)).toMatchObject({ x: 0, y: 0 });
  });
});

describe("resizing", () => {
  const r: Rect = { x: 100, y: 100, w: 100, h: 80 };
  it("the keyboard grows from the top-left and cannot pass the edge or the minimum", () => {
    expect(resizeBy(r, 10, -10, IMG)).toEqual({ x: 100, y: 100, w: 110, h: 70 });
    expect(resizeBy(r, -999, -999, IMG)).toMatchObject({ w: MIN_REGION_PX, h: MIN_REGION_PX });
    expect(inside(resizeBy(r, 999, 999, IMG), IMG)).toBe(true);
  });

  it("a dragged handle moves only its own edges", () => {
    expect(resizeFromHandle(r, "e", 20, 0, IMG)).toEqual({ x: 100, y: 100, w: 120, h: 80 });
    expect(resizeFromHandle(r, "nw", 10, 10, IMG)).toEqual({ x: 110, y: 110, w: 90, h: 70 });
    expect(resizeFromHandle(r, "s", 0, -9999, IMG)).toMatchObject({ y: 100, h: MIN_REGION_PX });
    expect(resizeFromHandle(r, "w", -9999, 0, IMG)).toMatchObject({ x: 0, w: 200 });
    expect(inside(resizeFromHandle(r, "se", 9999, 9999, IMG), IMG)).toBe(true);
  });
});

describe("1 to 5 regions", () => {
  const meta = (n: number) => ({ id: `id${n}`, name: `Region ${n}` });
  it("accepts five and refuses the sixth without changing the list", () => {
    let list: EditorRegion[] = [];
    for (let i = 1; i <= MAX_REGIONS; i += 1) {
      const res = addRegion(list, { x: 10 * i, y: 10, w: 40, h: 40 }, meta(i), IMG);
      expect(res.ok).toBe(true);
      if (res.ok) list = res.regions;
    }
    expect(list).toHaveLength(5);
    const sixth = addRegion(list, { x: 0, y: 0, w: 40, h: 40 }, meta(6), IMG);
    expect(sixth).toEqual({ ok: false, error: "region_limit" });
    expect(list).toHaveLength(5);
  });

  it("clamps what it adds and cleans the name", () => {
    const res = addRegion([], { x: -20, y: 500, w: 5, h: 5 }, { id: "a", name: "  Sky\u0007\n  area " }, IMG);
    expect(res.ok && inside(res.added, IMG)).toBe(true);
    expect(res.ok && res.added.name).toBe("Sky area");
    expect(res.ok && res.added.prompt).toBe("");
  });

  it("removing frees a slot; numbering never reuses a name still on screen", () => {
    let list: EditorRegion[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const res = addRegion(list, { x: 10 * i, y: 10, w: 40, h: 40 }, { id: `id${i}`, name: `Region ${nextRegionNumber(list)}` }, IMG);
      if (res.ok) list = res.regions;
    }
    expect(list.map((r) => r.name)).toEqual(["Region 1", "Region 2", "Region 3"]);
    list = removeRegion(list, "id2");
    expect(nextRegionNumber(list)).toBe(2);
  });

  it("each region keeps its own name and its own words", () => {
    let list: EditorRegion[] = [];
    for (const n of [1, 2]) {
      const res = addRegion(list, { x: 10 * n, y: 10, w: 40, h: 40 }, meta(n), IMG);
      if (res.ok) list = res.regions;
    }
    list = updateRegion(list, "id1", { name: "Sky", prompt: "make it dusk" }, IMG);
    list = updateRegion(list, "id2", { name: "Car", prompt: "red car" }, IMG);
    expect(list.map((r) => [r.name, r.prompt])).toEqual([["Sky", "make it dusk"], ["Car", "red car"]]);
  });

  it("updating a rectangle re-clamps it; an unknown id changes nothing", () => {
    const res = addRegion([], { x: 10, y: 10, w: 40, h: 40 }, meta(1), IMG);
    const list = res.ok ? res.regions : [];
    const moved = updateRegion(list, "id1", { x: 9999, w: 9999 }, IMG);
    expect(inside(moved[0], IMG)).toBe(true);
    expect(updateRegion(list, "nope", { x: 5 }, IMG)).toEqual(list);
  });

  it("only regions with words are run, and the wire shape carries no editor id", () => {
    const list: EditorRegion[] = [
      { id: "a", name: "A", prompt: "  ", x: 0, y: 0, w: 20, h: 20 },
      { id: "b", name: "B", prompt: " x ", x: 0, y: 0, w: 20, h: 20 },
    ];
    expect(runnableRegions(list).map((r) => r.id)).toEqual(["b"]);
    expect(toWire(list)[1]).toEqual({ name: "B", prompt: "x", x: 0, y: 0, w: 20, h: 20 });
    expect(Object.keys(toWire(list)[0])).not.toContain("id");
  });
});

describe("the view maps canvas pixels to picture pixels and back", () => {
  it("fits without enlarging and centres", () => {
    expect(fitView({ width: 400, height: 300 }, { width: 200, height: 200 })).toEqual({ scale: 0.5, ox: 0, oy: 25 });
    expect(fitView({ width: 100, height: 100 }, { width: 500, height: 500 }).scale).toBe(1);
    expect(fitView({ width: 0, height: 0 }, { width: 500, height: 500 })).toEqual({ scale: 1, ox: 0, oy: 0 });
  });

  it("a tap lands on the pixel under it, and never outside the picture", () => {
    const view = fitView(IMG, { width: 200, height: 200 });
    expect(toImagePoint({ x: 100, y: 100 }, view, IMG)).toEqual({ x: 200, y: 150 });
    expect(toImagePoint({ x: -50, y: 999 }, view, IMG)).toEqual({ x: 0, y: 300 });
  });

  it("rectangles round-trip within a pixel", () => {
    const view = fitView(IMG, { width: 200, height: 200 });
    const r: Rect = { x: 120, y: 80, w: 100, h: 60 };
    const back = toImageRect(toCanvasRect(r, view), view, IMG);
    expect(Math.abs(back.x - r.x) + Math.abs(back.y - r.y) + Math.abs(back.w - r.w) + Math.abs(back.h - r.h)).toBeLessThanOrEqual(1);
  });
});

describe("text and feather", () => {
  it("cleans to one short line", () => {
    expect(cleanLine("a\r\nb\u0000  c", 10)).toBe("a b c");
    expect(cleanLine("x".repeat(100), 5)).toBe("xxxxx");
    expect(cleanLine(null, 5)).toBe("");
  });

  it("feather is a whole number inside the range", () => {
    for (const bad of [FEATHER_MIN - 1, FEATHER_MAX + 1, 2.5, "4", null, NaN]) expect(isFeather(bad)).toBe(false);
    for (let f = FEATHER_MIN; f <= FEATHER_MAX; f += 1) expect(isFeather(f)).toBe(true);
    expect(isFeather(DEFAULT_FEATHER)).toBe(true);
  });
});

describe("limits equal the compositor's", () => {
  const py = readFileSync(join(__dirname, "..", "..", "modules", "region_edit.py"), "utf8");
  const num = (name: string) => Number(new RegExp(`^${name} = (\\d+)`, "m").exec(py)?.[1]);
  it("MAX_REGIONS, MIN_REGION_PX and the feather range are the same numbers in modules/region_edit.py", () => {
    expect(num("MAX_REGIONS")).toBe(MAX_REGIONS);
    expect(num("MIN_REGION_PX")).toBe(MIN_REGION_PX);
    expect(num("FEATHER_MIN")).toBe(FEATHER_MIN);
    expect(num("FEATHER_MAX")).toBe(FEATHER_MAX);
    expect(num("DEFAULT_FEATHER")).toBe(DEFAULT_FEATHER);
  });
});
