import { describe, expect, it } from "vitest";
import {
  BILLED_PROVIDERS,
  daysLeft,
  elevenLabsRunway,
  latestBalance,
  ledgerBalanceUsd,
  percentile,
  providerBurn,
  type CostRowLite,
} from "@/lib/billing";

const NOW = Date.parse("2026-09-24T00:00:00Z");
const day = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const by = (id: string) => BILLED_PROVIDERS.find((p) => p.id === id)!;

describe("percentile", () => {
  it("interpolates and handles empty", () => {
    expect(percentile([], 0.75)).toBeNull();
    expect(percentile([10, 20, 30, 40, 50], 0.75)).toBe(40);
    expect(percentile([1, 2], 0.5)).toBe(1.5);
  });
});

describe("providerBurn", () => {
  const rows: CostRowLite[] = [
    { unit: "tts_characters", quantity: 30000, stage: "voice", recorded_at: day(2) },
    { unit: "tts_characters", quantity: 30000, stage: "voice", recorded_at: day(40) }, // outside window
    { unit: "video_gen_clips", quantity: 3, stage: "broll:kling", recorded_at: day(1) },
    { unit: "video_gen_clips", quantity: 5, stage: "broll:minimax", recorded_at: day(1) },
  ];

  it("counts only this provider's rows inside the window", () => {
    const b = providerBurn(by("elevenlabs"), rows, null, 30, NOW);
    expect(b.units).toBe(30000);
    expect(b.unitsPerDay).toBe(1000);
    expect(providerBurn(by("kling"), rows, null, 30, NOW).units).toBe(3);
  });

  it("USD is null when used but unpriced, never zero", () => {
    expect(providerBurn(by("kling"), rows, null, 30, NOW).usdPerDay).toBeNull();
  });

  it("USD per day scales by unit size", () => {
    // 30,000 credits / 30 days = 1000 credits/day = 1 x "1K credits" at $0.30
    expect(providerBurn(by("elevenlabs"), rows, 0.3, 30, NOW).usdPerDay).toBeCloseTo(0.3);
  });

  it("unused provider burns a true zero", () => {
    expect(providerBurn(by("wan"), rows, null, 30, NOW).usdPerDay).toBe(0);
  });
});

describe("ledgerBalanceUsd", () => {
  const topups = [{ provider: "kling", amount_usd: 20, paid_at: day(10) }];
  const rows: CostRowLite[] = [
    { unit: "video_gen_clips", quantity: 4, stage: "broll:kling", recorded_at: day(5) },
    { unit: "video_gen_clips", quantity: 9, stage: "broll:kling", recorded_at: day(20) }, // before top-up
  ];
  it("subtracts priced spend since the first top-up", () => {
    expect(ledgerBalanceUsd(by("kling"), topups, rows, 0.5)).toBe(18);
  });
  it("is null with spend but no price, and null with no top-ups", () => {
    expect(ledgerBalanceUsd(by("kling"), topups, rows, null)).toBeNull();
    expect(ledgerBalanceUsd(by("veo"), topups, rows, 1)).toBeNull();
  });
});

describe("daysLeft", () => {
  it("handles unknown, idle and depleting", () => {
    expect(daysLeft(null, 1)).toBeNull();
    expect(daysLeft(10, null)).toBeNull();
    expect(daysLeft(10, 0)).toBe("never");
    expect(daysLeft(10, 2)).toBe(5);
  });
});

describe("latestBalance", () => {
  it("picks the newest snapshot for the provider", () => {
    const base = { metric: "credits", total: null, unit: "credits", tier: null, resets_at: null, source: "api" };
    const rows = [
      { ...base, provider: "elevenlabs", remaining: 5, checked_at: day(2) },
      { ...base, provider: "elevenlabs", remaining: 9, checked_at: day(1) },
      { ...base, provider: "leonardo", remaining: 1, checked_at: day(0) },
    ];
    expect(latestBalance(rows, "elevenlabs")?.remaining).toBe(9);
    expect(latestBalance(rows, "gemini")).toBeNull();
  });
});

describe("elevenLabsRunway", () => {
  it("minutes use 1000 chars/min as a floor", () => {
    expect(elevenLabsRunway(25_500, []).minMinutes).toBe(25);
  });
  it("videos use the p75 of per-video usage", () => {
    const rows: CostRowLite[] = [
      { unit: "tts_characters", quantity: 8000, stage: "voice", recorded_at: day(1), video_id: "a" },
      { unit: "tts_characters", quantity: 2000, stage: "voice", recorded_at: day(1), video_id: "a" },
      { unit: "tts_characters", quantity: 10000, stage: "voice", recorded_at: day(2), video_id: "b" },
      { unit: "tts_characters", quantity: 12000, stage: "voice", recorded_at: day(3), video_id: "c" },
    ];
    const r = elevenLabsRunway(55_000, rows);
    expect(r.perVideoChars).toBe(11000);
    expect(r.minVideos).toBe(5);
  });
  it("no history → no video estimate", () => {
    const r = elevenLabsRunway(10_000, []);
    expect(r.minVideos).toBeNull();
    expect(r.perVideoChars).toBeNull();
  });
  it("flash models cost half a credit per character", () => {
    expect(elevenLabsRunway(10_000, [], { creditsPerChar: 0.5 }).minMinutes).toBe(20);
  });
});
