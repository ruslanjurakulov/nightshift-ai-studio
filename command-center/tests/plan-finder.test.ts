/**
 * "What does my plan make?" (lib/plan-finder.ts): the per-plan output math against the rates, a missing rate as
 * unavailable (never a number), the finder's recommendation at its boundaries, and the page agreeing with the quote.
 *
 * What would break without these: a card promising a seventh video the credits do not cover; "≈ 0 videos" or a default
 * standing in for an unpublished rate; a plan recommended one credit short; the page and Run now's hold disagreeing by
 * a cent because one of them rounded the rate first; a premium voice silently priced the same as a figure nobody set;
 * the "1080p" and "5 min" printed beside a figure drifting from what the pipeline really does.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chargedPrices, estimateRunCredits, parsePrices, roundUpCredits, type PriceMap } from "@/lib/credits";
import { creditRates } from "@/lib/pricing";
import { fromSellableRow } from "@/lib/models-discovery";
import {
  CHANNEL_RENDER,
  DEFAULT_LENGTH_S,
  cleanInput,
  finderNeed,
  finderPlans,
  fits,
  outputRange,
  recommendPlan,
  studioRows,
  videoPrices,
  videoRateSetAt,
  youtubeVideoCredits,
  type FinderInput,
} from "@/lib/plan-finder";

/** The two rows public_video_rates() (0089) returns: video_minute as charged (rate × (1 + margin), unrounded), job_minimum flat. */
function publicRows(rate: number, margin: number, floor: number | null) {
  return [
    { unit: "video_minute", credits_per_unit: rate * (1 + margin) },
    ...(floor === null ? [] : [{ unit: "job_minimum", credits_per_unit: floor }]),
  ];
}

/** The operator's base list, as credit_prices holds it (what Run now's hold is computed from, after chargedPrices). */
function baseList(rate: number, margin: number, floor: number | null): PriceMap {
  return parsePrices([
    { unit: "video_minute", credits_per_unit: rate, margin, updated_at: "2026-11-03T10:00:00Z" },
    ...(floor === null ? [] : [{ unit: "job_minimum", credits_per_unit: floor, margin: 0.5, updated_at: "2026-10-01T10:00:00Z" }]),
    { unit: "tts_characters", credits_per_unit: 0.002, margin: 0.2 },
  ]);
}

describe("the pipeline facts printed beside a figure", () => {
  const config = readFileSync(path.resolve(process.cwd(), "..", "config.py"), "utf8");
  it("renders at the frame config.py renders at (the card says 1080p)", () => {
    expect(config).toMatch(new RegExp(`^VIDEO_WIDTH = ${CHANNEL_RENDER.width}$`, "m"));
    expect(config).toMatch(new RegExp(`^VIDEO_HEIGHT = ${CHANNEL_RENDER.height}$`, "m"));
  });
  it("works the cards out at config.py's default length", () => {
    expect(config).toMatch(new RegExp(`^VIDEO_DURATION_TARGET = int\\(os\\.getenv\\("VIDEO_DURATION_TARGET", "${DEFAULT_LENGTH_S}"\\)\\)`, "m"));
  });
});

describe("a YouTube video is quoted exactly as Run now holds it", () => {
  const cases: [number, number, number | null, number][] = [
    [10, 0, null, 300],
    [10, 0.25, 30, 300],
    [1, 0.3333, null, 300],
    [7.77, 0.15, 5, 90],
    [2, 0.5, 40, 60],
    [12, 0, 100, 3600],
  ];
  it.each(cases)("rate %s, margin %s, floor %s, %ss: the public read, the member read and the hold agree", (rate, margin, floor, seconds) => {
    const hold = estimateRunCredits({ prices: chargedPrices(baseList(rate, margin, floor)), durationS: seconds, videos: [] }).credits;
    expect(hold).not.toBeNull();
    // Signed out: public_video_rates() rows. Signed in: credit_rates() (chargedPrices is what a pre-0084 list is folded to).
    expect(youtubeVideoCredits(videoPrices(parsePrices(publicRows(rate, margin, floor))), seconds)).toBe(hold);
    expect(youtubeVideoCredits(videoPrices(chargedPrices(baseList(rate, margin, floor))), seconds)).toBe(hold);
  });

  it("does not use the rounded per-minute rate, which disagrees with the hold by a cent", () => {
    const prices = parsePrices(publicRows(1, 0.3333, null));
    const rounded = roundUpCredits(5 * (creditRates(prices).perMinute as number));
    const hold = estimateRunCredits({ prices: chargedPrices(baseList(1, 0.3333, null)), durationS: 300, videos: [] }).credits;
    expect(rounded).toBe(6.7);
    expect(hold).toBe(6.67);
    expect(youtubeVideoCredits(videoPrices(prices), 300)).toBe(6.67);
  });

  it("raises a short video to the smallest hold, as the hold does", () => {
    const prices = videoPrices(parsePrices(publicRows(10, 0, 40)));
    expect(youtubeVideoCredits(prices, 60)).toBe(40);
    expect(youtubeVideoCredits(prices, 300)).toBe(50);
  });

  it("dates the rate by the list's own updated_at when it has one, else not at all", () => {
    expect(videoRateSetAt(videoPrices(chargedPrices(baseList(10, 0, 30))))).toBe("2026-11-03T10:00:00Z");
    expect(videoRateSetAt(videoPrices(parsePrices(publicRows(10, 0, 30))))).toBeNull();
  });
});

describe("a missing rate is unavailable, never a number", () => {
  it.each([
    ["no list", null],
    ["no per-minute row", parsePrices([{ unit: "job_minimum", credits_per_unit: 30 }])],
    ["a zero per-minute rate", parsePrices([{ unit: "video_minute", credits_per_unit: 0 }])],
    ["only ledger prices", parsePrices([{ unit: "tts_characters", credits_per_unit: 0.002 }])],
  ])("%s: no video price, no count, no month", (_, prices) => {
    const video = videoPrices(prices);
    expect(video).toBeNull();
    expect(youtubeVideoCredits(video, 300)).toBeNull();
    expect(fits(2000, youtubeVideoCredits(video, 300))).toBeNull();
    expect(finderNeed({ channels: 2, perWeek: 3, lengthMin: 5, voice: "standard", rerunPct: 25 }, video)).toBeNull();
  });

  it("keeps nothing of the list but the two units a video is quoted from, and no note", () => {
    const list = parsePrices([
      { unit: "video_minute", credits_per_unit: 10, note: "internal" },
      { unit: "job_minimum", credits_per_unit: 30 },
      { unit: "tts_characters", credits_per_unit: 0.002 },
    ]);
    const v = videoPrices(list)!;
    expect(Object.keys(v).sort()).toEqual(["job_minimum", "video_minute"]);
    expect(v.video_minute.note).toBeNull();
  });
});

describe("what one plan's credits make", () => {
  it("is floor(credits ÷ the quote): never a video the credits do not cover", () => {
    const prices = videoPrices(parsePrices(publicRows(10, 0.25, 30)));
    const per = youtubeVideoCredits(prices, DEFAULT_LENGTH_S)!; // 5 min × 12.5 = 62.5
    expect(per).toBe(62.5);
    expect(fits(2000, per)).toBe(32); // 32 × 62.5 = 2000 exactly: it fits
    expect(fits(1999.99, per)).toBe(31);
    expect(fits(6000, per)).toBe(96);
    expect(fits(50, per)).toBe(0);
  });

  const rows = [
    // Image: one quality-priced model (medium is 0.5, high is 2), one flat (0.04 → raised to the 0.1 floor).
    { id: "img-a", display_name: "Picture A", provider: "p", capabilities: ["t2i"], availability: "ga", verified_at: "2026-11-01", credit_unit: "img_a", spec: { output: "image", unit: "image", qualities: ["medium", "high"], price_variants_by: "quality" } },
    { id: "img-b", display_name: "Picture B", provider: "p", capabilities: ["t2i"], availability: "ga", verified_at: "2026-11-01", credit_unit: "img_b", credits_per_unit: 0.04, spec: { output: "image", unit: "image" } },
    // Video: 5 s is its shortest clip, at 3 a second.
    { id: "vid-a", display_name: "Clip A", provider: "p", capabilities: ["t2v"], availability: "beta", verified_at: "2026-11-01", credit_unit: "vid_a", credits_per_unit: 3, spec: { output: "video", unit: "second", durations_s: [10, 5] } },
    // Behind a first purchase: listed with its price, left out of the card's range.
    { id: "img-c", display_name: "Picture C", provider: "p", capabilities: ["t2i"], availability: "ga", verified_at: "2026-11-01", credit_unit: "img_c", credits_per_unit: 0.01, entitlement: "paid", spec: { output: "image", unit: "image" } },
    // Listed, but the price list has no rate for it: not on sale.
    { id: "vid-b", display_name: "Clip B", provider: "p", capabilities: ["t2v"], availability: "ga", verified_at: "2026-11-01", credit_unit: "vid_b", credits_per_unit: 1, spec: { output: "video", unit: "second", durations_s: [5] } },
  ];
  const list = { img_a_medium: 0.5, img_a_high: 2, img_b: 0.04, vid_a: 3, img_c: 0.01 };
  const models = rows.map((r) => fromSellableRow(r, list, false)!);
  const studio = studioRows(models, 0.1);

  it("prices each Studio setting the way creative_price does: quantity × rate, up to the cent, raised to the floor", () => {
    const by = (model: string, part = "") => studio.find((r) => r.model === model && r.parts.join() === part)!;
    expect(by("Picture A", "medium").perOutput).toBe(0.5);
    expect(by("Picture A", "high").perOutput).toBe(2);
    expect(by("Picture B").perOutput).toBe(0.1);
    expect(by("Clip A")).toMatchObject({ perOutput: 15, seconds: 5, kind: "video" });
    expect(by("Clip B")).toMatchObject({ rate: null, perOutput: null, state: "not_on_sale" });
    expect(by("Picture C")).toMatchObject({ state: "plan_gated", perOutput: 0.1 });
  });

  it("gives a range with both ends named — never 'up to' off the cheapest model alone", () => {
    const r = outputRange(2000, studio, "image")!;
    expect(r.low).toMatchObject({ count: 1000, row: { model: "Picture A", parts: ["high"] } });
    expect(r.high).toMatchObject({ count: 20000, row: { model: "Picture B" } });
    // The plan-gated model is cheaper per picture but is not counted: the plan alone does not open it.
    expect(r.high.row.model).not.toBe("Picture C");
    expect(outputRange(2000, studio, "video")).toMatchObject({ low: { count: 133 }, high: { count: 133 } });
  });

  it("has no range when nothing of that kind is priced and open", () => {
    expect(outputRange(2000, studio.filter((r) => r.kind !== "video" || r.state !== "available"), "video")).toBeNull();
    expect(outputRange(2000, [], "image")).toBeNull();
  });
});

describe("the plan finder", () => {
  const prices = videoPrices(parsePrices(publicRows(10, 0, 30)))!; // 5 min = 50 credits
  const base: FinderInput = { channels: 1, perWeek: 3, lengthMin: 5, voice: "standard", rerunPct: 0 };
  const plans = [
    { id: "studio", name: "Studio", credits: 18000 },
    { id: "creator", name: "Creator", credits: 2000 },
    { id: "pro", name: "Pro", credits: 6000 },
  ];

  it("counts a month as 52/12 weeks, rounded up to whole videos", () => {
    expect(finderNeed(base, prices)).toMatchObject({ videos: 13, perVideo: 50, base: 650, total: 650, headroom: 0 });
    expect(finderNeed({ ...base, perWeek: 1 }, prices)!.videos).toBe(5); // 4.33… → 5
    expect(finderNeed({ ...base, channels: 2, perWeek: 7 }, prices)!.videos).toBe(61); // 60.67 → 61
  });

  it("adds the re-run room on top, and says the voice does not change the price", () => {
    expect(finderNeed({ ...base, rerunPct: 25 }, prices)).toMatchObject({ base: 650, headroom: 162.5, total: 812.5 });
    expect(finderNeed({ ...base, voice: "premium" }, prices)).toEqual(finderNeed(base, prices));
  });

  it("is the hold of every video in the month: never a figure of its own", () => {
    const need = finderNeed({ channels: 3, perWeek: 2, lengthMin: 7, voice: "standard", rerunPct: 0 }, prices)!;
    const hold = estimateRunCredits({ prices, durationS: 7 * 60, videos: [] }).credits!;
    expect(need.perVideo).toBe(hold);
    expect(need.total).toBe(roundUpCredits(need.videos * hold));
  });

  it("says when the smallest hold set a video's price", () => {
    const floored = videoPrices(parsePrices(publicRows(10, 0, 40)))!;
    expect(finderNeed({ ...base, lengthMin: 1 }, floored)).toMatchObject({ perVideo: 40, floored: true });
    expect(finderNeed({ ...base, lengthMin: 5 }, floored)).toMatchObject({ perVideo: 50, floored: false });
  });

  it("keeps a typed value within the controls' bounds and a known headroom step", () => {
    expect(cleanInput({ channels: 0, perWeek: 99, lengthMin: 2.6, voice: "x" as never, rerunPct: 33 })).toEqual({
      channels: 1,
      perWeek: 14,
      lengthMin: 3,
      voice: "standard",
      rerunPct: 0,
    });
  });

  it.each([
    [1999.99, "creator"],
    [2000, "creator"], // exactly the plan's credits: it covers
    [2000.01, "pro"], // a cent over: the next plan
    [6000, "pro"],
    [6000.01, "studio"],
    [18000, "studio"],
  ])("recommends, for %s credits a month, %s", (total, id) => {
    const r = recommendPlan(total, plans);
    expect(r.kind).toBe("plan");
    expect(r.kind === "plan" && r.plan.id).toBe(id);
  });

  it("names what is left over rounded down, never flattering the plan", () => {
    expect(recommendPlan(1999.995, plans)).toMatchObject({ kind: "plan", spare: 0 });
    expect(recommendPlan(812.5, plans)).toMatchObject({ kind: "plan", plan: { id: "creator" }, spare: 1187.5 });
  });

  it("past the largest plan, names it and what is short (packs cover the rest)", () => {
    expect(recommendPlan(18000.01, plans)).toEqual({ kind: "over", plan: plans[0], short: 0.01 });
  });

  it("matches nothing when no plan is on sale, and never the free plan", () => {
    expect(recommendPlan(10, [])).toEqual({ kind: "none" });
    const cols = [
      { id: "free", name: "Free", monthlyCredits: 0, isDefault: true, priceId: null, displayPrice: null },
      { id: "creator", name: "Creator", monthlyCredits: 2000, isDefault: false, priceId: null, displayPrice: "$12" },
      { id: "pro", name: "Pro", monthlyCredits: 6000, isDefault: false, priceId: null, displayPrice: null }, // no price, no checkout
    ];
    expect(finderPlans(cols)).toEqual([{ id: "creator", name: "Creator", credits: 2000 }]);
  });
});
