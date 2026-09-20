import { describe, expect, it } from "vitest";
import { parseStoryboard, scenesToStoryboard, buildStoryboard, formatClock } from "@/lib/storyboard";

/**
 * The storyboard is parsed from a video's stored narration, whose scene breaks
 * are blank lines (main.py stores `Script.full_narration()`, which joins each
 * section's clean narration with a blank line). These pin the parsing so a
 * stray break or trailing whitespace never invents a phantom scene, and so the
 * timeline adds up.
 */
describe("parseStoryboard", () => {
  it("returns an empty storyboard for null/blank input", () => {
    for (const v of [null, undefined, "", "   \n  \n"]) {
      const sb = parseStoryboard(v);
      expect(sb.scenes).toEqual([]);
      expect(sb.totalSeconds).toBe(0);
      expect(sb.totalWords).toBe(0);
    }
  });

  it("splits on blank lines, numbers scenes in order, and drops empty fragments", () => {
    const script = "Scene one narration here.\n\nScene two is next.\n\n\n\nScene three ends it.";
    const sb = parseStoryboard(script);
    expect(sb.scenes.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(sb.scenes[1].text).toBe("Scene two is next.");
    // Doubled blank lines between 2 and 3 must NOT create an empty scene.
    expect(sb.scenes).toHaveLength(3);
  });

  it("does not split on single newlines within a scene", () => {
    const script = "Line one\nstill scene one.\n\nSecond scene.";
    const sb = parseStoryboard(script);
    expect(sb.scenes).toHaveLength(2);
    expect(sb.scenes[0].text).toBe("Line one\nstill scene one.");
  });

  it("counts words and makes the timeline cumulative and consistent", () => {
    const script = "one two three four five.\n\nsix seven eight.";
    const sb = parseStoryboard(script);
    expect(sb.scenes[0].words).toBe(5);
    expect(sb.scenes[1].words).toBe(3);
    expect(sb.totalWords).toBe(8);
    // Each scene is at least 1s; the last cumulative equals the total.
    expect(sb.scenes[0].estSeconds).toBeGreaterThanOrEqual(1);
    expect(sb.scenes[sb.scenes.length - 1].cumulativeSeconds).toBe(sb.totalSeconds);
    expect(sb.totalSeconds).toBe(sb.scenes[0].estSeconds + sb.scenes[1].estSeconds);
  });

  it("derives a first-sentence beat and caps a long one", () => {
    const sb = parseStoryboard("The hook lands first. Then the rest follows on.");
    expect(sb.scenes[0].beat).toBe("The hook lands first.");
    const long = "x".repeat(200);
    const sb2 = parseStoryboard(long);
    expect(sb2.scenes[0].beat.length).toBeLessThanOrEqual(90);
    expect(sb2.scenes[0].beat.endsWith("…")).toBe(true);
  });
});

describe("scenesToStoryboard", () => {
  it("returns an empty structured storyboard for null/empty/non-array input", () => {
    for (const v of [null, undefined, [] as never[]]) {
      const sb = scenesToStoryboard(v);
      expect(sb.scenes).toEqual([]);
      expect(sb.source).toBe("structured");
    }
  });

  it("uses the pipeline's duration_hint as the exact length, not a word estimate", () => {
    const sb = scenesToStoryboard([
      { name: "Hook", type: "hook", narration: "one two three", duration_hint: 15, keywords: ["storm"] },
    ]);
    expect(sb.scenes).toHaveLength(1);
    const s = sb.scenes[0];
    expect(s.estSeconds).toBe(15);
    expect(s.durationExact).toBe(true);
    expect(s.name).toBe("Hook");
    expect(s.sceneType).toBe("hook");
    expect(s.keywords).toEqual(["storm"]);
    expect(sb.totalSeconds).toBe(15);
  });

  it("estimates length from words when a scene has no usable duration_hint", () => {
    const sb = scenesToStoryboard([{ narration: "one two three four five", duration_hint: 0 }]);
    expect(sb.scenes[0].durationExact).toBe(false);
    expect(sb.scenes[0].estSeconds).toBeGreaterThanOrEqual(1);
  });

  it("keeps a scene with a name but no narration, and drops fully empty ones", () => {
    const sb = scenesToStoryboard([
      { name: "Cold open", narration: "" },
      { narration: "   " },
      { name: "", narration: "" },
    ]);
    expect(sb.scenes).toHaveLength(1);
    expect(sb.scenes[0].beat).toBe("Cold open");
  });

  it("renumbers scenes and keeps the timeline cumulative", () => {
    const sb = scenesToStoryboard([
      { narration: "a", duration_hint: 10 },
      { narration: "b", duration_hint: 20 },
    ]);
    expect(sb.scenes.map((s) => s.index)).toEqual([1, 2]);
    expect(sb.scenes[1].cumulativeSeconds).toBe(30);
    expect(sb.totalSeconds).toBe(30);
  });
});

describe("buildStoryboard", () => {
  it("prefers the structured scene plan when present", () => {
    const sb = buildStoryboard(
      [{ name: "Hook", narration: "structured text", duration_hint: 12 }],
      "narration paragraph one\n\nparagraph two",
    );
    expect(sb.source).toBe("structured");
    expect(sb.scenes[0].text).toBe("structured text");
  });

  it("falls back to the narration split when there are no structured scenes", () => {
    const sb = buildStoryboard(null, "para one\n\npara two");
    expect(sb.source).toBe("narration");
    expect(sb.scenes).toHaveLength(2);
  });

  it("falls back when the structured list is present but yields no usable scene", () => {
    const sb = buildStoryboard([{ narration: "" }], "para one\n\npara two");
    expect(sb.source).toBe("narration");
    expect(sb.scenes).toHaveLength(2);
  });
});

describe("formatClock", () => {
  it("formats seconds as m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(9)).toBe("0:09");
    expect(formatClock(95)).toBe("1:35");
    expect(formatClock(600)).toBe("10:00");
  });
});
