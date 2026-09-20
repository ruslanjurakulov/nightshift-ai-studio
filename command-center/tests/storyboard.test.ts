import { describe, expect, it } from "vitest";
import { parseStoryboard, formatClock } from "@/lib/storyboard";

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

describe("formatClock", () => {
  it("formats seconds as m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(9)).toBe("0:09");
    expect(formatClock(95)).toBe("1:35");
    expect(formatClock(600)).toBe("10:00");
  });
});
