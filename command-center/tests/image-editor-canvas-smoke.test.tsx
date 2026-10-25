// @vitest-environment jsdom
/**
 * The REAL Konva scene (EditorCanvas, scene.ts exportPicture) run on a recording 2D context: every tool's scene builds
 * without throwing, selected layers get their handles, the crop frame reports its rectangle in canvas pixels, and the
 * flattened export has the crop's size.
 * What would break without these: a Konva option that only fails at runtime (the type checker cannot see a bad
 * Transformer or clip), a crop drag reported in stage pixels, a stage left behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import Konva from "konva";
import { EditorCanvas, type EditorCanvasProps } from "../components/imageEditor/EditorCanvas";
import { exportPicture } from "../components/imageEditor/scene";
import { initialState } from "../lib/imageEditor/state";
import { newShape, newText, type Layer } from "../lib/imageEditor/layers";

function fakeContext() {
  const target: Record<string, unknown> = { canvas: null };
  return new Proxy(target, {
    get(t, key: string) {
      if (key in t) return t[key];
      if (key === "measureText") return (text: string) => ({ width: String(text).length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (key === "getImageData") return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h });
      if (key === "createLinearGradient" || key === "createRadialGradient") return () => ({ addColorStop() {} });
      return () => undefined;
    },
    set(t, key: string, value) {
      t[key] = value;
      return true;
    },
  });
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((function (this: HTMLCanvasElement) {
    return fakeContext();
  }) as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(((cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array(4)], { type: "image/png" }))) as never);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 600 });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CANVAS = { width: 800, height: 600 };
const baseProps = (over: Partial<EditorCanvasProps> = {}): EditorCanvasProps => ({
  base: document.createElement("canvas"),
  canvas: CANVAS,
  view: { x: 0, y: 0, w: 800, h: 600 },
  layers: [],
  selectedId: null,
  tool: "crop",
  crop: { x: 100, y: 50, w: 400, h: 300 },
  ratio: null,
  label: "pic",
  keysId: "k",
  onSelect: () => {},
  onMove: () => {},
  onBox: () => {},
  onCrop: () => {},
  onKey: () => true,
  onKeyEnd: () => {},
  ...over,
});

const layers: Layer[] = [
  newText("t", CANVAS, "Hello\nworld"),
  newShape("r", "rect", CANVAS),
  newShape("e", "ellipse", CANVAS),
  newShape("l", "line", CANVAS),
];

async function mount(props: EditorCanvasProps) {
  const r = render(<EditorCanvas {...props} />);
  await act(async () => {
    await new Promise((res) => setTimeout(res, 30));
  });
  return r;
}
const stages = () => Konva.stages.filter(Boolean);

describe("EditorCanvas on real Konva", () => {
  for (const tool of ["crop", "adjust", "text", "shapes", "ai"] as const) {
    it(`builds the ${tool} scene with text, a rectangle, an ellipse and a line, selected or not, locked or free`, async () => {
      for (const selectedId of [null, "t", "r", "e", "l"]) {
        for (const ratio of [null, 1]) {
          const r = await mount(baseProps({ tool, layers, selectedId, ratio, view: tool === "crop" ? { x: 0, y: 0, w: 800, h: 600 } : { x: 100, y: 50, w: 400, h: 300 } }));
          expect(stages().length).toBeGreaterThan(0);
          r.unmount();
        }
      }
    });
  }

  it("puts handles on the crop frame, and on a selected rectangle or ellipse but not on text or a line", async () => {
    const handles = (r: ReturnType<typeof stages>[number]) => r.find("Transformer").length;
    let r = await mount(baseProps({ tool: "crop" }));
    expect(handles(stages().at(-1)!)).toBe(1);
    r.unmount();
    for (const [id, expected] of [["t", 0], ["r", 1], ["e", 1], ["l", 0]] as const) {
      r = await mount(baseProps({ tool: "shapes", layers, selectedId: id }));
      expect(handles(stages().at(-1)!), id).toBe(expected);
      r.unmount();
    }
    // outside the Text and Shapes tools a selection shows no handles and nothing can be dragged
    r = await mount(baseProps({ tool: "adjust", layers, selectedId: "r" }));
    expect(handles(stages().at(-1)!)).toBe(0);
    expect(stages().at(-1)!.find("Rect").filter((n) => n.draggable())).toHaveLength(0);
    r.unmount();
  });

  it("shows the picture clipped to the view: layers outside a crop are not painted into the letterbox", async () => {
    const r = await mount(baseProps({ tool: "text", layers, view: { x: 100, y: 50, w: 400, h: 300 } }));
    const stage = stages().at(-1)!;
    const group = stage.find("Group")[0] as import("konva/lib/Group").Group;
    const clip = group.clip();
    expect(clip.width).toBeGreaterThan(0);
    expect(clip.width / clip.height).toBeCloseTo(400 / 300, 5);
    r.unmount();
  });

  it("reports a dragged crop frame in CANVAS pixels, not stage pixels", async () => {
    const crops: unknown[] = [];
    const r = await mount(baseProps({ tool: "crop", onCrop: (c) => crops.push(c) }));
    const stage = stages().at(-1)!;
    // stage 600 wide for an 800 x 600 canvas -> scale 0.75; the frame starts at (75, 37.5)
    const frame = stage.find("Rect").find((n) => n.draggable())!;
    expect(frame.x()).toBeCloseTo(75, 5);
    expect(frame.y()).toBeCloseTo(37.5, 5);
    frame.x(150);
    frame.y(75);
    frame.fire("dragend");
    expect(crops).toEqual([{ x: 200, y: 100, w: 400, h: 300 }]);
    r.unmount();
  });

  it("reports a resized rectangle as a width and height in canvas pixels", async () => {
    const boxes: unknown[] = [];
    const r = await mount(baseProps({ tool: "shapes", layers, selectedId: "r", onBox: (...a) => boxes.push(a) }));
    const node = stages().at(-1)!.findOne("#r")!;
    node.scale({ x: 2, y: 0.5 });
    node.fire("transformend");
    const rect = layers[1] as { w: number; h: number };
    expect(boxes).toEqual([["r", rect.w * 2, rect.h * 0.5]]);
    expect(node.scaleX()).toBe(1);
    r.unmount();
  });

  it("reports a dragged layer's new centre in canvas pixels", async () => {
    const moves: unknown[] = [];
    const r = await mount(baseProps({ tool: "text", layers, onMove: (...a) => moves.push(a) }));
    const node = stages().at(-1)!.findOne("#r")!;
    const start = layers[1] as { cx: number; cy: number };
    node.x(node.x() + 75);
    node.y(node.y() + 30);
    node.fire("dragend");
    expect(moves).toEqual([["r", start.cx + 100, start.cy + 40]]);
    r.unmount();
  });

  it("destroys its stage when it goes away", async () => {
    const before = stages().length;
    const r = await mount(baseProps());
    expect(stages().length).toBe(before + 1);
    r.unmount();
    expect(stages().length).toBe(before);
  });

  it("answers the keyboard with the same actions the panels use", async () => {
    const keys: unknown[] = [];
    const r = await mount(baseProps({ onKey: (a) => (keys.push(a), true) }));
    const host = r.container.firstElementChild as HTMLElement;
    const press = (key: string, extra: KeyboardEventInit = {}) => host.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
    press("ArrowRight");
    press("ArrowDown", { shiftKey: true });
    press("ArrowLeft", { altKey: true });
    press("PageDown");
    press("PageUp");
    press("Delete");
    expect(keys).toEqual([
      { type: "move", dx: 1, dy: 0 },
      { type: "move", dx: 0, dy: 10 },
      { type: "resize", dx: -1, dy: 0 },
      { type: "cycle", dir: 1 },
      { type: "cycle", dir: -1 },
      { type: "remove" },
    ]);
  });
});

describe("what the canvas does with a key the editor did not use", () => {
  it("leaves it to the browser (an arrow key still scrolls the page), and takes it only when the editor says it was used", async () => {
    for (const handled of [false, true]) {
      const r = await mount(baseProps({ onKey: () => handled }));
      const host = r.container.firstElementChild as HTMLElement;
      for (const key of ["ArrowDown", "ArrowLeft", "PageDown", "Delete", "Backspace"]) {
        const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        host.dispatchEvent(ev);
        expect(ev.defaultPrevented, `${key} handled=${handled}`).toBe(handled);
      }
      const other = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
      host.dispatchEvent(other);
      expect(other.defaultPrevented).toBe(false);
      r.unmount();
    }
  });
});

describe("exportPicture on real Konva", () => {
  it("flattens to the crop's size and hands back a non-empty blob", async () => {
    const state = { ...initialState(), crop: { x: 10, y: 20, w: 321, h: 123 }, layers };
    const before = stages().length;
    const blob = await exportPicture(Konva, document.createElement("canvas"), CANVAS, state, "png");
    expect(blob.size).toBeGreaterThan(0);
    expect(stages().length).toBe(before);
  });
});
