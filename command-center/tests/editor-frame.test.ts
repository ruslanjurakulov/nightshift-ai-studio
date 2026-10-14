/**
 * The frame (aspect) and per-clip fit: pure model edits, and the preview style
 * derived from the SAME two document fields the export reads
 * (lib/editorFrame.ts; the pixel side is tests/test_editor_frame_parity.py).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  newDocForAsset,
  toDoc,
  toModel,
  validateTimeline,
  type EditorModel,
} from "@/lib/editor";
import {
  FRAME_PRESETS,
  fitOf,
  framePresetOf,
  PREVIEW_CAP_DESKTOP,
  PREVIEW_CAP_PHONE,
  PREVIEW_CAP_VAR,
  previewFrameStyle,
  previewObjectFit,
  setClipFit,
  setFrame,
} from "@/lib/editorFrame";

const A = "11111111-1111-4111-8111-111111111111";
const model = (w = 1920, h = 1080): EditorModel =>
  toModel(
    newDocForAsset({ id: A, durationS: 10, width: w, height: h })!,
  );

describe("frame presets", () => {
  it("are exactly the document presets (9:16, 16:9, 1:1) and all valid", () => {
    expect(FRAME_PRESETS.map((p) => [p.id, p.width, p.height])).toEqual([
      ["9:16", 1080, 1920],
      ["16:9", 1920, 1080],
      ["1:1", 1080, 1080],
    ]);
    for (const p of FRAME_PRESETS) {
      const m = setFrame(model(), p.id);
      expect(validateTimeline(toDoc(m))).toEqual([]);
      expect(framePresetOf(m)).toBe(p.id);
    }
  });

  it("setFrame changes only the size; choosing the current one is not a change", () => {
    const m = model();
    expect(setFrame(m, "16:9")).toBe(m);
    const v = setFrame(m, "9:16");
    expect(v).not.toBe(m);
    expect([v.width, v.height, v.fps]).toEqual([1080, 1920, 30]);
    expect(v.clips).toBe(m.clips);
    expect(v.texts).toBe(m.texts);
    expect(v.sounds).toBe(m.sounds);
  });

  it("a size that is no preset selects none", () => {
    expect(framePresetOf({ width: 1280, height: 720 })).toBeNull();
  });

  it("the frame is saved in the document", () => {
    const doc = toDoc(setFrame(model(), "1:1"));
    expect([doc.width, doc.height]).toEqual([1080, 1080]);
  });
});

describe("clip fit", () => {
  const id = "c1";

  it("defaults to contain and leaves the document untouched", () => {
    const m = model();
    expect(fitOf(m.clips[0])).toBe("contain");
    expect(setClipFit(m, id, "contain")).toBe(m);
    expect("fit" in toDoc(m).tracks[0].clips[0]).toBe(false);
  });

  it("cover writes fit, and going back to contain removes it again", () => {
    const m = model();
    const cover = setClipFit(m, id, "cover");
    expect(toDoc(cover).tracks[0].clips[0]).toMatchObject({ fit: "cover" });
    expect(validateTimeline(toDoc(cover))).toEqual([]);
    const back = setClipFit(cover, id, "contain");
    expect(toDoc(back)).toEqual(toDoc(m));
    expect("fit" in toDoc(back).tracks[0].clips[0]).toBe(false);
  });

  it("changes only the clip asked for", () => {
    const m = model();
    expect(setClipFit(m, "nope", "cover")).toBe(m);
  });

  it("an explicit contain from another tool is read as contain and kept valid", () => {
    const doc = toDoc(model());
    doc.tracks[0].clips[0].fit = "contain";
    expect(validateTimeline(doc)).toEqual([]);
    expect(fitOf(toModel(doc).clips[0])).toBe("contain");
  });
});

describe("preview derives from the document fields", () => {
  it("the frame box has the document's aspect ratio", () => {
    for (const [w, h] of [
      [1080, 1920],
      [1920, 1080],
      [1080, 1080],
    ]) {
      const s = previewFrameStyle({ width: w, height: h });
      expect(s.aspectRatio).toBe(`${w} / ${h}`);
      // The cap defaults to the desktop 60vh when the editor sets no variable.
      expect(s.maxHeight).toBe("var(--ns-preview-cap, 60vh)");
      expect(s.maxWidth).toBe(`calc(var(--ns-preview-cap, 60vh) * ${w / h})`);
    }
  });

  it("the capped width keeps the ratio: width = min(100%, cap x ratio), height = width / ratio <= cap", () => {
    // Resolve the box the way CSS does, for a viewport and an available width.
    const box = (frame: { width: number; height: number }, capPx: number, avail: number) => {
      const ratio = frame.width / frame.height;
      const s = previewFrameStyle(frame);
      // the formula in the style is `calc(<cap> * <ratio>)`
      expect(String(s.maxWidth)).toContain(`* ${ratio}`);
      const width = Math.min(avail, capPx * ratio);
      return { width, height: width / ratio };
    };
    // 390x844 phone: 30dvh = 253.2 px, a 296-wide column
    const cap = 0.3 * 844;
    const wide = box({ width: 1920, height: 1080 }, cap, 366);
    expect(wide.width).toBeCloseTo(366, 5); // the column is the limit
    expect(wide.height).toBeCloseTo(366 / (16 / 9), 5);
    expect(wide.height).toBeLessThanOrEqual(cap);
    const tall = box({ width: 1080, height: 1920 }, cap, 366);
    expect(tall.height).toBeCloseTo(cap, 5); // the cap is the limit, the ratio is kept
    expect(tall.width / tall.height).toBeCloseTo(9 / 16, 5);
    const square = box({ width: 1080, height: 1080 }, cap, 700); // 768: the cap alone fixes the oversize
    expect(square.width).toBeCloseTo(cap, 5);
    expect(square.height).toBeCloseTo(cap, 5);
  });

  it("the editor's classes set the same cap per breakpoint, and the pin sits under the measured header", () => {
    const src = readFileSync(join(__dirname, "../components/editor/TimelineEditor.tsx"), "utf8");
    expect(src).toContain(` [${PREVIEW_CAP_VAR}:${PREVIEW_CAP_PHONE}] `);
    expect(src).toContain(`lg:[${PREVIEW_CAP_VAR}:${PREVIEW_CAP_DESKTOP}]`);
    expect(src).toContain("sticky top-[var(--ns-header-h,4rem)]");
    // the pin is released from lg, where the preview sits beside the inspector
    expect(src).toMatch(/sticky top-\[var\(--ns-header-h,4rem\)\][^"]*lg:static/);
  });

  it("the phone cap is 30dvh and the desktop cap stays 60vh", () => {
    expect(PREVIEW_CAP_PHONE).toBe("30dvh");
    expect(PREVIEW_CAP_DESKTOP).toBe("60vh");
    expect(PREVIEW_CAP_VAR).toBe("--ns-preview-cap");
  });

  it("object-fit follows the clip's fit: contain = bars, cover = crop", () => {
    expect(previewObjectFit({}, false)).toBe("contain");
    expect(previewObjectFit({ fit: "contain" }, false)).toBe("contain");
    expect(previewObjectFit({ fit: "cover" }, false)).toBe("cover");
    expect(previewObjectFit(null, false)).toBe("contain");
  });

  it("a still always fills, as the export's zoom does, whatever its fit", () => {
    expect(previewObjectFit({}, true)).toBe("cover");
    expect(previewObjectFit({ fit: "contain" }, true)).toBe("cover");
  });

  it("changing the model changes the preview style (same fields, no copy)", () => {
    const m = setClipFit(setFrame(model(), "9:16"), "c1", "cover");
    expect(previewFrameStyle(m).aspectRatio).toBe("1080 / 1920");
    expect(previewObjectFit(m.clips[0], false)).toBe("cover");
  });
});
