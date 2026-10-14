/**
 * Stickers and shapes (the document's `shapes` list): the closed set pinned to the worker's
 * (modules/shape_art.py), the pure model edits behind the picker and inspector, every edit
 * kept a document the validators accept (a fuzz through the editor's own settle step), the
 * round trip through toModel / toDoc, and the preview's geometry pinned to the fixture the
 * Python tests compute from the worker's drawing code (samples/shape_layout.json). The two
 * validators are judged on the same documents in editor-timeline.test.ts
 * (samples/timeline_doc_cases.json); the pixels are tests/test_editor_shapes.py.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_OVERLAYS,
  MAX_PARTIAL_OPACITY_MOVES,
  addClip,
  freshId,
  newDocForAsset,
  splitClip,
  toDoc,
  toModel,
  validateTimeline,
  type EditorAsset,
  type EditorModel,
  type TimelineDoc,
} from "@/lib/editor";
import { addOverlay, canAddOverlay, updateOverlay } from "@/lib/editorOverlay";
import { settleAll } from "@/lib/editorSettle";
import { renderWork } from "@/lib/editorMotion";
import { setFrame } from "@/lib/editorFrame";
import {
  ARROW_DIRS,
  KIND_FIELDS,
  MAX_SHAPES,
  MEM_FIRST_LAYER_PER_FRAME_PX,
  MEM_LIMIT_BYTES,
  MEM_MARGIN_BYTES,
  MEM_PER_LAYER_BYTES,
  MEM_PER_PNG_PX,
  MEM_PLAIN_FIXED_BYTES,
  MEM_PLAIN_PER_FRAME_PX,
  PILL_MIN_ASPECT,
  PROGRESS_ANIMS,
  PROGRESS_EDGES,
  SHAPE_KINDS,
  SHAPE_TEXT_MAX,
  THICK_DEFAULTS,
  WORK_SECONDS_PER_LAYER_FRAME_1080P,
  WORK_SECONDS_PER_PNG_MP,
  memoryEstimateBytes,
  shapeWorkSeconds,
  cleanShapeText,
  cleanShapeTextReport,
  escapeShapeText,
  TEXT_RANGES,
  contrastOn,
  fitPx,
  pillAspectEstimate,
  progressCenterY,
  progressFill,
  progressHeightPx,
  shapePx,
  shapeTextProblem,
  starPoints,
  arrowPoints,
  type ShapeKind,
} from "@/lib/editorShapes";
import {
  SHAPE_DEFAULT_S,
  addShape,
  canAddShape,
  clearShapeMove,
  layerCount,
  moveShape,
  nudgeShape,
  removeShape,
  resetShape,
  setShapeAnim,
  setShapeAnimSeconds,
  setShapeEnd,
  setShapeKind,
  shapeAt,
  shapeAddCheck,
  shapeBudget,
  shapeById,
  shapeWarnings,
  shapesAt,
  shapesOf,
  startShapeMove,
  updateShape,
} from "@/lib/editorShapeModel";

const A = "11111111-1111-4111-8111-111111111111";
const PIC = "33333333-3333-4333-8333-333333333333";
const root = join(__dirname, "..", "..");
const pySource = readFileSync(join(root, "modules", "shape_art.py"), "utf8");
const fixture = JSON.parse(readFileSync(join(root, "samples", "shape_layout.json"), "utf8"));

const VIDEO: EditorAsset = {
  id: A,
  kind: "video",
  name: "beach.mp4",
  durationS: 10,
  width: 1920,
  height: 1080,
  viewUrl: "/v",
  thumbUrl: null,
};
const base = (): EditorModel => toModel(newDocForAsset(VIDEO)!);
const valid = (m: EditorModel) => expect(validateTimeline(toDoc(m))).toEqual([]);
const add = (m: EditorModel, kind: ShapeKind, at = 1, text = "") => {
  const out = addShape(m, kind, at, text);
  if (!out) throw new Error("not added");
  return out;
};

describe("the closed set is the worker's", () => {
  const tuple = (name: string) => {
    const body = new RegExp(`^${name} = \\(([^)]*)\\)`, "m").exec(pySource)![1];
    return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  it("kinds, directions, edges and the bar's animations", () => {
    expect([...SHAPE_KINDS]).toEqual(tuple("SHAPE_KINDS"));
    expect([...ARROW_DIRS]).toEqual(tuple("ARROW_DIRS"));
    expect([...PROGRESS_EDGES]).toEqual(tuple("PROGRESS_EDGES"));
    expect([...PROGRESS_ANIMS]).toEqual(tuple("PROGRESS_ANIMS"));
  });
  it("the limits", () => {
    const num = (name: string) => Number(new RegExp(`^${name} = ([\\d.]+)`, "m").exec(pySource)![1]);
    expect(MAX_SHAPES).toBe(num("MAX_SHAPES"));
    expect(SHAPE_TEXT_MAX).toBe(num("TEXT_MAX"));
    expect(MAX_OVERLAYS).toBe(num("MAX_LAYERS"));
    expect(THICK_DEFAULTS.line).toBe(0.008);
    expect(THICK_DEFAULTS.progress).toBe(0.012);
  });
  it("which fields each kind takes", () => {
    const block = /^KIND_FIELDS = \{(.*?)^\}/ms.exec(pySource)![1];
    for (const kind of SHAPE_KINDS) {
      const line = new RegExp(`"${kind}": \\(([^)]*)\\)`).exec(block)![1];
      expect([...KIND_FIELDS[kind]]).toEqual([...line.matchAll(/"(\w+)"/g)].map((m) => m[1]));
    }
  });
});

describe("the label's text rules agree with the worker's", () => {
  it("what is valid and what is not", () => {
    for (const ok of ["New", "abcdefghijklmnopqrstuvwx", "Obuna boʻling", "Подписаться", "{a} \\ b", "Łódź № 5€"])
      expect(shapeTextProblem(ok), ok).toBeNull();
    for (const bad of ["", "   ", "abcdefghijklmnopqrstuvwxy", "😀".repeat(25), "a\nb", "a\tb", "a\u0007b", "a‍b", "a b", "a b", 5, null])
      expect(shapeTextProblem(bad), String(bad)).not.toBeNull();
  });
  it("what a typed field keeps: no control characters, a line break is a space, at most 24 characters", () => {
    expect(cleanShapeText("a\nb")).toBe("a b");
    expect(cleanShapeText("a\u0007b‍c")).toBe("abc");
    expect(Array.from(cleanShapeText("x".repeat(40))).length).toBe(SHAPE_TEXT_MAX);
    expect(shapeTextProblem(cleanShapeText("x".repeat(200)))).toBeNull();
    expect(cleanShapeText("Hi 😀 日本")).toBe("Hi  ");
    expect(cleanShapeTextReport("Hi 😀")).toEqual({ text: "Hi ", dropped: true });
    expect(cleanShapeTextReport("Hi")).toEqual({ text: "Hi", dropped: false });
  });
  it("the preview writes the words the export draws (the same clean-up a text overlay's words get)", () => {
    expect(escapeShapeText("{a}  \\ b")).toBe("(a) / b");
    expect(escapeShapeText("  two   words ")).toBe("two words");
  });
  it("agrees with the worker on 1600 texts (samples/shape_text_cases.json)", () => {
    const cases = JSON.parse(readFileSync(join(root, "samples", "shape_text_cases.json"), "utf8")).cases as { text: string; ok: boolean }[];
    expect(cases.length).toBeGreaterThan(1000);
    for (const c of cases) expect(shapeTextProblem(c.text) === null, JSON.stringify(c.text)).toBe(c.ok);
  });
  it("the ranges are the worker's", () => {
    const body = /^TEXT_RANGES = \(\s*(.*?)\n\)/ms.exec(pySource)![1];
    const found = [...body.matchAll(/\(0x([0-9A-Fa-f]+), 0x([0-9A-Fa-f]+)\)/g)].map((m) => [parseInt(m[1], 16), parseInt(m[2], 16)]);
    expect(found).toEqual(TEXT_RANGES.map((r) => [...r]));
  });
});

describe("the geometry is the worker's (samples/shape_layout.json)", () => {
  it("every case: the size in pixels the export draws", () => {
    expect(fixture.cases.length).toBeGreaterThan(100);
    for (const c of fixture.cases) {
      const [width, height] = c.frame as [number, number];
      expect(shapePx(c.shape, c.w, { width, height }), c.name).toEqual(c.px);
    }
  });
  it("the bar's height is even, never under two pixels, and sits on its edge", () => {
    expect(progressHeightPx(0.012, 720)).toBe(8);
    expect(progressHeightPx(0.002, 720)).toBe(2);
    expect(progressCenterY({ thick: 0.012, edge: "bottom" }, 720)).toBeCloseTo(1 - 4 / 720, 12);
    expect(progressCenterY({ thick: 0.012, edge: "top" }, 720)).toBeCloseTo(4 / 720, 12);
  });
  it("a pill is only an estimate of the worker's width: within 15% for ordinary words", () => {
    const real: Record<string, number> = { New: 2.283, Subscribe: 4.301, "Link below": 4.615, "Part 2": 2.901, "Подписаться": 5.508, "Obuna boʻling": 5.812 };
    for (const [text, aspect] of Object.entries(real)) {
      const got = pillAspectEstimate(text);
      expect(Math.abs(got - aspect) / aspect, text).toBeLessThan(0.15);
    }
  });
  it("contrast text colour is the worker's threshold", () => {
    expect(contrastOn("#FFFFFF")).toBe("#111111");
    expect(contrastOn("#FFD60A")).toBe("#111111");
    expect(contrastOn("#000000")).toBe("#FFFFFF");
    expect(contrastOn("#0A84FF")).toBe("#FFFFFF");
  });
  it("the drawn polygons: a star has ten points inside its box and an arrow seven", () => {
    const pts = starPoints(100, 100).split(" ").map((p) => p.split(",").map(Number));
    expect(pts).toHaveLength(10);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(-0.01);
      expect(x).toBeLessThanOrEqual(100.01);
      expect(y).toBeGreaterThanOrEqual(-0.01);
      expect(y).toBeLessThanOrEqual(100.01);
    }
    expect(arrowPoints(200, 100).split(" ")).toHaveLength(7);
  });
  it("the bar fills from empty on its first frame to full on its last, by the clock", () => {
    const s = { start_s: 1, end_s: 3 }; // frames 30..89 at 30 fps
    expect(progressFill(s, 0.5, 30)).toBe(0);
    expect(progressFill(s, 1, 30)).toBe(0);
    expect(progressFill(s, 1 + 59 / 30, 30)).toBeCloseTo(1, 12);
    expect(progressFill(s, 2, 30)).toBeCloseTo(30 / 59, 9);
    expect(progressFill(s, 9, 30)).toBe(1);
    expect(progressFill({ start_s: 1, end_s: 1.034 }, 1, 30)).toBe(0);
  });
});

describe("adding", () => {
  it("each kind starts with its own look, in the middle (a label low, the bar on its edge)", () => {
    const m = base();
    for (const kind of SHAPE_KINDS) {
      const { model, id } = add(m, kind, 2, "Subscribe");
      const s = shapeById(model, id)!;
      expect(s.kind).toBe(kind);
      valid(model);
      if (kind === "progress") {
        expect([s.start_s, s.end_s]).toEqual([0, 10]);
        expect(s.x).toBeUndefined();
      } else {
        expect(s.start_s).toBe(2);
        expect(s.end_s).toBe(2 + SHAPE_DEFAULT_S);
        expect(s.x).toBe(0.5);
      }
    }
    const made = (kind: ShapeKind, text = "") => {
      const o = add(m, kind, 0, text);
      return shapeById(o.model, o.id)!;
    };
    expect(made("circle").outline).toBe(0.1);
    expect(made("pill", "Link below").text).toBe("Link below");
    expect(made("pill", "").text).toBe("…");
  });
  it("is shorter where the picture ends sooner, and never starts past it", () => {
    const near = add(base(), "star", 8);
    expect(shapeById(near.model, near.id)!.end_s).toBe(10);
    const late = add(base(), "star", 99);
    const s = shapeById(late.model, late.id)!;
    expect(s.start_s).toBeLessThan(10);
    valid(late.model);
  });
  it("ids never collide with clips, texts, overlays or tracks", () => {
    let m = base();
    for (let i = 0; i < 5; i += 1) m = add(m, "star").model;
    const ids = shapesOf(m).map((s) => s.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids).not.toContain("c1");
    expect(freshId(m, "h")).not.toBe("h1");
  });
  it("stops at the shapes limit, and the layers it shares with the pictures", () => {
    let m = base();
    for (let i = 0; i < MAX_SHAPES; i += 1) m = add(m, "line").model;
    expect(canAddShape(m)).toBe(false);
    expect(addShape(m, "line", 0)).toBeNull();
    valid(m);
    // pictures and shapes together are at most MAX_OVERLAYS layers
    let n = base();
    for (let i = 0; i < 4; i += 1) n = add(n, "line").model; // 4 shapes
    for (let i = 0; i < MAX_OVERLAYS - 4; i += 1) {
      const o = addOverlay(n, { id: PIC, kind: "image", durationS: null }, 0);
      expect(o, `overlay ${i}`).not.toBeNull();
      n = o!.model;
    }
    expect(layerCount(n)).toBe(MAX_OVERLAYS);
    expect(canAddOverlay(n)).toBe(false);
    expect(canAddShape(n)).toBe(false);
    valid(n);
    expect(addOverlay(n, { id: PIC, kind: "image", durationS: null }, 0)).toBeNull();
  });
});

describe("what the shapes cost the export", () => {
  const budget = JSON.parse(readFileSync(join(root, "samples", "shape_budget.json"), "utf8"));
  it("memory and render time agree with the worker's estimates on 80 documents (samples/shape_budget.json)", () => {
    expect(budget.cases.length).toBe(80);
    for (const c of budget.cases) {
      const frame = { width: c.frame[0], height: c.frame[1] };
      expect(memoryEstimateBytes(c.shapes, frame)).toBe(c.memory);
      expect(Math.abs(shapeWorkSeconds(c.shapes, c.fps, frame, c.length) - c.work)).toBeLessThan(1e-6);
    }
  });
  it("the budgets' constants are the worker's", () => {
    const num = (name: string) => Number(new RegExp(`^${name} = ([\\d.]+)`, "m").exec(pySource)![1]);
    expect(MEM_PLAIN_PER_FRAME_PX).toBe(num("MEM_PLAIN_PER_FRAME_PX"));
    expect(MEM_PER_PNG_PX).toBe(num("MEM_PER_PNG_PX"));
    expect(MEM_FIRST_LAYER_PER_FRAME_PX).toBe(num("MEM_FIRST_LAYER_PER_FRAME_PX"));
    expect(PILL_MIN_ASPECT).toBe(num("PILL_MIN_ASPECT"));
    expect(WORK_SECONDS_PER_LAYER_FRAME_1080P).toBe(num("WORK_SECONDS_PER_LAYER_FRAME_1080P"));
    expect(WORK_SECONDS_PER_PNG_MP).toBe(num("WORK_SECONDS_PER_PNG_MP"));
    const mib = (name: string) => Number(new RegExp(`^${name} = (\\d+) \\* MIB`, "m").exec(pySource)![1]) * 1048576;
    expect(MEM_LIMIT_BYTES).toBe(mib("MEM_LIMIT_BYTES"));
    expect(MEM_MARGIN_BYTES).toBe(mib("MEM_MARGIN_BYTES"));
    expect(MEM_PLAIN_FIXED_BYTES).toBe(mib("MEM_PLAIN_FIXED_BYTES"));
    expect(MEM_PER_LAYER_BYTES).toBe(mib("MEM_PER_LAYER_BYTES"));
  });
  const twelve = (m: EditorModel, w: number) => {
    let n = m;
    for (let i = 0; i < 12; i += 1) {
      const o = add(n, "circle", 0);
      n = updateShape(o.model, o.id, { w });
    }
    return n;
  };
  it("a shape stops growing where the export's memory ends, the others are not touched", () => {
    let m = base();
    for (let i = 0; i < 11; i += 1) {
      const o = add(m, "circle", 0);
      m = updateShape(o.model, o.id, { w: 0.9 });
    }
    const last = add(m, "circle", 0);
    m = updateShape(last.model, last.id, { w: 0.3 });
    valid(m);
    const grown = updateShape(m, last.id, { w: 1 });
    valid(grown);
    expect(shapeById(grown, last.id)!.w).toBeLessThan(1);
    expect(shapeById(grown, last.id)!.w).toBeGreaterThan(0.3);
    expect(shapeById(grown, m.shapes![0].id)!.w).toBe(0.9);
    expect(shapeBudget(grown).memory).toBeLessThanOrEqual(shapeBudget(grown).memoryMax);
  });
  it("adding the twelfth big shape narrows it to fit; when the others leave no room it is refused with the reason", () => {
    let m = base();
    for (let i = 0; i < 11; i += 1) {
      const o = add(m, "circle", 0);
      m = updateShape(o.model, o.id, { w: 0.9 });
    }
    valid(m);
    const o = addShape(m, "circle", 0);
    expect(o).not.toBeNull();
    valid(o!.model);
    expect(shapeAddCheck(m, "circle", 0)).toBe("ok");
    // at 4K the plain clip already takes most of the memory
    const big: EditorModel = { ...base(), width: 3840, height: 2160 };
    let n = big;
    let refused = 0;
    for (let i = 0; i < 6; i += 1) {
      const a = addShape(n, "circle", 0);
      if (a) n = a.model;
      else refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
    expect(shapeAddCheck(n, "circle", 0)).toBe("memory");
    valid(n);
  });
  it("a long, busy timeline at a high frame rate is charged render time, and refused early", () => {
    let m: EditorModel = { ...base(), fps: 60, clips: [{ ...base().clips[0], out_s: 600 }] };
    let said = "";
    for (let i = 0; i < 12; i += 1) {
      const o = addShape(m, "circle", 0);
      if (!o) {
        said = shapeAddCheck(m, "circle", 0);
        break;
      }
      m = updateShape(o.model, o.id, { w: 0.6, start_s: 0, end_s: 600 });
    }
    expect(said).toBe("time");
    valid(m);
    expect(renderWork(m).shapeEst).toBeGreaterThan(0);
  });
  it("settling after the frame grows: the widest shapes are narrowed, then the last ones removed, and it is valid", () => {
    const m = twelve(base(), 0.8);
    valid(m);
    const big: EditorModel = { ...m, width: 3840, height: 2160 };
    expect(validateTimeline(toDoc(big)).length).toBeGreaterThan(0);
    const out = settleAll(big);
    valid(out.model);
    expect(out.changes.some((c) => c.kind === "shapeNarrowed" || c.kind === "shapeRemoved")).toBe(true);
    expect(settleAll(out.model).changes).toEqual([]);
    // a project that fits is left alone
    expect(settleAll(m)).toEqual({ model: m, changes: [] });
  });
});

describe("changing a shape keeps it a shape the document accepts", () => {
  const circle = () => {
    const { model, id } = add(base(), "circle", 1);
    return { m: model, id };
  };
  it("numbers are brought into range and to the document's precision", () => {
    const { m, id } = circle();
    const s = shapeById(updateShape(m, id, { x: 9, y: -3, w: 0.001, opacity: 7, outline: 3 }), id)!;
    expect([s.x, s.y, s.w, s.opacity, s.outline]).toEqual([1, 0, 0.05, 1, 0.5]);
    expect(shapeById(updateShape(m, id, { x: 0.123456 }), id)!.x).toBe(0.123);
    expect(shapeById(updateShape(m, id, { x: Number.NaN }), id)!.x).toBe(0.5);
    expect(shapeById(updateShape(m, id, { outline: 0 }), id)!.outline).toBeUndefined();
    valid(updateShape(m, id, { x: 9 }));
  });
  it("the same model back when nothing changes (not an undo step)", () => {
    const { m, id } = circle();
    expect(updateShape(m, id, {})).toBe(m);
    expect(updateShape(m, id, { x: 0.5 })).toBe(m);
    expect(updateShape(m, "nope", { x: 0.1 })).toBe(m);
  });
  it("a start alone slides the span; the span keeps one frame and the picture's reach", () => {
    const { m, id } = circle();
    const s = shapeById(updateShape(m, id, { start_s: 4 }), id)!;
    expect([s.start_s, s.end_s]).toEqual([4, 4 + SHAPE_DEFAULT_S]);
    const short = shapeById(updateShape(m, id, { end_s: 0 }), id)!;
    expect(short.end_s).toBeCloseTo(short.start_s + 0.1, 9);
    valid(updateShape(m, id, { end_s: 0 }));
    expect(shapeById(updateShape(m, id, { start_s: -5 }), id)!.start_s).toBe(0);
  });
  it("a colour that is not #RRGGBB is not taken; a good one is kept in capitals", () => {
    const { m, id } = circle();
    expect(updateShape(m, id, { color: "red" })).toBe(m);
    expect(updateShape(m, id, { color: "#fff" })).toBe(m);
    expect(shapeById(updateShape(m, id, { color: "#ff3b30" }), id)!.color).toBe("#FF3B30");
  });
  it("a label is never empty: the last words stay", () => {
    const { model: m, id } = add(base(), "pill", 1, "Subscribe");
    expect(updateShape(m, id, { text: "" })).toBe(m);
    expect(updateShape(m, id, { text: "   " })).toBe(m);
    expect(shapeById(updateShape(m, id, { text: "New" }), id)!.text).toBe("New");
    expect(shapeById(updateShape(m, id, { text: "x".repeat(50) }), id)!.text).toHaveLength(SHAPE_TEXT_MAX);
    valid(updateShape(m, id, { text: "{a}\n\\" }));
  });
  it("a field the kind does not take is dropped, never kept", () => {
    const { m, id } = circle();
    const s = shapeById(updateShape(m, id, { aspect: 3, dir: "up", thick: 0.02, text: "x", edge: "top" } as never), id)!;
    for (const k of ["aspect", "dir", "thick", "text", "edge"]) expect(s).not.toHaveProperty(k);
    valid(updateShape(m, id, { aspect: 3, dir: "up", text: "x" } as never));
  });
  it("a bar takes a fade only and cannot move; its position is not a field", () => {
    const { model: m, id } = add(base(), "progress");
    expect(setShapeAnim(m, id, "in", "pop")).toBe(m);
    expect(setShapeAnim(m, id, "out", "slide-up")).toBe(m);
    const faded = setShapeAnim(m, id, "in", "fade");
    expect(shapeById(faded, id)!.anim_in).toBe("fade");
    expect(startShapeMove(m, id)).toBe(m);
    const s = shapeById(updateShape(m, id, { x: 0.2, move: { to: { x: 0.9 } }, anim_in: "pop" } as never), id)!;
    for (const k of ["x", "y", "w", "move", "anim_in"]) expect(s).not.toHaveProperty(k);
    valid(faded);
    expect(nudgeShape(m, id, 1, 0)).toBe(m);
  });
  it("entrance and exit fit the time shown, and shrink with it", () => {
    const { m, id } = circle();
    let n = setShapeAnim(m, id, "in", "fade");
    n = setShapeAnim(n, id, "out", "slide-left");
    n = setShapeAnimSeconds(n, id, "in", 2);
    valid(n);
    const shorter = updateShape(n, id, { end_s: shapeById(n, id)!.start_s + 1 });
    valid(shorter);
    const s = shapeById(shorter, id)!;
    expect((s.anim_in_s ?? 0) + (s.anim_out_s ?? 0)).toBeLessThanOrEqual(1 + 1e-9);
    const tiny = updateShape(n, id, { end_s: shapeById(n, id)!.start_s + 0.1 });
    valid(tiny);
    expect(setShapeAnim(n, id, "in", null)).not.toBe(n);
  });
  it("a move: position and size only, from the shape's own values, dropped when nothing is left", () => {
    const { m, id } = circle();
    const moving = startShapeMove(m, id);
    expect(shapeById(moving, id)!.move).toEqual({ to: { x: 0.75 } });
    valid(moving);
    const wide = setShapeEnd(moving, id, "w", 0.9);
    expect(shapeById(wide, id)!.move!.to.w).toBe(0.9);
    expect(shapeById(setShapeEnd(wide, id, "w", 0.2), id)!.move!.to).toEqual({ x: 0.75 });
    expect(shapeById(setShapeEnd(moving, id, "x", 0.5), id)!.move).toBeUndefined();
    expect(shapeById(setShapeEnd(moving, id, "x", 7), id)!.move!.to.x).toBe(1);
    expect(shapeById(clearShapeMove(moving, id), id)!.move).toBeUndefined();
    const s = shapeById(moving, id)!;
    expect(shapeAt(s, s.start_s).x).toBe(0.5);
    expect(shapeAt(s, (s.start_s + s.end_s) / 2).x).toBeCloseTo(0.625, 9);
    expect(shapeAt(s, s.end_s + 9).x).toBe(0.75);
    // changing the shape's own x so it equals the end drops that end
    const same = updateShape(moving, id, { x: 0.75 });
    expect(shapeById(same, id)!.move).toBeUndefined();
    valid(same);
  });
  it("another kind keeps the span, colour and opacity and starts the new kind's own look", () => {
    const { m, id } = circle();
    let n = updateShape(m, id, { color: "#FF3B30", opacity: 0.5, start_s: 2, end_s: 5 });
    n = setShapeAnim(n, id, "in", "pop");
    const star = shapeById(setShapeKind(n, id, "star"), id)!;
    expect([star.kind, star.color, star.opacity, star.start_s, star.end_s, star.anim_in]).toEqual(["star", "#FF3B30", 0.5, 2, 5, "pop"]);
    expect(star).not.toHaveProperty("outline");
    const bar = shapeById(setShapeKind(n, id, "progress", "x"), id)!;
    expect(bar).not.toHaveProperty("anim_in");
    expect(bar).not.toHaveProperty("anim_in_s");
    expect(bar.edge).toBe("bottom");
    valid(setShapeKind(n, id, "progress"));
    const pill = shapeById(setShapeKind(n, id, "pill", "Subscribe"), id)!;
    expect(pill.text).toBe("Subscribe");
    expect(setShapeKind(n, id, "circle")).toBe(n);
    for (const k of SHAPE_KINDS) valid(setShapeKind(n, id, k, "Hi"));
  });
  it("reset puts position, size and opacity back; the span and colour stay", () => {
    const { m, id } = circle();
    const n = updateShape(m, id, { x: 0.1, y: 0.9, w: 0.7, opacity: 0.2, color: "#FF3B30", start_s: 3 });
    const r = shapeById(resetShape(n, id), id)!;
    expect([r.x, r.y, r.w, r.opacity]).toEqual([0.5, 0.5, 0.2, 1]);
    expect([r.color, r.start_s]).toEqual(["#FF3B30", 3]);
    valid(resetShape(n, id));
  });
  it("nudge moves the centre by whole steps", () => {
    const { m, id } = circle();
    const s = shapeById(nudgeShape(m, id, 1, -1, 0.05), id)!;
    expect([s.x, s.y]).toEqual([0.55, 0.45]);
  });
});

describe("the list", () => {
  it("is layered in list order; remove drops the field with the last one; reorder swaps neighbours", () => {
    let m = base();
    m = add(m, "star").model;
    m = add(m, "circle").model;
    const [a, b] = shapesOf(m);
    expect(shapesOf(moveShape(m, a.id, 1)).map((s) => s.id)).toEqual([b.id, a.id]);
    expect(moveShape(m, a.id, -1)).toBe(m);
    expect(moveShape(m, b.id, 1)).toBe(m);
    const one = removeShape(m, a.id);
    expect(shapesOf(one)).toHaveLength(1);
    const none = removeShape(one, b.id);
    expect(none.shapes).toBeUndefined();
    expect("shapes" in toDoc(none)).toBe(false);
    expect(removeShape(none, "x")).toBe(none);
  });
  it("what is on screen at the playhead, bottom layer first", () => {
    let m = add(base(), "star", 1).model;
    m = add(m, "circle", 3).model;
    expect(shapesAt(m, 0.5)).toHaveLength(0);
    expect(shapesAt(m, 3.5).map((s) => s.kind)).toEqual(["star", "circle"]);
    expect(shapesAt(m, 6.5).map((s) => s.kind)).toEqual(["circle"]);
    expect(shapesAt(m, 7.5)).toHaveLength(1);
    expect(shapesAt(m, 8)).toHaveLength(0);
  });
  it("warns about what would not show", () => {
    let m = add(base(), "star", 1).model;
    const id = m.shapes![0].id;
    expect(shapeWarnings(m)).toEqual({});
    expect(shapeWarnings(updateShape(m, id, { opacity: 0 }))[id]).toBe("invisible");
    expect(shapeWarnings(updateShape(m, id, { start_s: 9, end_s: 12 }))[id]).toBe("cut_end");
    const past = { ...m, shapes: [{ ...m.shapes![0], start_s: 11, end_s: 12 }] };
    expect(shapeWarnings(past)[id]).toBe("past_end");
    m = updateShape(m, id, { end_s: 30 });
    expect(shapeWarnings(m)[id]).toBe("cut_end");
  });
});

describe("the round trip through the document", () => {
  const doc = (): TimelineDoc => {
    let m = base();
    for (const kind of SHAPE_KINDS) m = add(m, kind, 1, "Part 2").model;
    const [first, second] = shapesOf(m);
    m = setShapeAnim(m, first.id, "in", "slide-left");
    m = startShapeMove(m, second.id);
    return toDoc(m);
  };
  it("toDoc writes only what each kind takes and the validator accepts it", () => {
    const d = doc();
    expect(validateTimeline(d)).toEqual([]);
    const shapes = d.shapes as Record<string, unknown>[];
    expect(shapes).toHaveLength(7);
    for (const s of shapes) {
      const kind = s.kind as ShapeKind;
      for (const k of Object.keys(s)) {
        const common = ["id", "kind", "start_s", "end_s", "color", "opacity", "anim_in", "anim_out", "anim_in_s", "anim_out_s"];
        expect(common.includes(k) || KIND_FIELDS[kind].includes(k), `${kind}.${k}`).toBe(true);
      }
    }
    expect(Object.keys(shapes[6])).not.toContain("x");
  });
  it("a move's end values are written to a millisecond-like precision, as the worker keeps them", () => {
    const o = add(base(), "star", 1);
    const m = { ...o.model, shapes: [{ ...o.model.shapes![0], move: { to: { x: 0.5333073102668435, w: 0.6666666 } } }] };
    const written = (toDoc(m).shapes as { move: { to: Record<string, number> } }[])[0].move.to;
    expect(written).toEqual({ x: 0.533, w: 0.667 });
  });
  it("toModel(toDoc(m)) is m, and a second pass changes nothing", () => {
    const d = doc();
    const back = toDoc(toModel(d));
    expect(back.shapes).toEqual(d.shapes);
    expect(toDoc(toModel(back))).toEqual(back);
  });
  it("a document without shapes has no shapes field in either direction", () => {
    expect("shapes" in toDoc(base())).toBe(false);
    expect(toModel(toDoc(base())).shapes).toBeUndefined();
    expect(toModel({ ...newDocForAsset(VIDEO)!, shapes: [] }).shapes).toBeUndefined();
  });
  it("what is not a usable entry is left out of the model instead of crashing it", () => {
    const d = { ...newDocForAsset(VIDEO)!, shapes: ["x", null, { id: 3 }, { id: "s", kind: "triangle", start_s: 0, end_s: 1 }, { id: "ok", kind: "star", start_s: 0, end_s: 1 }] } as TimelineDoc;
    expect(toModel(d).shapes!.map((s) => s.id)).toEqual(["ok"]);
  });
  it("splitting a clip leaves the shapes alone", () => {
    let m = addClip(add(base(), "star").model, VIDEO);
    const before = m.shapes;
    const out = splitClip(m, m.clips[0].id, 2);
    expect(out).not.toBeNull();
    expect(out!.model.shapes).toBe(before);
    m = out!.model;
    valid(m);
  });
  it("shapes leave the per-pixel opacity budget alone", () => {
    let m = base();
    for (let i = 0; i < MAX_SHAPES; i += 1) {
      const o = add(m, "star", 0);
      m = startShapeMove(o.model, o.id);
    }
    valid(m);
    expect(MAX_PARTIAL_OPACITY_MOVES).toBe(2);
    const doc2 = toDoc(m);
    expect(JSON.stringify(doc2.shapes)).not.toContain("opacity\":0.");
  });
});

describe("every edit through the editor's own settle step leaves a valid document (a fuzz)", () => {
  // a small deterministic generator, so a failure names its step
  function rng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }
  it("random edits of every kind, frame changes and removals: always valid", () => {
    const rand = rng(7);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    let m = base();
    const log: string[] = [];
    for (let step = 0; step < 400; step += 1) {
      const ids = shapesOf(m).map((s) => s.id);
      const op = pick(["add", "add", "upd", "upd", "upd", "kind", "anim", "animS", "move", "end", "remove", "reorder", "frame", "bigframe", "overlay", "text", "color"] as const);
      const id = ids.length ? pick(ids) : "";
      const before = m;
      try {
        switch (op) {
          case "add":
            m = addShape(m, pick(SHAPE_KINDS), rand() * 12, pick(["Subscribe", "", "x".repeat(40), "a\nb"]))?.model ?? m;
            break;
          case "upd":
            m = updateShape(m, id, {
              ...(rand() < 0.5 ? { x: rand() * 3 - 1 } : {}),
              ...(rand() < 0.5 ? { w: rand() * 2 } : {}),
              ...(rand() < 0.4 ? { opacity: rand() * 2 - 0.5 } : {}),
              ...(rand() < 0.4 ? { outline: rand() } : {}),
              ...(rand() < 0.3 ? { aspect: rand() * 8 } : {}),
              ...(rand() < 0.3 ? { thick: rand() / 10 } : {}),
              ...(rand() < 0.3 ? { start_s: rand() * 14 - 1 } : {}),
              ...(rand() < 0.3 ? { end_s: rand() * 14 - 1 } : {}),
              ...(rand() < 0.3 ? { text: pick(["", "ok", "😀".repeat(30), "\u0007"]) } : {}),
              ...(rand() < 0.2 ? { color: pick(["#fff", "#123456", "nope"]) } : {}),
            } as never);
            break;
          case "kind":
            m = setShapeKind(m, id, pick(SHAPE_KINDS), pick(["Hi", ""]));
            break;
          case "anim":
            m = setShapeAnim(m, id, pick(["in", "out"] as const), pick(["fade", "pop", "slide-up", "slide-left", null, "typewriter"]));
            break;
          case "animS":
            m = setShapeAnimSeconds(m, id, pick(["in", "out"] as const), rand() * 4);
            break;
          case "move":
            m = rand() < 0.5 ? startShapeMove(m, id) : clearShapeMove(m, id);
            break;
          case "end":
            m = setShapeEnd(m, id, pick(["x", "y", "w"] as const), rand() * 2 - 0.5);
            break;
          case "remove":
            if (rand() < 0.3) m = removeShape(m, id);
            break;
          case "reorder":
            m = moveShape(m, id, pick([-1, 1] as const));
            break;
          case "frame":
            m = setFrame(m, pick(["9:16", "16:9", "1:1"] as const));
            break;
          case "bigframe":
            m = rand() < 0.5 ? { ...m, width: 3840, height: 2160 } : { ...m, width: 1920, height: 1080 };
            break;
          case "overlay":
            m = addOverlay(m, { id: PIC, kind: "image", durationS: null }, rand() * 8)?.model ?? m;
            break;
          case "text":
            m = ids.length ? updateOverlay(m, "o1", { opacity: rand() }) : m;
            break;
          case "color":
            m = updateShape(m, id, { color: pick(["#FF3B30", "#0A84FF", "#FFD60A"]) });
            break;
        }
      } catch (e) {
        throw new Error(`step ${step} (${op}) threw: ${String(e)}\n${log.slice(-5).join("\n")}`);
      }
      m = settleAll(m).model;
      log.push(`${step} ${op} ${id}`);
      const problems = validateTimeline(toDoc(m));
      if (problems.length) throw new Error(`step ${step} (${op}) left an invalid document: ${problems.join("; ")}\n${log.slice(-5).join("\n")}`);
      expect(layerCount(m)).toBeLessThanOrEqual(MAX_OVERLAYS);
      expect(shapesOf(m).length).toBeLessThanOrEqual(MAX_SHAPES);
      if (before === m) continue;
    }
    expect(shapesOf(m).length + (m.overlays?.length ?? 0)).toBeGreaterThan(0);
  });
});
