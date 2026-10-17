import { describe, expect, it } from "vitest";
import {
  BILLED_PROVIDERS,
  daysLeft,
  elevenLabsRunway,
  firstUseMs,
  providerHistoryStart,
  rowMs,
  latestBalance,
  ledgerBalanceUsd,
  percentile,
  planTopups,
  providerBurn,
  splitCents,
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


describe("splitCents", () => {
  it("sums to exactly the total, proportionally", () => {
    const parts = splitCents(1000, [1, 1, 1]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(1000);
    expect(parts.sort()).toEqual([333, 333, 334]);
    expect(splitCents(1000, [3, 1])).toEqual([750, 250]);
  });
  it("splits equally when every weight is zero", () => {
    expect(splitCents(100, [0, 0])).toEqual([50, 50]);
  });
});

describe("planTopups", () => {
  const inputs = [
    { id: "elevenlabs", usdPerDay: 1, balanceUsd: 10 }, // need 20 over 30 days
    { id: "kling", usdPerDay: 2, balanceUsd: null }, // need 60, balance unknown
    { id: "gemini", usdPerDay: null, balanceUsd: 5 }, // unpriced
    { id: "wan", usdPerDay: 0, balanceUsd: 3 }, // idle
  ];

  it("pays each need without a cap; unpriced excluded", () => {
    const plan = planTopups(inputs, 30);
    const by = Object.fromEntries(plan.lines.map((l) => [l.id, l]));
    expect(by.elevenlabs.amount).toBe(20);
    expect(by.kling.amount).toBe(60);
    expect(by.kling.balanceUnknown).toBe(true);
    expect(by.gemini.amount).toBeNull();
    expect(by.wan.amount).toBe(0);
    expect(plan.total).toBe(80);
    expect(plan.scaled).toBe(false);
  });

  it("splits a lower cap in proportion to need, summing to the cap exactly", () => {
    const plan = planTopups(inputs, 30, 40);
    const by = Object.fromEntries(plan.lines.map((l) => [l.id, l]));
    expect(plan.scaled).toBe(true);
    expect(by.elevenlabs.amount).toBe(10);
    expect(by.kling.amount).toBe(30);
    expect(plan.total).toBe(40);
  });

  it("a cap above the need changes nothing", () => {
    expect(planTopups(inputs, 30, 500).total).toBe(80);
  });

  it("rounds needs up to the cent", () => {
    const plan = planTopups([{ id: "a", usdPerDay: 0.0333, balanceUsd: 0 }], 7);
    expect(plan.lines[0].amount).toBe(0.24);
  });
});

describe("burn window = min(30, THIS provider's own history)", () => {
  it("a provider first used 2 days ago, 10 clips, in a 25-day-old ledger: 5 a day (not 10/25, not 10/30)", () => {
    const rows: CostRowLite[] = [
      { unit: "tts_characters", quantity: 1, stage: "voice", recorded_at: day(25) }, // the ledger is 25 days old
      { unit: "video_gen_clips", quantity: 4, stage: "broll:kling", recorded_at: day(2) },
      { unit: "video_gen_clips", quantity: 6, stage: "broll:kling", recorded_at: day(0.5) },
    ];
    const start = providerHistoryStart(firstUseMs(by("kling"), rows), null);
    const b = providerBurn(by("kling"), rows, null, 30, NOW, start);
    expect(b.units).toBe(10);
    expect(b.windowDays).toBeCloseTo(2, 5);
    expect(b.unitsPerDay).toBeCloseTo(5, 5);
    // the whole ledger's age would have said 10 / 25
    expect(providerBurn(by("kling"), rows, null, 30, NOW).unitsPerDay).toBeCloseTo(10 / 30, 5);
  });
  it("starts at its first top-up when that came later than its first use", () => {
    const rows: CostRowLite[] = [
      { unit: "video_gen_clips", quantity: 100, stage: "broll:kling", recorded_at: day(20) },
      { unit: "video_gen_clips", quantity: 10, stage: "broll:kling", recorded_at: day(2) },
    ];
    const start = providerHistoryStart(firstUseMs(by("kling"), rows), NOW - 4 * 86_400_000);
    const b = providerBurn(by("kling"), rows, null, 30, NOW, start);
    expect(b.units).toBe(10);
    expect(b.windowDays).toBeCloseTo(4, 5);
  });
  it("a long history keeps the 30-day window", () => {
    const rows: CostRowLite[] = [{ unit: "tts_characters", quantity: 60000, stage: "voice", recorded_at: day(80) }, { unit: "tts_characters", quantity: 3000, stage: "voice", recorded_at: day(3) }];
    const b = providerBurn(by("elevenlabs"), rows, null, 30, NOW, providerHistoryStart(firstUseMs(by("elevenlabs"), rows), null));
    expect(b.windowDays).toBe(30);
    expect(b.units).toBe(3000);
  });
  it("the oldest run is never dropped: the window edge IS the first row, whatever the milliseconds (clock offset T2 = T1 + 5 ms)", () => {
    const T1 = Date.parse("2026-09-24T12:00:00.000Z");
    const rows: CostRowLite[] = [{ unit: "video_gen_clips", quantity: 7, stage: "broll:kling", recorded_at: new Date(T1 - 3 * 86_400_000).toISOString() }];
    const start = providerHistoryStart(firstUseMs(by("kling"), rows), null);
    for (const offset of [0, 1, 5, 37, 999]) expect(providerBurn(by("kling"), rows, null, 30, T1 + offset, start).units, `+${offset}ms`).toBe(7);
  });
  it("randomized float round trip: a row's own stamp is always inside its own window", () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 500; i++) {
      const now = Date.UTC(2026, 0, 1) + Math.floor(rand() * 1e10) + rand();
      const ageDays = rand() * 29.9 + 0.001;
      const stamp = new Date(now - ageDays * 86_400_000).toISOString();
      const rows: CostRowLite[] = [{ unit: "video_gen_clips", quantity: 1, stage: "broll:kling", recorded_at: stamp }];
      const start = providerHistoryStart(firstUseMs(by("kling"), rows), null);
      expect(providerBurn(by("kling"), rows, null, 30, now + Math.floor(rand() * 20), start).units, stamp).toBe(1);
    }
  });
  it("a bare stored stamp is read as UTC, not as the server's local time", () => {
    expect(rowMs("2026-09-24T12:00:00")).toBe(Date.parse("2026-09-24T12:00:00Z"));
    expect(rowMs("2026-09-24T12:00:00+05:00")).toBe(Date.parse("2026-09-24T07:00:00Z"));
  });
});

describe("a ledger balance that cannot be trusted is unknown, not a number", () => {
  const eleven = by("elevenlabs");
  const spend: CostRowLite[] = [{ unit: "tts_characters", quantity: 2_000_000, stage: "voice", recorded_at: day(1) }];
  it("negative (top-ups do not cover the spend: trial credit, auto-recharge, an unlogged top-up) is null, and so are its days", () => {
    // 2,000,000 credits at $0.30 / 1000 = $600 spent against $100 topped up.
    expect(ledgerBalanceUsd(eleven, [{ provider: "elevenlabs", amount_usd: 100, paid_at: day(10) }], spend, 0.3)).toBeNull();
    expect(daysLeft(-5, 10)).toBeNull();
    expect(daysLeft(0, 10)).toBe(0);
  });
  it("the first top-up is older than the spend we read: the balance would be overstated, so null", () => {
    const topups = [{ provider: "elevenlabs", amount_usd: 500, paid_at: day(100) }];
    expect(ledgerBalanceUsd(eleven, topups, [], 0.3)).toBe(500);
    expect(ledgerBalanceUsd(eleven, topups, [], 0.3, NOW - 90 * 86_400_000)).toBeNull();
    expect(ledgerBalanceUsd(eleven, topups, [], 0.3, NOW - 120 * 86_400_000)).toBe(500);
  });
  it("Anthropic and OpenAI are not tracked: no ledger balance, no burn pretending to be zero", async () => {
    const { isTracked } = await import("@/lib/billing");
    for (const id of ["anthropic", "openai"]) {
      expect(isTracked(by(id))).toBe(false);
      expect(ledgerBalanceUsd(by(id), [{ provider: id, amount_usd: 50, paid_at: day(5) }], [], 1)).toBeNull();
    }
    expect(isTracked(eleven)).toBe(true);
  });
});
