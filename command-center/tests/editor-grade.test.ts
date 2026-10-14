/**
 * A clip's colour grade: pure model edits, the document's validation, and the
 * preview matrix pinned to the fixture the Python parity test measures a real
 * ffmpeg export against (samples/clip_grade_preview.json,
 * tests/test_editor_grade.py).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  newDocForAsset,
  splitClip,
  toDoc,
  toModel,
  validateTimeline,
  type EditorModel,
  type TimelineDoc,
} from "@/lib/editor";
import {
  GRADE_FILTER_ID,
  GRADE_RANGES,
  NEUTRAL_GRADE,
  gradeMatrix,
  gradeMatrixValues,
  gradeOf,
  isNeutralGrade,
  previewGradeStyle,
  resetClipGrade,
  setClipGrade,
} from "@/lib/editorGrade";

const A = "11111111-1111-4111-8111-111111111111";
const fixture = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "samples", "clip_grade_preview.json"),
    "utf8",
  ),
);
const model = (): EditorModel =>
  toModel(newDocForAsset({ id: A, durationS: 10, width: 1920, height: 1080 })!);
const id = (m: EditorModel) => m.clips[0].id;
const GRADE = { brightness: 0.15, contrast: 1.2, saturation: 0.8 };

describe("the preview matrix", () => {
  it("is the fixture the Python parity test measures ffmpeg against", () => {
    expect(fixture.luma_601).toEqual([0.299, 0.587, 0.114]);
    expect(fixture.luma_709).toEqual([0.2126, 0.7152, 0.0722]);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
    for (const c of fixture.cases) {
      const got = gradeMatrix(c.grade, c.still);
      expect(got).toHaveLength(20);
      got.forEach((v, i) => expect(v).toBeCloseTo(c.matrix[i], 5));
    }
  });

  it("the neutral grade is the identity", () => {
    for (const still of [true, false])
      expect(gradeMatrix(NEUTRAL_GRADE, still)).toEqual([
        1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0,
      ]);
  });

  it("leaves alpha alone and prints plain numbers for the attribute", () => {
    const m = gradeMatrix(GRADE, false);
    expect(m.slice(15)).toEqual([0, 0, 0, 1, 0]);
    const v = gradeMatrixValues(GRADE, false);
    expect(v.split(" ")).toHaveLength(20);
    expect(v).not.toMatch(/[a-df-z]|NaN|Infinity/i);
  });

  it("brightness adds, saturation 0 makes grey, contrast 0 flattens the luma", () => {
    const apply = (m: number[], rgb: number[]) =>
      [0, 1, 2].map(
        (r) =>
          m[r * 5] * rgb[0] + m[r * 5 + 1] * rgb[1] + m[r * 5 + 2] * rgb[2] + m[r * 5 + 4],
      );
    const up = apply(gradeMatrix({ ...NEUTRAL_GRADE, brightness: 0.2 }, false), [0.5, 0.5, 0.5]);
    expect(up[0]).toBeCloseTo(0.5 + 0.2 * (255 / 219), 6);
    const grey = apply(gradeMatrix({ ...NEUTRAL_GRADE, saturation: 0 }, false), [0.8, 0.2, 0.2]);
    expect(grey[0]).toBeCloseTo(grey[1], 9);
    expect(grey[1]).toBeCloseTo(grey[2], 9);
    const a = apply(gradeMatrix({ ...NEUTRAL_GRADE, contrast: 0 }, false), [0.9, 0.9, 0.9]);
    const b = apply(gradeMatrix({ ...NEUTRAL_GRADE, contrast: 0 }, false), [0.1, 0.1, 0.1]);
    expect(a[0]).toBeCloseTo(b[0], 9);
  });
});

describe("editing a clip's colour", () => {
  it("a project that never used it keeps exactly its document", () => {
    const m = model();
    expect(gradeOf(m.clips[0])).toEqual(NEUTRAL_GRADE);
    expect("grade" in toDoc(m).tracks[0].clips[0]).toBe(false);
    expect(previewGradeStyle(m.clips[0])).toEqual({});
  });

  it("sets one number at a time, clamped to its range and to 3 decimals", () => {
    let m = model();
    m = setClipGrade(m, id(m), { brightness: 0.12345 });
    expect(m.clips[0].grade).toEqual({ brightness: 0.123, contrast: 1, saturation: 1 });
    m = setClipGrade(m, id(m), { contrast: 9, saturation: -4 });
    expect(m.clips[0].grade).toEqual({ brightness: 0.123, contrast: 2, saturation: 0 });
    m = setClipGrade(m, id(m), { brightness: -5 });
    expect(m.clips[0].grade!.brightness).toBe(-1);
    m = setClipGrade(m, id(m), { brightness: Number.NaN });
    expect(m.clips[0].grade!.brightness).toBe(0);
  });

  it("returning to no change removes the field; reset is byte for byte the old document", () => {
    const m0 = model();
    const before = JSON.stringify(toDoc(m0));
    const m1 = setClipGrade(m0, id(m0), GRADE);
    expect(JSON.stringify(toDoc(m1))).not.toBe(before);
    expect(JSON.stringify(toDoc(resetClipGrade(m1, id(m1))))).toBe(before);
    const m2 = setClipGrade(m1, id(m1), NEUTRAL_GRADE);
    expect("grade" in m2.clips[0]).toBe(false);
  });

  it("the same model back when nothing changes (not an undo step)", () => {
    const m = model();
    expect(setClipGrade(m, id(m), {})).toBe(m);
    expect(setClipGrade(m, id(m), { brightness: 0 })).toBe(m);
    expect(resetClipGrade(m, id(m))).toBe(m);
    expect(setClipGrade(m, "nope", GRADE)).toBe(m);
    const g = setClipGrade(m, id(m), GRADE);
    expect(setClipGrade(g, id(g), GRADE)).toBe(g);
  });

  it("the preview style points the picture at the SVG filter only while graded", () => {
    const m = setClipGrade(model(), id(model()), GRADE);
    expect(previewGradeStyle(m.clips[0])).toEqual({
      filter: `url(#${GRADE_FILTER_ID})`,
    });
    expect(previewGradeStyle(undefined)).toEqual({});
    expect(isNeutralGrade(NEUTRAL_GRADE)).toBe(true);
    expect(isNeutralGrade(GRADE)).toBe(false);
  });

  it("a split keeps it on both halves", () => {
    const m = setClipGrade(model(), id(model()), GRADE);
    const out = splitClip(m, id(m), 4)!;
    expect(out.model.clips.map((c) => c.grade)).toEqual([GRADE, GRADE]);
  });

  it("survives toDoc / toModel, and an unusable or neutral document value is dropped", () => {
    const m = setClipGrade(model(), id(model()), GRADE);
    expect(toModel(toDoc(m)).clips[0].grade).toEqual(GRADE);
    const doc = toDoc(m);
    doc.tracks[0].clips[0].grade = { brightness: 0, contrast: 1, saturation: 1 };
    expect("grade" in toModel(doc).clips[0]).toBe(false);
    doc.tracks[0].clips[0].grade = { brightness: "x" };
    expect("grade" in toModel(doc).clips[0]).toBe(false);
  });
});

describe("validateTimeline on grade (the twin of modules/timeline.py)", () => {
  const docWith = (grade: unknown): TimelineDoc => {
    const d = toDoc(model());
    d.tracks[0].clips[0].grade = grade;
    return d;
  };

  it("accepts a grade inside every range, the ends included", () => {
    for (const c of [
      GRADE,
      { brightness: -1, contrast: 0, saturation: 0 },
      { brightness: 1, contrast: 2, saturation: 3 },
      NEUTRAL_GRADE,
    ])
      expect(validateTimeline(docWith(c))).toEqual([]);
  });

  it("refuses a number outside its range, naming the field", () => {
    for (const [k, r] of Object.entries(GRADE_RANGES))
      for (const bad of [r.min - 0.001, r.max + 0.001]) {
        const p = validateTimeline(docWith({ ...NEUTRAL_GRADE, [k]: bad }));
        expect(p.some((x) => x.includes(`grade: ${k} must be a number`))).toBe(true);
      }
  });

  it("is strict: all three numbers, nothing else, an object", () => {
    expect(validateTimeline(docWith({ brightness: 0, contrast: 1 })).join()).toMatch(
      /saturation is missing/,
    );
    expect(validateTimeline(docWith({ ...NEUTRAL_GRADE, hue: 3 })).join()).toMatch(
      /hue is not a known field/,
    );
    for (const bad of [null, [0, 1, 1], "x", 5])
      expect(validateTimeline(docWith(bad)).join()).toMatch(/must be an object/);
    expect(
      validateTimeline(docWith({ ...NEUTRAL_GRADE, contrast: "1" })).length,
    ).toBeGreaterThan(0);
  });
});
