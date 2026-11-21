// @vitest-environment jsdom
/**
 * How the saved file is built: the picture drawn with the same matrix and colour pass as the preview, the text and
 * shapes placed by one mapping, the stage exactly the crop's size at pixel ratio 1. Konva and the 2D context are
 * replaced by recorders (jsdom has no canvas), so this pins the ARGUMENTS the real ones get.
 * What would break without these: a saved picture that is the whole canvas instead of the crop, layers shifted by the
 * crop's offset, text sized for the preview instead of the file, a JPEG with a black background, a colour pass applied
 * to the layers, a 20-megapixel canvas attempted anyway, a stage left alive after an error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditState } from "../lib/imageEditor/state";
import { initialState } from "../lib/imageEditor/state";
import { FAMILY_CSS, newShape, newText, type Layer } from "../lib/imageEditor/layers";

class Node {
  cfg: Record<string, unknown>;
  children: Node[] = [];
  handlers: Record<string, () => void> = {};
  attrs: Record<string, unknown> = {};
  destroyed = false;
  constructor(cfg: Record<string, unknown> = {}) {
    this.cfg = cfg;
  }
  add(...n: Node[]) {
    this.children.push(...n);
    return this;
  }
  id(v?: string) {
    if (v !== undefined) this.attrs.id = v;
    return this.attrs.id;
  }
  listening(v: boolean) {
    this.attrs.listening = v;
  }
  draggable(v: boolean) {
    this.attrs.draggable = v;
  }
  on(evt: string, fn: () => void) {
    this.handlers[evt] = fn;
  }
  x() {
    return this.cfg.x as number;
  }
  y() {
    return this.cfg.y as number;
  }
  width() {
    return 80;
  }
  height() {
    return 20;
  }
  offsetX(v: number) {
    this.attrs.offsetX = v;
  }
  offsetY(v: number) {
    this.attrs.offsetY = v;
  }
}
class Stage extends Node {
  static last: Stage;
  blobConfig: Record<string, unknown> | null = null;
  blob: Blob | null = new Blob([new Uint8Array(10)], { type: "image/png" });
  constructor(cfg: Record<string, unknown>) {
    super(cfg);
    Stage.last = this;
  }
  async toBlob(c: Record<string, unknown>) {
    this.blobConfig = c;
    return this.blob;
  }
  destroy() {
    this.destroyed = true;
  }
}
class Layer2 extends Node {
  ratios: number[] = [];
  getCanvas() {
    return { setPixelRatio: (r: number) => this.ratios.push(r) };
  }
  getHitCanvas() {
    return { setPixelRatio: (r: number) => this.ratios.push(r) };
  }
}
const kinds = ["Text", "Line", "Ellipse", "Rect", "Image", "Group"] as const;
const fake = { Stage, Layer: Layer2, ...Object.fromEntries(kinds.map((k) => [k, class extends Node { kind = k; }])) } as unknown as import("../components/imageEditor/scene").KonvaNS;

const rendered = vi.hoisted(() => ({ calls: [] as unknown[][], result: {} as unknown }));
vi.mock("@/components/imageEditor/render", () => ({
  renderBase: (...a: unknown[]) => {
    rendered.calls.push(a);
    return rendered.result;
  },
}));

const { addLayerNodes, exportPicture } = await import("../components/imageEditor/scene");

const SRC = { width: 400, height: 300 };
const withLayers = (layers: Layer[], over: Partial<EditState> = {}): EditState => ({ ...initialState(), layers, ...over });

beforeEach(() => {
  rendered.calls.length = 0;
  rendered.result = { fake: "canvas" };
});

describe("addLayerNodes", () => {
  it("places every layer by x * scale + ox, sizes text for the scale, and keeps the layer's id", () => {
    const parent = new Node();
    const text: Layer = { ...newText("t", SRC, "Hi"), cx: 100, cy: 50, fontSize: 40, color: "#112233", family: "serif", bold: false };
    const nodes = addLayerNodes(fake, parent as never, [text], { scale: 0.5, ox: -10, oy: 5 });
    const n = nodes.get("t") as unknown as Node;
    expect(n.cfg).toMatchObject({ x: 40, y: 30, fontSize: 20, fill: "#112233", fontFamily: FAMILY_CSS.serif, fontStyle: "normal", text: "Hi" });
    expect(n.attrs).toMatchObject({ id: "t", offsetX: 40, offsetY: 10 });
    expect(parent.children).toHaveLength(1);
  });

  it("draws a rectangle centred, an ellipse by its radii and a line from -d to +d, outline or filled", () => {
    const rect: Layer = { id: "r", kind: "rect", cx: 200, cy: 100, w: 80, h: 40, color: "#ff0000", filled: false, strokeWidth: 4 };
    const filled: Layer = { ...rect, id: "f", filled: true };
    const ell: Layer = { id: "e", kind: "ellipse", cx: 10, cy: 20, w: 60, h: 30, color: "#00ff00", filled: true, strokeWidth: 2 };
    const line: Layer = { id: "l", kind: "line", cx: 50, cy: 60, dx: 30, dy: -10, color: "#0000ff", strokeWidth: 6 };
    const nodes = addLayerNodes(fake, new Node() as never, [rect, filled, ell, line], { scale: 2, ox: 0, oy: 0 });
    const cfg = (id: string) => (nodes.get(id) as unknown as Node).cfg;
    expect(cfg("r")).toMatchObject({ x: 400, y: 200, width: 160, height: 80, offsetX: 80, offsetY: 40, stroke: "#ff0000", strokeWidth: 8 });
    expect(cfg("r")).not.toHaveProperty("fill");
    expect(cfg("f")).toMatchObject({ fill: "#ff0000" });
    expect(cfg("f")).not.toHaveProperty("stroke");
    expect(cfg("e")).toMatchObject({ x: 20, y: 40, radiusX: 60, radiusY: 30, fill: "#00ff00" });
    expect(cfg("l")).toMatchObject({ x: 100, y: 120, points: [-60, 20, 60, -20], stroke: "#0000ff", strokeWidth: 12, lineCap: "round" });
  });

  it("without hooks (the saved file) nothing is interactive; with hooks a drag reports the centre back in canvas pixels", () => {
    const moved: unknown[] = [];
    const rect: Layer = { id: "r", kind: "rect", cx: 200, cy: 100, w: 80, h: 40, color: "#ff0000", filled: false, strokeWidth: 4 };
    const plain = addLayerNodes(fake, new Node() as never, [rect], { scale: 1, ox: 0, oy: 0 }).get("r") as unknown as Node;
    expect(plain.attrs).not.toHaveProperty("draggable");
    const hooked = addLayerNodes(fake, new Node() as never, [rect], { scale: 0.5, ox: 20, oy: 10 }, { interactive: true, onSelect: () => {}, onMove: (...a) => moved.push(a) }).get("r") as unknown as Node;
    expect(hooked.attrs).toMatchObject({ draggable: true, listening: true });
    hooked.cfg.x = 150; // dragged on screen
    hooked.cfg.y = 90;
    hooked.handlers.dragend();
    expect(moved).toEqual([["r", 260, 160]]);
    const idle = addLayerNodes(fake, new Node() as never, [rect], { scale: 1, ox: 0, oy: 0 }, { interactive: false, onSelect: () => {}, onMove: () => {} }).get("r") as unknown as Node;
    expect(idle.attrs).toMatchObject({ listening: false });
    expect(idle.attrs).not.toHaveProperty("draggable");
  });
});

describe("exportPicture", () => {
  it("builds a stage exactly the crop's size at pixel ratio 1, with the layers shifted by the crop's corner", async () => {
    const state = withLayers([newShape("r", "rect", SRC)], { crop: { x: 100, y: 50, w: 200, h: 120 } });
    state.layers = [{ ...(state.layers[0] as Layer), cx: 150, cy: 80 } as Layer];
    const blob = await exportPicture(fake, {} as CanvasImageSource, SRC, state, "png");
    expect(blob.size).toBe(10);
    const stage = Stage.last;
    expect(stage.cfg).toMatchObject({ width: 200, height: 120 });
    expect(stage.blobConfig).toEqual({ mimeType: "image/png", quality: undefined, pixelRatio: 1 });
    const layer = stage.children[0];
    expect(layer.children[0].cfg).toMatchObject({ x: 0, y: 0, width: 200, height: 120, image: rendered.result });
    expect(layer.children[1].cfg).toMatchObject({ x: 50, y: 30 });
    expect(stage.destroyed).toBe(true);
    // the layer is told pixel ratio 1 (scene and hit canvas) BEFORE the stage sizes it
    expect((layer as unknown as Layer2).ratios).toEqual([1, 1]);
  });

  it("gives the picture pass the crop window, scale 1 and the colours, and draws it with the turn the state has", async () => {
    const state: EditState = { ...initialState(), rotation: 90, mirrored: true, crop: { x: 10, y: 20, w: 100, h: 50 }, adjust: { brightness: 10, contrast: 0, saturation: -5 } };
    await exportPicture(fake, "IMG" as unknown as CanvasImageSource, SRC, state, "png");
    const [img, src, spec, area, scale, opaque] = rendered.calls[0];
    expect(img).toBe("IMG");
    expect(src).toEqual(SRC);
    expect(spec).toMatchObject({ rotation: 90, mirrored: true, adjust: { brightness: 10, contrast: 0, saturation: -5 } });
    expect(area).toEqual({ x: 10, y: 20, w: 100, h: 50 });
    expect(scale).toBe(1);
    expect(opaque).toBe(false);
  });

  it("with no crop the whole (turned) canvas is saved; the stage has the canvas size", async () => {
    await exportPicture(fake, {} as CanvasImageSource, SRC, { ...initialState(), rotation: 270 }, "png");
    expect(Stage.last.cfg).toMatchObject({ width: 300, height: 400 });
    expect(rendered.calls[0][3]).toEqual({ x: 0, y: 0, w: 300, h: 400 });
  });

  it("a JPEG is opaque (white behind any transparency) and carries a quality", async () => {
    await exportPicture(fake, {} as CanvasImageSource, SRC, { ...initialState(), rotation: 90 }, "jpeg");
    expect(rendered.calls[0][5]).toBe(true);
    expect(Stage.last.blobConfig).toEqual({ mimeType: "image/jpeg", quality: 0.92, pixelRatio: 1 });
  });

  it("refuses a canvas of more than 16 megapixels without building anything", async () => {
    await expect(exportPicture(fake, {} as CanvasImageSource, { width: 5000, height: 4000 }, initialState(), "png")).rejects.toThrow("too_many_pixels");
    expect(rendered.calls).toHaveLength(0);
    // a crop of a big canvas is judged by the crop, which is what is built
    await expect(exportPicture(fake, {} as CanvasImageSource, { width: 5000, height: 4000 }, { ...initialState(), crop: { x: 0, y: 0, w: 1000, h: 1000 } }, "png")).resolves.toBeInstanceOf(Blob);
  });

  it("rejects and still destroys the stage when the browser gives no context or encodes nothing", async () => {
    rendered.result = null;
    await expect(exportPicture(fake, {} as CanvasImageSource, SRC, { ...initialState(), rotation: 90 }, "png")).rejects.toThrow("no_canvas");
    rendered.result = {};
    const original = Stage.prototype.toBlob;
    Stage.prototype.toBlob = async function () {
      return new Blob([]);
    };
    try {
      await expect(exportPicture(fake, {} as CanvasImageSource, SRC, { ...initialState(), rotation: 90 }, "png")).rejects.toThrow("empty");
      expect(Stage.last.destroyed).toBe(true);
    } finally {
      Stage.prototype.toBlob = original;
    }
  });
});
