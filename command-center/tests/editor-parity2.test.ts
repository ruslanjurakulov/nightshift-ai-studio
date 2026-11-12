/**
 * Editor parity 2 (model half): advanced colour and masks on a video clip (lib/editor.ts validators and
 * cost, lib/editorLook.ts operations, lib/editorSettle.ts). What would break without these: the editor
 * and the worker disagreeing on a document (samples/timeline_parity2_fuzz.json is judged by both; the
 * Python half is tests/test_editor_parity2_fuzz.py), a control writing a value the validator refuses,
 * a colour of zeros saved as a field older workers refuse, an edit elsewhere leaving the timeline over
 * the export's time with nothing said, or the numbers drifting from modules/timeline.py.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COLOR_CHROMA_SECONDS_PER_S,
  COLOR_CURVES,
  COLOR_CURVE_SECONDS_PER_S,
  COLOR_HUE_SECONDS_PER_S,
  MASK_SECONDS_PER_S,
  MASK_SHAPES,
  lookSeconds,
  newDocForAsset,
  toDoc,
  toModel,
  validateTimeline,
  type EditorModel,
  type VideoClip,
} from "@/lib/editor";
import {
  hasColor,
  lookCheck,
  maskOf,
  maskPreviewStyle,
  resetClipColor,
  setClipColor,
  setClipCurve,
  setClipMaskInvert,
  setClipMaskShape,
  setClipMaskValue,
} from "@/lib/editorLook";
import { renderWork } from "@/lib/editorMotion";
import { settleAll } from "@/lib/editorSettle";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const ROOT = join(__dirname, "..", "..");
const A = "11111111-1111-4111-8111-111111111111";
const model = (clip: Partial<VideoClip> = {}, durationS = 10, frame = { width: 1920, height: 1080 }): EditorModel => {
  const m = toModel(newDocForAsset({ id: A, durationS, ...frame })!);
  return { ...m, clips: m.clips.map((c) => ({ ...c, ...clip })) };
};
const c0 = (m: EditorModel) => m.clips[0];

describe("both validators agree on the seeded fuzz of colour and masks", () => {
  const corpus = JSON.parse(readFileSync(join(ROOT, "samples", "timeline_parity2_fuzz.json"), "utf8")) as {
    cases: { valid: boolean; doc: unknown }[];
  };
  it("judges every document as modules/timeline.py did", () => {
    expect(corpus.cases.length).toBe(400);
    const wrong = corpus.cases
      .map((c, i) => ({ i, py: c.valid, ts: validateTimeline(c.doc).length === 0, why: validateTimeline(c.doc) }))
      .filter((x) => x.py !== x.ts);
    expect(wrong).toEqual([]);
    expect(corpus.cases.filter((c) => c.valid).length).toBeGreaterThan(80);
  });
});

describe("the numbers are modules/timeline.py's", () => {
  const py = readFileSync(join(ROOT, "modules", "timeline.py"), "utf8");
  const num = (name: string) => Number(new RegExp(`^${name} = ([0-9.]+)`, "m").exec(py)![1]);
  it("costs, lists and limits", () => {
    expect(num("COLOR_CHROMA_SECONDS_PER_S")).toBe(COLOR_CHROMA_SECONDS_PER_S);
    expect(num("COLOR_HUE_SECONDS_PER_S")).toBe(COLOR_HUE_SECONDS_PER_S);
    expect(num("COLOR_CURVE_SECONDS_PER_S")).toBe(COLOR_CURVE_SECONDS_PER_S);
    expect(num("MASK_SECONDS_PER_S")).toBe(MASK_SECONDS_PER_S);
    expect(py).toContain(`COLOR_CURVES = (${COLOR_CURVES.map((c) => `"${c}"`).join(", ")})`);
    expect(py).toContain(`MASK_SHAPES = (${MASK_SHAPES.map((c) => `"${c}"`).join(", ")})`);
  });
  it("the cost scales with the frame's pixels and rate, and is the clip's length", () => {
    const c = { in_s: 0, out_s: 10, speed: 1, color: { hue: 5 }, mask: { shape: "rect" } } as unknown as VideoClip;
    expect(lookSeconds(c, 30, 1920, 1080)).toBeCloseTo(10 * (COLOR_HUE_SECONDS_PER_S + MASK_SECONDS_PER_S), 6);
    expect(lookSeconds(c, 60, 3840, 2160)).toBeCloseTo(8 * 10 * (COLOR_HUE_SECONDS_PER_S + MASK_SECONDS_PER_S), 6);
    expect(lookSeconds({ ...c, speed: 2 }, 30, 1920, 1080)).toBeCloseTo(5 * (COLOR_HUE_SECONDS_PER_S + MASK_SECONDS_PER_S), 6);
    expect(lookSeconds({ in_s: 0, out_s: 10, speed: 1 } as VideoClip, 30, 1920, 1080)).toBe(0);
  });
});

describe("colour", () => {
  it("each control writes a value the validator takes, and zero is no field", () => {
    let m = model();
    const id = c0(m).id;
    m = setClipColor(m, id, "temperature", 250);
    expect(c0(m).color).toEqual({ temperature: 100 });
    m = setClipColor(m, id, "hue", -400);
    m = setClipCurve(m, id, "matte");
    expect(c0(m).color).toEqual({ temperature: 100, hue: -180, curve: "matte" });
    expect(validateTimeline(toDoc(m))).toEqual([]);
    m = setClipColor(setClipColor(setClipCurve(m, id, null), id, "temperature", 0), id, "hue", 0);
    expect("color" in c0(m)).toBe(false);
    expect(hasColor(c0(m))).toBe(false);
    expect(toDoc(m)).toEqual(toDoc(model()));
    expect("color" in c0(resetClipColor(setClipColor(m, id, "tint", 5), id))).toBe(false);
  });

  it("survives a round trip through the document, and a colour of zeros read from one is none", () => {
    const m = setClipCurve(setClipColor(model(), c0(model()).id, "tint", -40), c0(model()).id, "contrast");
    expect(c0(toModel(toDoc(m))).color).toEqual({ tint: -40, curve: "contrast" });
    const d = toDoc(model());
    (d.tracks[0].clips[0] as Record<string, unknown>).color = { temperature: 0 };
    expect("color" in c0(toModel(d))).toBe(false);
  });
});

describe("masks", () => {
  it("a new mask is centred at 60 %, a rounded one has corners, and the values stay in range", () => {
    let m = model();
    const id = c0(m).id;
    m = setClipMaskShape(m, id, "ellipse");
    expect(c0(m).mask).toEqual({ shape: "ellipse" });
    expect(maskOf(c0(m).mask!)).toMatchObject({ x: 0.5, y: 0.5, w: 0.6, h: 0.6, feather: 0, radius: 0, invert: false });
    m = setClipMaskValue(m, id, "radius", 0.3);
    expect(c0(m).mask!.radius).toBeUndefined();
    m = setClipMaskShape(m, id, "rounded");
    expect(c0(m).mask!.radius).toBe(0.25);
    m = setClipMaskValue(setClipMaskValue(m, id, "w", 0), id, "feather", 9);
    expect(c0(m).mask).toMatchObject({ w: 0.05, feather: 0.5 });
    m = setClipMaskInvert(m, id, true);
    expect(validateTimeline(toDoc(m))).toEqual([]);
    m = setClipMaskShape(m, id, "rect");
    expect(c0(m).mask!.radius).toBeUndefined();
    expect(validateTimeline(toDoc(m))).toEqual([]);
    m = setClipMaskShape(m, id, null);
    expect("mask" in c0(m)).toBe(false);
    expect(c0(toModel(toDoc(setClipMaskShape(model(), id, "rounded")))).mask).toEqual({ shape: "rounded", radius: 0.25 });
  });

  it("the preview draws the shape where the export does (approximately)", () => {
    expect(maskPreviewStyle(undefined)).toEqual({});
    expect(maskPreviewStyle({ shape: "rect", x: 0.25, w: 0.5, h: 1 }).clipPath).toBe("inset(0.00% 50.00% 0.00% 0.00%)");
    expect(String(maskPreviewStyle({ shape: "rect", invert: true }).clipPath)).toContain("evenodd");
    expect(String(maskPreviewStyle({ shape: "ellipse" }).maskImage)).toContain("radial-gradient(ellipse 30.00% 30.00% at 50.00% 50.00%");
    expect(String(maskPreviewStyle({ shape: "rounded" }).clipPath)).toContain("round 15.00%");
  });
});

describe("the export's time allowance", () => {
  it("counts colour and masks, and a change that would not fit is refused", () => {
    const big = { ...model({}, 600), width: 3840, height: 2160, fps: 60 };
    const id = c0(big).id;
    expect(renderWork(big).ok).toBe(true);
    const masked = setClipMaskShape(big, id, "rect");
    expect(renderWork(masked).lookEst).toBeGreaterThan(0);
    expect(lookCheck(masked).ok).toBe(false);
    expect(validateTimeline(toDoc(masked)).join(" ")).toContain("colour, masks and effects");
    // the same at 1080p30 fits
    const small = setClipMaskShape(model({}, 600), c0(model({}, 600)).id, "rect");
    expect(lookCheck(small).ok).toBe(true);
  });

  it("an edit elsewhere that pushes it over takes the colour and mask off and says so", () => {
    const m0 = model({ color: { hue: 30, curve: "contrast" }, mask: { shape: "ellipse" } }, 600);
    expect(validateTimeline(toDoc(m0))).toEqual([]);
    const bigger = { ...m0, width: 3840, height: 2160, fps: 60 };
    const { model: out, changes } = settleAll(bigger, m0);
    expect(changes).toContainEqual({ kind: "look", clip: 1 });
    expect(c0(out).color).toBeUndefined();
    expect(c0(out).mask).toBeUndefined();
    expect(validateTimeline(toDoc(out))).toEqual([]);
    // nothing changes while it fits
    expect(settleAll(m0).changes).toEqual([]);
  });
});

describe("masks in a frame above 1440p (measured: out of memory)", () => {
  it("a cross-faded clip's mask comes off and a masked clip's zoom is held at 2, with a notice", () => {
    const m0 = model({}, 10);
    const two = {
      ...m0,
      width: 3840,
      height: 2160,
      clips: [
        { ...c0(m0), out_s: 4, mask: { shape: "ellipse" as const } },
        { ...c0(m0), id: "c9", start_s: 3.5, out_s: 4, mask: { shape: "rect" as const }, transition: { type: "crossfade" as const, duration_s: 0.5 } },
        { ...c0(m0), id: "c8", start_s: 7.5, out_s: 3, mask: { shape: "rect" as const }, move: { from: { zoom: 1 }, to: { zoom: 3 } } },
      ],
    };
    expect(validateTimeline(toDoc(two)).join(" ")).toContain("a mask is not offered on a cross-faded clip");
    const { model: out, changes } = settleAll(two);
    expect(changes).toEqual(
      expect.arrayContaining([
        { kind: "mask", clip: 1 },
        { kind: "mask", clip: 2 },
        { kind: "zoom", clip: 3, max: 2 },
      ]),
    );
    expect(out.clips.map((c) => Boolean(c.mask))).toEqual([false, false, true]);
    expect(validateTimeline(toDoc(out))).toEqual([]);
  });
});

describe("strings", () => {
  it("every language has every sentence (ru and uz are drafts)", () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v).map((x) => `${k}.${x}`) : [k]));
    expect(keys(ru.editor.parity2)).toEqual(keys(en.editor.parity2));
    expect(keys(uz.editor.parity2)).toEqual(keys(en.editor.parity2));
    for (const c of COLOR_CURVES) expect(en.editor.parity2.color.curves[c]).toBeTruthy();
  });
});
