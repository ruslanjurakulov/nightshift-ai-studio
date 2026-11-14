/**
 * The Studio canvas's pure model (lib/studio/canvas.ts).
 *
 * What would break without these: a wire that feeds a clip a voice-over, or closes a loop the form can
 * never resolve; an Image → Video node that does not say it has no picture before a quote (rule 6); a
 * stored layout from another version or a hand-edited one drawing a half graph or throwing; storage that
 * is blocked or full breaking the canvas instead of just not remembering it; zoom that jumps under the
 * cursor or past its limits; and two people sharing one sketch.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_STATE,
  NODE_H,
  NODE_W,
  ZOOM_MAX,
  ZOOM_MIN,
  bounds,
  canWire,
  clampZoom,
  connect,
  depthOf,
  disconnect,
  fitView,
  flowOrder,
  layoutKey,
  loadLayout,
  missingInput,
  newNode,
  outputType,
  parseLayout,
  recipeState,
  removeNode,
  saveLayout,
  tidy,
  toCanvas,
  wireInto,
  zoomAt,
  type CanvasState,
} from "@/lib/studio/canvas";

const A = "3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const J = "9a2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
let n = 0;
const id = () => `id${++n}`;

function graph(): CanvasState {
  return {
    ...EMPTY_STATE,
    nodes: [
      newNode("image", 0, 0, "img"),
      newNode("animate", 400, 0, "clip"),
      newNode("voice", 0, 300, "voice"),
      newNode("enhance", 800, 0, "enh"),
      newNode("asset", -400, 0, "pic", { assetId: A, assetKind: "image" }),
      newNode("asset", -400, 300, "rec", { assetId: A, assetKind: "audio" }),
    ],
  };
}

describe("wires are typed inputs", () => {
  it("lets a picture into Image → Video, and refuses a recording, a loop and a node with no input", () => {
    const s = graph();
    expect(canWire(s, "img", "clip")).toEqual({ ok: true, type: "image" });
    expect(canWire(s, "pic", "clip")).toEqual({ ok: true, type: "image" });
    expect(canWire(s, "rec", "clip")).toEqual({ ok: false, why: "wrong_type" });
    expect(canWire(s, "voice", "clip")).toEqual({ ok: false, why: "wrong_type" });
    expect(canWire(s, "clip", "img")).toEqual({ ok: false, why: "no_input" });
    expect(canWire(s, "clip", "clip")).toEqual({ ok: false, why: "same_node" });
    expect(canWire(s, "nope", "clip")).toEqual({ ok: false, why: "unknown_node" });
    // A clip into Edit · Upscale, then Edit back into the clip's source chain would loop.
    const chained = connect(connect(s, "img", "clip", "w1"), "clip", "enh", "w2");
    expect(outputType(chained, chained.nodes.find((x) => x.id === "enh")!)).toBe("video");
    expect(canWire({ ...chained, nodes: [...chained.nodes, newNode("enhance", 0, 0, "enh2")] }, "enh", "enh2").ok).toBe(true);
  });

  it("an unwired Edit · Upscale has no known output, so nothing can be wired from it yet", () => {
    const s = graph();
    expect(outputType(s, s.nodes.find((x) => x.id === "enh")!)).toBeNull();
    expect(canWire({ ...s, nodes: [...s.nodes, newNode("animate", 0, 0, "c2")] }, "enh", "c2")).toEqual({ ok: false, why: "no_output" });
  });

  it("refuses a wire that would close a loop", () => {
    let s: CanvasState = { ...EMPTY_STATE, nodes: [newNode("enhance", 0, 0, "e1"), newNode("enhance", 0, 0, "e2"), newNode("asset", 0, 0, "p", { assetId: A, assetKind: "image" })] };
    s = connect(s, "p", "e1", "w1");
    s = connect(s, "e1", "e2", "w2");
    expect(canWire(s, "e2", "e1")).toEqual({ ok: false, why: "loop" });
    expect(connect(s, "e2", "e1", "w3")).toBe(s);
  });

  it("one input per node: a new wire replaces the old one; disconnect and remove clean up", () => {
    let s = connect(graph(), "img", "clip", "w1");
    s = connect(s, "pic", "clip", "w2");
    expect(s.wires.filter((w) => w.to === "clip")).toEqual([{ id: "w2", from: "pic", to: "clip" }]);
    expect(wireInto(disconnect(s, "clip"), "clip")).toBeNull();
    const gone = removeNode(s, "pic");
    expect(gone.wires).toEqual([]);
    expect(gone.nodes.some((x) => x.id === "pic")).toBe(false);
  });

  it("says an Image → Video or an Edit has no input before any quote; a Voice-over does not need one", () => {
    const s = graph();
    const by = (k: string) => s.nodes.find((x) => x.id === k)!;
    expect(missingInput(s, by("clip"))).toBe(true);
    expect(missingInput(s, by("enh"))).toBe(true);
    expect(missingInput(s, by("voice"))).toBe(false);
    expect(missingInput(s, by("img"))).toBe(false);
    expect(missingInput(connect(s, "img", "clip", "w"), by("clip"))).toBe(false);
  });
});

describe("order and layout", () => {
  it("orders sources first, then what they feed, and Tidy puts each depth in its own column", () => {
    const s = connect(connect(graph(), "img", "clip", "w1"), "clip", "enh", "w2");
    expect(depthOf(s, "img")).toBe(0);
    expect(depthOf(s, "clip")).toBe(1);
    expect(depthOf(s, "enh")).toBe(2);
    const order = flowOrder(s).map((x) => x.id);
    expect(order.indexOf("img")).toBeLessThan(order.indexOf("clip"));
    expect(order.indexOf("clip")).toBeLessThan(order.indexOf("enh"));
    const t = tidy(s);
    const x = (k: string) => t.nodes.find((m) => m.id === k)!.x;
    expect(x("img")).toBe(0);
    expect(x("clip")).toBeGreaterThan(x("img"));
    expect(x("enh")).toBeGreaterThan(x("clip"));
    expect(t.wires).toEqual(s.wires);
  });

  it("starter recipes lay out nodes and wires only: no job, nothing priced", () => {
    const pv = recipeState("promptVideo", id);
    expect(pv.nodes.map((x) => x.kind)).toEqual(["image", "animate"]);
    expect(pv.wires).toHaveLength(1);
    expect(pv.nodes.every((x) => x.jobId === null)).toBe(true);
    const pc = recipeState("photoClip", id);
    expect(pc.nodes.map((x) => x.kind)).toEqual(["animate"]);
    expect(missingInput(pc, pc.nodes[0])).toBe(true);
    expect(recipeState("promptVoice", id).nodes.map((x) => x.kind)).toEqual(["voice"]);
  });
});

describe("viewport", () => {
  it("zooms about the cursor: the point under it stays put; and never past its limits", () => {
    const v = { x: 30, y: -20, k: 1 };
    const before = toCanvas(v, 300, 200);
    const z = zoomAt(v, 1.7, 300, 200);
    const after = toCanvas(z, 300, 200);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomAt(v, 99, 0, 0).k).toBe(ZOOM_MAX);
    expect(zoomAt(v, 0.001, 0, 0).k).toBe(ZOOM_MIN);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("fits every node with a margin and never blows one node up past 100%", () => {
    const one = fitView([{ x: 0, y: 0 }], 1200, 800);
    expect(one.k).toBe(1);
    const far = fitView([{ x: 0, y: 0 }, { x: 3000, y: 1800 }], 1200, 800);
    expect(far.k).toBeLessThan(1);
    const b = bounds([{ x: 0, y: 0 }, { x: 3000, y: 1800 }])!;
    const tl = { x: b.minX * far.k + far.x, y: b.minY * far.k + far.y };
    const br = { x: (3000 + NODE_W) * far.k + far.x, y: (1800 + NODE_H) * far.k + far.y };
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(tl.y).toBeGreaterThanOrEqual(0);
    expect(br.x).toBeLessThanOrEqual(1200);
    expect(br.y).toBeLessThanOrEqual(800);
  });
});

describe("persistence (this browser only)", () => {
  it("keys the layout by organization, channel and person", () => {
    expect(layoutKey("o1", "chronos", "u1")).not.toBe(layoutKey("o1", "chronos", "u2"));
    expect(layoutKey("o1", "chronos", "u1")).not.toBe(layoutKey("o1", "other", "u1"));
    expect(layoutKey("o1", "chronos", "u1")).not.toBe(layoutKey("o2", "chronos", "u1"));
  });

  it("round-trips nodes, wires, jobs, drafts and the view", () => {
    const store = new Map<string, string>();
    const kv = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    let s = connect(graph(), "img", "clip", "w1");
    s = { ...s, nodes: s.nodes.map((x) => (x.id === "img" ? { ...x, jobId: J, draft: "a fox at dawn" } : x)), view: { x: 10, y: 20, k: 0.5 } };
    expect(saveLayout(kv, "k", s)).toBe(true);
    const back = loadLayout(kv, "k");
    expect(back.nodes).toEqual(s.nodes);
    expect(back.wires).toEqual(s.wires);
    expect(back.view).toEqual(s.view);
  });

  it("an empty, blocked or full storage is an empty canvas, never an error", () => {
    expect(loadLayout(null, "k")).toEqual(EMPTY_STATE);
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(loadLayout(blocked, "k")).toEqual(EMPTY_STATE);
    expect(saveLayout(blocked, "k", graph())).toBe(false);
    expect(loadLayout({ getItem: () => null, setItem: () => {} }, "k")).toEqual(EMPTY_STATE);
  });

  it("drops what it cannot trust: junk, unknown kinds, bad ids, a file node without a file, and wires that could not be drawn", () => {
    expect(parseLayout("not json")).toEqual(EMPTY_STATE);
    expect(parseLayout(42)).toEqual(EMPTY_STATE);
    const s = parseLayout({
      nodes: [
        { id: "ok", kind: "image", x: 0, y: 0, jobId: "not-a-uuid", draft: 7 },
        { id: "ok", kind: "image", x: 5, y: 5 },
        { id: "bad kind", kind: "rocket", x: 0, y: 0 },
        { id: "nox", kind: "image", x: "1", y: 0 },
        { id: "nofile", kind: "asset", x: 0, y: 0 },
        { id: "clip", kind: "animate", x: 1, y: 1 },
        { id: "rec", kind: "asset", x: 0, y: 0, assetId: A, assetKind: "audio" },
        { id: "inf", kind: "image", x: Infinity, y: 0 },
      ],
      wires: [
        { id: "w1", from: "rec", to: "clip" },
        { id: "w2", from: "ok", to: "clip" },
        { id: "w3", from: "ghost", to: "clip" },
      ],
      view: { x: 0, y: 0, k: 50 },
    });
    expect(s.nodes.map((x) => x.id)).toEqual(["ok", "clip", "rec"]);
    expect(s.nodes[0].jobId).toBeNull();
    expect(s.nodes[0].draft).toBe("");
    expect(s.wires).toEqual([{ id: "w2", from: "ok", to: "clip" }]);
    expect(s.view.k).toBe(ZOOM_MAX);
  });
});
