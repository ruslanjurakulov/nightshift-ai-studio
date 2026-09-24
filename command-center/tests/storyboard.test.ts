import { describe, expect, it } from "vitest";
import {
  parseStoryboard,
  scenesToStoryboard,
  buildStoryboard,
  formatClock,
  claimCounts,
  normalizeClaim,
} from "@/lib/storyboard";

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

/**
 * Claim <-> scene linkage (modules/claim_scenes.py). The statuses are advisory,
 * so the one property that matters most is that nothing malformed can read as
 * "accurate" — a missing status is "not_checked", an unknown one is clamped.
 */
describe("scene claims", () => {
  it("carries each scene's id and normalized claims", () => {
    const sb = scenesToStoryboard([
      {
        id: "s000",
        name: "Hook",
        narration: "The ship sank in 1912.",
        claims: [
          { id: "c000-1", text: "The ship sank in 1912.", status: "likely_accurate", requires_human_review: false },
        ],
      },
      {
        name: "Story",
        narration: "Over 1500 died. It had 20 lifeboats.",
        claims: [
          { id: "c001-1", text: "Over 1500 died.", status: "likely_inaccurate", requires_human_review: true, reasoning: "Closer to 1,500." },
          { id: "c001-2u", text: "It had 20 lifeboats.", status: "not_checked", requires_human_review: true },
        ],
      },
    ]);
    expect(sb.scenes.map((s) => s.sceneId)).toEqual(["s000", "s001"]);
    expect(sb.scenes[0].claims?.[0]).toMatchObject({ id: "c000-1", status: "likely_accurate", needsReview: false });
    expect(sb.scenes[1].claims?.map((c) => c.status)).toEqual(["likely_inaccurate", "not_checked"]);
    expect(sb.scenes[1].claims?.[0].reasoning).toBe("Closer to 1,500.");
    expect(claimCounts(sb.scenes)).toEqual({ total: 3, needsReview: 2 });
  });

  it("derives the scene id from the stored position, not the display number", () => {
    const sb = scenesToStoryboard([{ narration: "" }, { narration: "Second scene text here." }]);
    expect(sb.scenes).toHaveLength(1);
    expect(sb.scenes[0].index).toBe(1);
    expect(sb.scenes[0].sceneId).toBe("s001");
  });

  it("never reads a malformed claim as accurate", () => {
    expect(normalizeClaim({ text: "A claim here.", status: null })).toMatchObject({
      status: "not_checked",
      needsReview: true,
    });
    expect(normalizeClaim({ text: "A claim here.", status: "totally_true" })).toMatchObject({
      status: "unverifiable",
      needsReview: true,
    });
    // Accurate but the row itself asked for review — review wins.
    expect(normalizeClaim({ text: "A claim.", status: "likely_accurate", requires_human_review: true })?.needsReview).toBe(true);
    expect(normalizeClaim({ text: "   " })).toBeNull();
    expect(normalizeClaim(null)).toBeNull();
  });

  it("leaves claims undefined for rows written before linkage existed", () => {
    const sb = scenesToStoryboard([{ name: "Hook", narration: "Old row." }]);
    expect(sb.scenes[0].claims).toBeUndefined();
    expect(claimCounts(sb.scenes)).toEqual({ total: 0, needsReview: 0 });
  });
});
