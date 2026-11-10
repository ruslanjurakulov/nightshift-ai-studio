/**
 * One edit, several frame sizes (migration 0129, NIGHTSHIFT_MULTI_RATIO_EXPORT): the pure half.
 *
 * What would break without these: a size reaching the server as anything but the id of a format on the closed list
 * (a width, a ratio, an object, a padded id); a request naming more sizes than the organization can have in flight;
 * the switch read as on by accident; an export row that carries half a frame shown as a real one, or a plain export
 * row changing shape; a finished file in the WRONG size shown as if it were what was asked for; a frame failure
 * offered as "Try again"; and a sentence missing or with different fillers in Russian or Uzbek.
 */
import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import {
  EXPORT_REASONS,
  coerceExports,
  newDocForAsset,
  toDoc,
  toModel,
  validateTimeline,
  type EditorExport,
} from "@/lib/editor";
import { EXPORT_PRESETS } from "@/lib/editorExportPresets";
import { canRetry, exportSignature, retryPlan } from "@/lib/editorExportStatus";
import { reverseMaxSeconds } from "@/lib/editor";
import { MULTI_RATIO_EXPORT_FLAG, multiRatioExportEnabled } from "@/lib/multiRatioExport/flag";
import {
  MAX_EXPORT_FRAMES,
  PROJECT_FRAME,
  exportFrameChoice,
  frameMismatch,
  frameProblems,
  isExportFrameChoice,
  latestPerFrame,
  otherFrames,
  parseExportFrames,
} from "@/lib/multiRatioExport/frames";

const A = "11111111-1111-4111-8111-111111111111";
const row = (over: Partial<EditorExport> = {}): EditorExport => ({
  id: "e1", rev: 1, status: "done", reason: null, durationS: 10, assetId: "a1", createdAt: "2026-01-01T10:00:00Z", finishedAt: null, ...over,
});
const frame = (preset: string, width: number, height: number) => ({ frame: { preset, width, height } });

describe("the switch", () => {
  it("is named NIGHTSHIFT_MULTI_RATIO_EXPORT and is off unless explicitly on", () => {
    expect(MULTI_RATIO_EXPORT_FLAG).toBe("NIGHTSHIFT_MULTI_RATIO_EXPORT");
    for (const on of ["on", "1", "true", "yes", " ON ", "True"]) expect(multiRatioExportEnabled(on)).toBe(true);
    for (const off of [undefined, "", " ", "0", "off", "false", "no", "enabled", "onn", "2"]) expect(multiRatioExportEnabled(off)).toBe(false);
  });

  it("reads the server's environment at call time, not a build-time value", () => {
    const before = process.env.NIGHTSHIFT_MULTI_RATIO_EXPORT;
    try {
      delete process.env.NIGHTSHIFT_MULTI_RATIO_EXPORT;
      expect(multiRatioExportEnabled()).toBe(false);
      process.env.NIGHTSHIFT_MULTI_RATIO_EXPORT = "on";
      expect(multiRatioExportEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.NIGHTSHIFT_MULTI_RATIO_EXPORT;
      else process.env.NIGHTSHIFT_MULTI_RATIO_EXPORT = before;
    }
  });
});

describe("the frames of a request", () => {
  it("is a list of ids from the closed list, the project's own frame first", () => {
    expect(parseExportFrames(["project"])).toEqual(["project"]);
    expect(parseExportFrames(["vertical_1080p"])).toEqual(["vertical_1080p"]);
    expect(parseExportFrames(["square_1080", "project", "vertical_1080p"])).toEqual(["project", "vertical_1080p", "square_1080"]);
    for (const p of EXPORT_PRESETS) expect(parseExportFrames([p.id])).toEqual([p.id]);
    expect(PROJECT_FRAME).toBe("project");
    expect(EXPORT_PRESETS.some((p) => (p.id as string) === PROJECT_FRAME)).toBe(false);
  });

  it("refuses the whole request for anything else", () => {
    const bad: unknown[] = [
      undefined, null, "vertical_1080p", 5, true, {}, { 0: "project", length: 1 }, [],
      [null], [""], ["Project"], ["PROJECT"], [" project"], ["vertical_1080p "], ["VERTICAL_1080P"], ["vertical_4k"], ["9:16"], ["1080x1920"],
      [1080], [[1080, 1920]], [{ width: 1080, height: 1920 }], [{ id: "vertical_1080p" }], [{ preset: "vertical_1080p", width: 8192, height: 8192 }],
      [["vertical_1080p"]], [true], [0],
      ["project", "project"], ["vertical_1080p", "vertical_1080p"],
      ["project", "nonsense"], ["vertical_1080p", 7],
      ["project", "vertical_1080p", "square_1080", "feed_4x5_1080"],
      ["youtube_1080p", "youtube_720p", "vertical_1080p", "square_1080", "feed_4x5_1080"],
    ];
    for (const b of bad) expect(parseExportFrames(b), JSON.stringify(b)).toBeNull();
  });

  it("names at most as many as the organization may have in flight", () => {
    expect(MAX_EXPORT_FRAMES).toBe(3);
    expect(parseExportFrames(["project", "vertical_1080p", "square_1080"])).toHaveLength(3);
  });

  it("knows a choice from anything else", () => {
    for (const ok of ["project", ...EXPORT_PRESETS.map((p) => p.id)]) expect(isExportFrameChoice(ok)).toBe(true);
    for (const no of [null, undefined, "", "Project", 1080, {}, [], "1080x1920"]) expect(isExportFrameChoice(no)).toBe(false);
  });
});

describe("the sizes the picker offers", () => {
  it("is every format whose size is not the project's own", () => {
    expect(otherFrames({ width: 1920, height: 1080 })).toEqual(["youtube_720p", "vertical_1080p", "square_1080", "feed_4x5_1080"]);
    expect(otherFrames({ width: 1080, height: 1920 })).toEqual(["youtube_1080p", "youtube_720p", "square_1080", "feed_4x5_1080"]);
    // A custom size: all five are other sizes.
    expect(otherFrames({ width: 1280, height: 1000 })).toHaveLength(EXPORT_PRESETS.length);
  });

  it("judges the edit against the OTHER frame, with the validator's own rules", () => {
    // A 720p project (the first document of a video takes a 1080-based frame; this one was set to 720p in "Export format").
    const model = { ...toModel(newDocForAsset({ id: A, durationS: 600, width: 1280, height: 720 })!), width: 1280, height: 720 };
    for (const p of EXPORT_PRESETS) expect(frameProblems(model, p.id)).toEqual([]);
    // Backwards play holds every frame in memory: the longest range depends on the frame's size.
    const max720 = reverseMaxSeconds(1280, 720, model.fps);
    expect(reverseMaxSeconds(1080, 1920, model.fps)).toBeLessThan(max720);
    const reversed = { ...model, clips: model.clips.map((c) => ({ ...c, out_s: max720, reverse: true, audio: false })) };
    expect(validateTimeline(toDoc(reversed))).toEqual([]);
    expect(frameProblems(reversed, "youtube_720p")).toEqual([]);
    for (const bigger of ["youtube_1080p", "vertical_1080p", "square_1080", "feed_4x5_1080"] as const)
      expect(frameProblems(reversed, bigger).join(" ")).toMatch(/reverse holds every frame/);
    // Only width and height were changed for the question: the model is untouched.
    expect([reversed.width, reversed.height]).toEqual([1280, 720]);
  });
});

describe("export rows that carry a frame", () => {
  it("reads the three columns, and the object the route sends on", () => {
    const snake = { id: "e1", rev: 3, status: "queued", reason: null, duration_s: "12.5", asset_id: null, created_at: "t", finished_at: null,
      frame_preset: "vertical_1080p", frame_width: 1080, frame_height: 1920 };
    const [a] = coerceExports([snake]);
    expect(a.frame).toEqual({ preset: "vertical_1080p", width: 1080, height: 1920 });
    // What GET /api/editor/projects/<id> answers is this object as JSON: the poll must read the same frame back.
    expect(coerceExports(JSON.parse(JSON.stringify([a])))).toEqual([a]);
  });

  it("a row without a frame is the object it always was: no `frame` key at all", () => {
    const plain = { id: "e1", rev: 3, status: "done", reason: null, duration_s: "12.5", asset_id: "a", created_at: "t", finished_at: "u" };
    for (const r of [plain, { ...plain, frame_preset: null, frame_width: null, frame_height: null }, { ...plain, frame: null }]) {
      const [x] = coerceExports([r]);
      expect(Object.keys(x).sort()).toEqual(["assetId", "createdAt", "durationS", "finishedAt", "id", "reason", "rev", "status"]);
    }
  });

  it("half a frame, or one that is not id and whole numbers, is no frame, never a guessed one", () => {
    const base = { id: "e1", rev: 1, status: "done" };
    for (const half of [
      { frame_preset: "vertical_1080p" }, { frame_width: 1080, frame_height: 1920 }, { frame_preset: "vertical_1080p", frame_width: 1080 },
      { frame_preset: "Vertical 1080p", frame_width: 1080, frame_height: 1920 }, { frame_preset: "vertical_1080p", frame_width: "1080", frame_height: "1920" },
      { frame_preset: "vertical_1080p", frame_width: 1080.5, frame_height: 1920 }, { frame_preset: "vertical_1080p", frame_width: 0, frame_height: 1920 },
      { frame_preset: "vertical_1080p", frame_width: -1080, frame_height: 1920 }, { frame_preset: 5, frame_width: 1080, frame_height: 1920 },
      { frame: { preset: "vertical_1080p" } }, { frame: "vertical_1080p" }, { frame: { preset: "vertical_1080p", width: 1080, height: null } },
    ])
      expect("frame" in coerceExports([{ ...base, ...half }])[0], JSON.stringify(half)).toBe(false);
  });

  it("names the choice an export was asked in", () => {
    expect(exportFrameChoice(row())).toBe("project");
    expect(exportFrameChoice(row(frame("square_1080", 1080, 1080)))).toBe("square_1080");
  });

  it("shows the newest export of each size of the newest exported version, and anything still running", () => {
    const list = [
      row({ id: "e6", rev: 4, status: "queued", ...frame("square_1080", 1080, 1080) }),
      row({ id: "e5", rev: 4, status: "rendering", ...frame("vertical_1080p", 1080, 1920) }),
      row({ id: "e4", rev: 4, status: "done" }),
      row({ id: "e3", rev: 4, status: "failed", ...frame("vertical_1080p", 1080, 1920) }),
      row({ id: "e2", rev: 3, status: "done", ...frame("feed_4x5_1080", 1080, 1350) }),
      row({ id: "e1", rev: 3, status: "rendering", ...frame("youtube_720p", 1280, 720) }),
    ];
    // e3 is an older try of the same size as e5; e2 is last version's size and finished; e1 is old but still running.
    expect(latestPerFrame(list).map((e) => e.id)).toEqual(["e6", "e5", "e4", "e1"]);
    expect(latestPerFrame([])).toEqual([]);
    expect(latestPerFrame([row({ id: "only" })]).map((e) => e.id)).toEqual(["only"]);
  });

  it("says when a finished file is not the size that was asked for, and never guesses", () => {
    const asked = row(frame("vertical_1080p", 1080, 1920));
    expect(frameMismatch(asked, { width: 1080, height: 1920 })).toBeNull();
    // A worker that does not know frames renders the project's own size.
    expect(frameMismatch(asked, { width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
    expect(frameMismatch(asked, { width: 1080, height: 1918 })).toEqual({ width: 1080, height: 1918 });
    // Unknown is not a mismatch: no file yet, no size on the file, not finished, or no frame asked.
    expect(frameMismatch(asked, undefined)).toBeNull();
    expect(frameMismatch(asked, { width: null, height: null })).toBeNull();
    expect(frameMismatch(asked, { width: 1920, height: null })).toBeNull();
    expect(frameMismatch({ ...asked, status: "rendering" }, { width: 1920, height: 1080 })).toBeNull();
    expect(frameMismatch(row(), { width: 640, height: 360 })).toBeNull();
  });

  it("a frame failure is a reason with a sentence, and is not offered as try again", () => {
    for (const reason of ["invalid_frame", "frame_off"] as const) {
      expect(EXPORT_REASONS).toContain(reason);
      expect(coerceExports([{ id: "e", rev: 1, status: "failed", reason }])[0].reason).toBe(reason);
      expect(canRetry(reason)).toBe(false);
      expect(retryPlan({ reason, rev: 2 }, 2)).toBe("fix");
    }
    // The poll's signature does not depend on the frame: a frame never changes after the row is written.
    expect(exportSignature([row(frame("square_1080", 1080, 1080))])).toBe(exportSignature([row()]));
  });
});

describe("the words, in three languages", () => {
  const fillers = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort().join(",");
  it("Russian and Uzbek carry exactly the English keys and fillers", () => {
    const src = en.editor.exportRatios;
    for (const d of [ru, uz]) {
      const other = d.editor.exportRatios;
      expect(Object.keys(other).sort()).toEqual(Object.keys(src).sort());
      for (const k of Object.keys(src) as (keyof typeof src)[]) {
        expect(fillers(other[k]), k).toBe(fillers(src[k]));
        expect(other[k].trim().length, k).toBeGreaterThan(0);
      }
    }
  });

  it("every sentence is translated, not copied", () => {
    const src = en.editor.exportRatios;
    for (const d of [ru, uz])
      for (const k of Object.keys(src) as (keyof typeof src)[])
        if (k !== "size") expect(d.editor.exportRatios[k], k).not.toBe(src[k]);
  });

  it("the two failure sentences exist in all three and say nothing was rendered", () => {
    for (const d of [en, ru, uz])
      for (const reason of ["invalid_frame", "frame_off"] as const) {
        expect(d.editor.exportReasons[reason].length).toBeGreaterThan(20);
        expect(d.editor.exportReasons[reason]).not.toBe(d.editor.exportReasons.other);
      }
    expect(ru.editor.exportReasons.frame_off).not.toBe(en.editor.exportReasons.frame_off);
    expect(uz.editor.exportReasons.invalid_frame).not.toBe(en.editor.exportReasons.invalid_frame);
  });

  it("no sentence uses a dash as punctuation", () => {
    for (const d of [en, ru, uz])
      for (const v of Object.values(d.editor.exportRatios)) expect(v).not.toMatch(/ — | – |--/);
  });
});
