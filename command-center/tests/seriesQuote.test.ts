import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateSeriesQuote,
  estimateRunCredits,
  parsePrices,
  quoteSeries,
  seriesCallBudget,
  type CreditEstimate,
  type EstimateGap,
} from "../lib/credits";

/**
 * The price preview of a series (slice S1, modules/series_planner.py is the Python twin). What must hold: an
 * unpriced episode is null with its named gap, the series total is null if ANY episode is null (never 0, never a
 * partial sum shown as the total), the partial sum lives under its own name, a price of zero is still a price,
 * and `estimateRunCredits` is reused as it is.
 */

const PER_MINUTE = parsePrices([{ unit: "video_minute", credits_per_unit: 20, margin: 0.25 }]); // 25 / minute

function estimate(credits: number | null, gap: EstimateGap | null): CreditEstimate {
  return { credits, basis: credits === null ? "unknown" : "per_minute", sample: 0, floorApplied: false, gap };
}

describe("quoteSeries", () => {
  it("prices every episode with estimateRunCredits and sums them", () => {
    const q = quoteSeries({ prices: PER_MINUTE, durationsS: [180, 300, 600], videos: [] });
    expect(q.episodes.map((e) => e.credits)).toEqual([75, 125, 250]);
    expect(q.totalCredits).toBe(450);
    expect(q.partialSumPricedOnly).toBe(450);
    expect(q.complete).toBe(true);
    expect(q.unknownEpisodes).toEqual([]);
    // the very same numbers estimateRunCredits gives for one run
    expect(q.episodes[0].credits).toBe(estimateRunCredits({ prices: PER_MINUTE, durationS: 180, videos: [] }).credits);
  });

  it("an episode with no length and no history is null with its gap, and the total is null, never 0", () => {
    const q = quoteSeries({ prices: PER_MINUTE, durationsS: [180, null, 300], videos: [] });
    expect(q.episodes[1]).toMatchObject({ credits: null, gap: "no_length" });
    expect(q.totalCredits).toBeNull();
    expect(q.complete).toBe(false);
    expect(q.unknownEpisodes).toEqual([2]);
    expect(q.gaps).toEqual(["no_length"]);
    // the partial sum is its own number, named as such
    expect(q.partialSumPricedOnly).toBe(200);
  });

  it("no prices at all: nothing is priced, so neither the total nor the partial sum is a number", () => {
    const q = quoteSeries({ prices: {}, durationsS: [300, 300, 300], videos: [] });
    expect(q.totalCredits).toBeNull();
    expect(q.partialSumPricedOnly).toBeNull();
    expect(q.gaps).toEqual(["no_prices"]);
  });

  it("an invalid length (0, negative, NaN) is passed on as unknown, not priced as free", () => {
    const q = quoteSeries({ prices: PER_MINUTE, durationsS: [0, -5, Number.NaN], videos: [] });
    expect(q.episodes.map((e) => e.credits)).toEqual([null, null, null]);
    expect(q.episodes.map((e) => e.durationS)).toEqual([null, null, null]);
  });

  it("job_minimum is carried per episode", () => {
    const prices = parsePrices([
      { unit: "video_minute", credits_per_unit: 1 },
      { unit: "job_minimum", credits_per_unit: 10 },
    ]);
    const q = quoteSeries({ prices, durationsS: [60, 1200], videos: [] });
    expect(q.episodes.map((e) => [e.credits, e.floorApplied])).toEqual([[10, true], [20, false]]);
    expect(q.totalCredits).toBe(30);
  });

  it("refuses 0 and more than 4 episodes", () => {
    expect(() => quoteSeries({ prices: PER_MINUTE, durationsS: [], videos: [] })).toThrow(RangeError);
    expect(() => quoteSeries({ prices: PER_MINUTE, durationsS: [1, 1, 1, 1, 1].map((x) => x * 60), videos: [] })).toThrow(RangeError);
  });

  it("carries the Gemini call budget, labelled as an unmeasured estimate", () => {
    const q = quoteSeries({ prices: PER_MINUTE, durationsS: [180, 180, 180], videos: [] });
    expect(q.geminiCalls).toEqual({
      planCalls: 1,
      episodes: 3,
      perEpisodeCallsLow: 5,
      perEpisodeCallsHigh: 12,
      totalCallsLow: 16,
      totalCallsHigh: 37,
      label: "estimate, unmeasured",
    });
    expect(seriesCallBudget(4).totalCallsHigh).toBe(49);
    expect(() => seriesCallBudget(5)).toThrow(RangeError);
  });
});

describe("aggregateSeriesQuote (shared cases with the Python twin)", () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, "../../tests/fixtures/series_quote_cases.txt"), "utf8")) as {
    cases: {
      name: string;
      credits: (number | string | boolean | null)[];
      gaps: (EstimateGap | null)[];
      total: number | null;
      partial: number | null;
      complete: boolean;
      unknown: number[];
      gaps_out: string[];
    }[];
  };
  // JSON cannot carry NaN or an infinity; the fixture spells them as strings (the Python test maps them too).
  const SPECIAL: Record<string, number> = { NaN: Number.NaN, Infinity: Number.POSITIVE_INFINITY, "-Infinity": Number.NEGATIVE_INFINITY };
  const raw = (v: number | string | boolean | null): number | null => (typeof v === "string" && v in SPECIAL ? SPECIAL[v] : (v as number | null));

  it("has cases", () => expect(fixture.cases.length).toBeGreaterThanOrEqual(13));

  for (const c of fixture.cases) {
    it(c.name, () => {
      const q = aggregateSeriesQuote(
        c.credits.map(() => 300),
        c.credits.map((cr, i) => estimate(raw(cr), c.gaps[i])),
      );
      expect(q.totalCredits).toBe(c.total);
      expect(q.partialSumPricedOnly).toBe(c.partial);
      expect(q.complete).toBe(c.complete);
      expect(q.unknownEpisodes).toEqual(c.unknown);
      expect(q.gaps).toEqual(c.gaps_out);
    });
  }

  it("an unpriced episode never reports a floor that was applied", () => {
    const q = aggregateSeriesQuote([300], [{ ...estimate(null, "no_history"), floorApplied: true }]);
    expect(q.episodes[0].floorApplied).toBe(false);
  });

  it("an unpriced estimate that names no gap reads 'unknown', not a guessed gap", () => {
    const q = aggregateSeriesQuote([300], [{ ...estimate(null, null) }]);
    expect(q.episodes[0].gap).toBe("unknown");
  });
});
