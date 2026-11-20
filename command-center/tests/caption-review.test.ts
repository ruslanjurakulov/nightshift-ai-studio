import { describe, expect, it } from "vitest";
import { MIN_CUE_S, type Cue } from "@/lib/captions";
import { reviewCaptions } from "@/lib/captionReview";

const cue = (id: string, start_s: number, end_s: number, text = "Synthetic caption."): Cue => ({ id, start_s, end_s, text });

describe("local caption review flags", () => {
  it("preserves valid Unicode cues, touching edges and the exact picture end", () => {
    const cues = Object.freeze([
      Object.freeze(cue("uz", 0, MIN_CUE_S, "Oʻgʻil, gʻoya!\nIkkinchi satr.")),
      Object.freeze(cue("ru", MIN_CUE_S, 2, "Привет!\nВторая строка.")),
    ]);
    expect(reviewCaptions(cues, 2)).toEqual([]);
    expect(cues[0].text).toBe("Oʻgʻil, gʻoya!\nIkkinchi satr.");
    expect(cues[1].end_s).toBe(2);
  });

  it("collects multiple review reasons without changing the original cue list", () => {
    const cues = [cue("first", 0, 2), cue("review", 1, 4, " \n\t ")];
    const before = JSON.stringify(cues);
    cues.forEach(Object.freeze);
    Object.freeze(cues);
    expect(reviewCaptions(cues, 3)).toEqual([
      { cueId: "review", index: 1, reasons: ["empty", "out_of_order", "past_end"] },
    ]);
    expect(JSON.stringify(cues)).toBe(before);
  });

  it("checks earlier spans even when the intervening cue ends sooner", () => {
    expect(reviewCaptions([cue("a", 0, 5), cue("b", 1, 2), cue("c", 3, 4)], 5)).toEqual([
      { cueId: "b", index: 1, reasons: ["out_of_order"] },
      { cueId: "c", index: 2, reasons: ["out_of_order"] },
    ]);
  });

  it.each([[2, 1], [1, 1], [-1, 1]])("flags a non-forward or negative cue (%s, %s)", (start, end) => {
    expect(reviewCaptions([cue("a", start, end)], 5)).toEqual([
      { cueId: "a", index: 0, reasons: ["out_of_order"] },
    ]);
  });

  it.each([[1, 4], [3, 4], [4, 5]])("flags a cue crossing or outside the picture (%s, %s)", (start, end) => {
    expect(reviewCaptions([cue("a", start, end)], 3)).toEqual([
      { cueId: "a", index: 0, reasons: ["past_end"] },
    ]);
  });

  it("uses existing millisecond precision without inventing a minimum-duration rule", () => {
    expect(reviewCaptions([cue("a", 1, 1 + MIN_CUE_S / 2)], 1.2001)).toEqual([]);
    expect(reviewCaptions([], 0)).toEqual([]);
  });
});
