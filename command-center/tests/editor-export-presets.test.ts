/**
 * Export presets (lib/editorExportPresets.ts): the closed list, its twin in
 * schemas/export_presets.json (which modules/export_presets.py loads and checks), the
 * limits every entry must stay inside, and the en / ru / uz strings. Choosing a preset
 * is a plain document edit: the document it makes passes the ordinary validator.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPORT_MAX_S,
  FPS_VALUES,
  newDocForAsset,
  toDoc,
  toModel,
  validateTimeline,
  type EditorModel,
} from "@/lib/editor";
import { FRAME_PRESETS } from "@/lib/editorFrame";
import {
  EXPORT_PRESETS,
  applyExportPreset,
  exportPresetById,
  exportPresetOf,
  isExportPresetId,
  isLongForPreset,
  presetProblems,
} from "@/lib/editorExportPresets";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const A = "11111111-1111-4111-8111-111111111111";
const model = (w = 1920, h = 1080): EditorModel =>
  toModel(newDocForAsset({ id: A, durationS: 10, width: w, height: h })!);

const IDS = ["youtube_1080p", "youtube_720p", "vertical_1080p", "square_1080", "feed_4x5_1080"];

describe("the closed list", () => {
  it("is exactly these ids in this order (the picker order)", () => {
    expect(EXPORT_PRESETS.map((p) => p.id)).toEqual(IDS);
  });

  it("offers the three existing frame sizes at 30 fps and one new shape, 4:5", () => {
    for (const f of FRAME_PRESETS)
      expect(
        EXPORT_PRESETS.some(
          (p) => p.width === f.width && p.height === f.height && p.fps === 30,
        ),
      ).toBe(true);
    expect(
      EXPORT_PRESETS.some((p) => p.width === 1080 && p.height === 1350),
    ).toBe(true);
  });

  it("is the list in schemas/export_presets.json, value for value", () => {
    const file = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "schemas", "export_presets.json"), "utf8"),
    ) as { version: number; presets: Record<string, unknown>[] };
    expect(file.version).toBe(1);
    expect(
      file.presets.map((p) => ({
        id: p.id,
        width: p.width,
        height: p.height,
        fps: p.fps,
        maxDurationS: p.max_duration_s,
      })),
    ).toEqual(EXPORT_PRESETS.map((p) => ({ ...p })));
  });

  it("keeps every entry inside the limits it must never exceed", () => {
    for (const p of EXPORT_PRESETS) {
      expect(presetProblems(p), p.id).toEqual([]);
      expect(p.width * p.height, p.id).toBeLessThanOrEqual(2560 * 1440);
      expect(p.maxDurationS, p.id).toBeLessThanOrEqual(1800);
      expect(p.maxDurationS, p.id).toBeLessThanOrEqual(EXPORT_MAX_S);
      expect(FPS_VALUES as readonly number[], p.id).toContain(p.fps);
    }
    expect(new Set(EXPORT_PRESETS.map((p) => `${p.width}x${p.height}@${p.fps}`)).size).toBe(
      EXPORT_PRESETS.length,
    );
  });

  it("the check itself refuses what it exists to refuse", () => {
    const ok = { width: 1080, height: 1350, fps: 30, maxDurationS: 600 };
    expect(presetProblems(ok)).toEqual([]);
    expect(presetProblems({ ...ok, width: 1081 })).not.toEqual([]);
    expect(presetProblems({ ...ok, height: 8 })).not.toEqual([]);
    expect(presetProblems({ ...ok, width: 3840, height: 2160 })).not.toEqual([]);
    expect(presetProblems({ ...ok, width: 2560, height: 1442 })).not.toEqual([]);
    expect(presetProblems({ ...ok, width: 2560, height: 1440 })).toEqual([]);
    expect(presetProblems({ ...ok, fps: 45 })).not.toEqual([]);
    expect(presetProblems({ ...ok, maxDurationS: 1801 })).not.toEqual([]);
    expect(presetProblems({ ...ok, maxDurationS: 1800 })).toEqual([]);
    expect(presetProblems({ ...ok, maxDurationS: 0 })).not.toEqual([]);
    expect(presetProblems({ ...ok, maxDurationS: Number.NaN })).not.toEqual([]);
  });
});

describe("a closed set: anything else is refused", () => {
  it("accepts exactly the listed ids", () => {
    for (const id of IDS) expect(isExportPresetId(id)).toBe(true);
    for (const bad of [
      "", "unknown", "YOUTUBE_1080P", " youtube_1080p", "youtube_1080p ", "youtube_4k",
      "9:16", null, undefined, 5, true, [], ["square_1080"], {},
    ])
      expect(isExportPresetId(bad), String(bad)).toBe(false);
    expect(exportPresetById("nope")).toBeNull();
    expect(exportPresetById("square_1080")?.width).toBe(1080);
  });

  it("an id outside the list changes nothing", () => {
    const m = model();
    expect(applyExportPreset(m, "unknown")).toBe(m);
    expect(applyExportPreset(m, undefined)).toBe(m);
    expect(applyExportPreset(m, { id: "square_1080" })).toBe(m);
  });
});

describe("choosing a preset is a document edit", () => {
  it("writes the frame size and rate and touches nothing else", () => {
    const m = model();
    const v = applyExportPreset(m, "vertical_1080p");
    expect([v.width, v.height, v.fps]).toEqual([1080, 1920, 30]);
    expect(v.clips).toBe(m.clips);
    expect(v.texts).toBe(m.texts);
    expect(v.sounds).toBe(m.sounds);
    const f = applyExportPreset({ ...m, fps: 60 }, "youtube_1080p");
    expect(f.fps).toBe(30);
  });

  it("choosing the one already chosen is not a change (no undo step)", () => {
    const m = model();
    expect(applyExportPreset(m, "youtube_1080p")).toBe(m);
  });

  it("every preset makes a document the ordinary validator accepts", () => {
    for (const p of EXPORT_PRESETS) {
      const m = applyExportPreset(model(), p.id);
      expect(validateTimeline(toDoc(m)), p.id).toEqual([]);
      expect(exportPresetOf(m)).toBe(p.id);
    }
  });

  it("the preset of a model is the one its frame and rate are exactly", () => {
    expect(exportPresetOf({ width: 1280, height: 1000, fps: 30 })).toBeNull();
    expect(exportPresetOf({ width: 1080, height: 1080, fps: 60 })).toBeNull();
    expect(exportPresetOf({ width: 1080, height: 1350, fps: 30 })).toBe("feed_4x5_1080");
  });
});

describe("the recommended length is advice with a sharp edge", () => {
  it("is past the cap only above it", () => {
    expect(isLongForPreset("vertical_1080p", 180)).toBe(false);
    expect(isLongForPreset("vertical_1080p", 180.001)).toBe(true);
    expect(isLongForPreset("youtube_1080p", 1800)).toBe(false);
  });

  it("never blocks: the validator has no length rule of its own for it", () => {
    const m = applyExportPreset(model(), "vertical_1080p");
    expect(validateTimeline(toDoc(m))).toEqual([]);
  });
});

describe("strings in en, ru and uz", () => {
  const dicts = { en: en.editor.exportPreset, ru: ru.editor.exportPreset, uz: uz.editor.exportPreset };
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

  it("have the same keys, one name per preset, none empty", () => {
    const keys = (o: Record<string, unknown>) => Object.keys(o).sort();
    for (const l of ["ru", "uz"] as const) {
      expect(keys(dicts[l]), l).toEqual(keys(dicts.en));
      expect(keys(dicts[l].names), l).toEqual([...IDS].sort());
    }
    expect(keys(dicts.en.names)).toEqual([...IDS].sort());
    for (const [l, d] of Object.entries(dicts)) {
      for (const [k, v] of Object.entries(d)) {
        if (k === "names") for (const n of Object.values(v as Record<string, string>)) expect(n.trim(), l).not.toBe("");
        else expect((v as string).trim(), `${l}.${k}`).not.toBe("");
      }
    }
  });

  it("keep the same {placeholders} in every language", () => {
    for (const k of ["summary", "detail", "custom", "longForFormat"] as const)
      for (const l of ["ru", "uz"] as const)
        expect(holes(dicts[l][k]), `${l}.${k}`).toEqual(holes(dicts.en[k]));
  });

  it("are translated, not copies of the English", () => {
    for (const l of ["ru", "uz"] as const)
      for (const k of ["legend", "summary", "hint", "detail", "custom", "longForFormat"] as const)
        expect(dicts[l][k], `${l}.${k}`).not.toBe(dicts.en[k]);
  });

  it("name the shapes in words a person can tell apart", () => {
    for (const d of Object.values(dicts))
      expect(new Set(Object.values(d.names)).size).toBe(IDS.length);
  });
});
