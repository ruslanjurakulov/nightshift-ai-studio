import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BILLED_PROVIDERS,
  BILLED_PROVIDER_IDS,
  billingIdFor,
  providerLedger,
  REGISTRY_BILLING,
  registryPrices,
  utcDayStart,
  type LedgerInputs,
  type ProbeRunRow,
  type StudioCostRow,
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

// ── The owner's ledger: bought, used by source, left ─────────────────────────────────────────────────────────────────

/** The registry file, shaped as model_registry_admin() returns it (static columns + spec: everything else, modules/model_registry.py sync_rows). */
const REGISTRY_FILE = JSON.parse(readFileSync(join(__dirname, "..", "..", "schemas", "model_registry.json"), "utf8")) as {
  models: Array<Record<string, unknown> & { id: string; provider: string }>;
};
const COLUMNS = new Set(["id", "display_name", "provider", "adapter", "capabilities", "credit_unit", "entitlement"]);
const REGISTRY_ROWS = REGISTRY_FILE.models.map((m) => ({
  id: m.id,
  provider: m.provider,
  spec: Object.fromEntries(Object.entries(m).filter(([k]) => !COLUMNS.has(k))),
}));
const PRICES = registryPrices(REGISTRY_ROWS);
const price = (id: string) => PRICES.find((p) => p.id === id)!;

describe("the provider list is derived from the model registry and the billing providers", () => {
  it("every registry vendor (but the placeholder) has a row, and no row is a guess of a vendor the registry does not name", () => {
    const vendors = new Set(REGISTRY_FILE.models.map((m) => m.provider));
    vendors.delete("unassigned-video-vendor");
    expect(Object.keys(REGISTRY_BILLING).sort()).toEqual([...vendors].sort());
    for (const [vendor, id] of Object.entries(REGISTRY_BILLING)) expect(BILLED_PROVIDER_IDS, vendor).toContain(id);
  });
  it("keeps every billing provider it had (their settings and top-ups are keyed by id) and has no id twice", () => {
    for (const id of ["elevenlabs", "gemini", "minimax", "kling", "veo", "seedance", "wan", "higgsfield", "leonardo", "anthropic", "openai"]) {
      expect(BILLED_PROVIDER_IDS).toContain(id);
    }
    expect(new Set(BILLED_PROVIDER_IDS).size).toBe(BILLED_PROVIDER_IDS.length);
    expect(BILLED_PROVIDER_IDS).toContain("runway");
  });
  it("a billing link is https or none at all, never a guess; Runway's is the developer portal its pricing page names", () => {
    for (const p of BILLED_PROVIDERS) if (p.billingUrl !== null) expect(p.billingUrl, p.id).toMatch(/^https:\/\/[a-z0-9.-]+(\/|$)/);
    const runway = by("runway");
    expect(runway.billingUrl).toBe("https://dev.runway.com/");
    expect(runway.creditUsd).toBe(0.01);
    // Vendors whose docs name no billing page get none.
    for (const id of ["recraft", "xai", "pika", "vidu", "meta", "luma", "sonilo", "ideogram"]) expect(by(id).billingUrl, id).toBeNull();
  });
  it("the pipeline's own image stages land on their vendors; vendors it never calls say so instead of a measured zero", () => {
    expect(by("bfl").usage({ unit: "image_generations", quantity: 3, stage: "image:flux", recorded_at: day(1) })).toBe(3);
    expect(by("ideogram").usage({ unit: "image_generations", quantity: 2, stage: "image:ideogram", recorded_at: day(1) })).toBe(2);
    expect(by("bfl").pipeline).toBe(true);
    for (const id of ["runway", "krea", "lightricks", "luma", "pika", "recraft", "sonilo", "vidu", "xai", "meta", "assemblyai"]) {
      expect(by(id).pipeline, id).toBe(false);
    }
    // The rows that were already there are unchanged: the pipeline uses them (or does not record them).
    expect(by("kling").pipeline).toBeUndefined();
  });
  it("billingIdFor: Google's Veo apart from Gemini, ByteDance on Seedance, Alibaba on Wan, and nothing for an unknown name", () => {
    expect(billingIdFor("google", "veo-3.1-generate-preview")).toBe("veo");
    expect(billingIdFor("google", "gemini-3.1-flash-image")).toBe("gemini");
    expect(billingIdFor("bytedance", "seedance-1-0-pro")).toBe("seedance");
    expect(billingIdFor("alibaba", "wan2.6")).toBe("wan");
    expect(billingIdFor("Runway ", "gen4.5")).toBe("runway");
    for (const bad of ["", "unassigned-video-vendor", "constructor", "__proto__", "toString", null, undefined]) expect(billingIdFor(bad)).toBeNull();
  });
});

describe("registryPrices", () => {
  it("prices a probe from the registry's own figure times the probe's length (Runway: 12 and 5 credits a second, 5 s)", () => {
    expect(price("runway-gen4.5").probeUsd).toBeCloseTo(0.6);
    expect(price("runway-gen4-turbo").probeUsd).toBeCloseTo(0.25);
    expect(price("runway-gen4.5").billingId).toBe("runway");
  });
  it("a variant price is used for the probe's own option; a Studio row (which does not say the option) gets none", () => {
    expect(price("minimax-h3").probeUsd).toBeCloseTo(0.08 * 4);
    expect(price("minimax-h3").usdPerUnit).toBeNull();
  });
  it("no price in the registry is no price here, never 0", () => {
    expect(price("openai-gpt-image-2").usdPerUnit).toBeNull();
    expect(price("openai-gpt-image-2").probeUsd).toBeNull();
    expect(price("ideogram-3").probeUsd).toBeNull();
  });
  it("ignores rows it cannot read", () => {
    expect(registryPrices([null, 5, "x", { provider: "runway" }, []])).toEqual([]);
  });
});

describe("providerLedger", () => {
  const TODAY = Date.parse("2026-11-13T18:00:00Z");
  const at = (h: number) => new Date(Date.parse("2026-11-13T00:00:00Z") + h * 3_600_000).toISOString();
  const base = (id: string, over: Partial<LedgerInputs> = {}): LedgerInputs => ({
    provider: by(id),
    now: TODAY,
    topups: [],
    topupsUnread: false,
    pipelineRows: [],
    pipelineUnread: false,
    pipelineFromMs: null,
    usdPerUnit: null,
    studioRows: [],
    studioUnread: false,
    studioFromMs: null,
    probeRows: [],
    probesUnread: false,
    probesFromMs: null,
    registry: PRICES,
    balances: [],
    balancesUnread: false,
    ...over,
  });
  // The owner's day: $10 = 1,000 credits bought (logged at 15:00), then the two probes Runway billed 60 and 25 credits for.
  const topup = { provider: "runway", amount_usd: 10, paid_at: at(15) };
  const probes: ProbeRunRow[] = [
    { model_id: "runway-gen4.5", ok: true, error_code: null, created_at: at(9), vendor_credits: 60 },
    { model_id: "runway-gen4-turbo", ok: true, error_code: null, created_at: at(9.5), vendor_credits: "25" },
  ];

  it("Runway today: bought $10 = 1,000 credits; probes used 85 credits ($0.85, as Runway billed them); 915 left (estimate)", () => {
    const l = providerLedger(base("runway", { topups: [topup], probeRows: probes }));
    expect(l.bought).toMatchObject({ state: "ok", usd: 10, credits: 1000, count: 1 });
    // The day of the top-up counts from its start: probes made before the top-up was logged are what it paid for.
    expect(l.startMs).toBe(utcDayStart(Date.parse(at(15))));
    expect(l.sources.probes).toMatchObject({ state: "ok", rows: 2, estimate: false, billingUnknown: 0 });
    expect(l.sources.probes.usd).toBeCloseTo(0.85);
    expect(l.sources.pipeline.state).toBe("not_used");
    expect(l.sources.studio).toMatchObject({ state: "ok", rows: 0, usd: 0 });
    expect(l.used.usd).toBeCloseTo(0.85);
    expect(l.used.credits).toBeCloseTo(85);
    expect(l.used.estimate).toBe(false);
    expect(l.remaining.kind).toBe("estimate");
    if (l.remaining.kind === "estimate") {
      expect(l.remaining.usd).toBeCloseTo(9.15);
      expect(l.remaining.credits).toBeCloseTo(915);
    }
  });

  it("what Runway's own API reported wins over the estimate, with its timestamp", () => {
    const snap = { provider: "runway", metric: "credits", remaining: 915, total: null, unit: "credits", tier: null, resets_at: null, source: "api", checked_at: at(17) };
    const l = providerLedger(base("runway", { topups: [topup], probeRows: probes, balances: [snap] }));
    expect(l.remaining).toEqual({ kind: "reported", amount: 915, unit: "credits", checkedAt: at(17), usd: 9.15 });
  });

  it("probes recorded before 0152 (no vendor figure) are priced from the registry and labelled an estimate", () => {
    const old = probes.map((p) => ({ ...p, vendor_credits: undefined }));
    const l = providerLedger(base("runway", { topups: [topup], probeRows: old }));
    expect(l.sources.probes.usd).toBeCloseTo(0.85);
    expect(l.sources.probes.estimate).toBe(true);
    expect(l.used.estimate).toBe(true);
  });

  it("Studio seconds are priced from the registry (an estimate); the worker's own figure wins when it wrote one", () => {
    const studio: StudioCostRow[] = [
      { provider: "runway", vendor_model: "gen4_turbo", unit: "second", quantity: "10", usd_estimate: null, recorded_at: at(12) },
      { provider: "runway", vendor_model: "gen4.5", unit: "second", quantity: 5, usd_estimate: 0.61, recorded_at: at(13) },
      { provider: "kling", vendor_model: "kling-v3", unit: "second", quantity: 5, usd_estimate: null, recorded_at: at(13) },
    ];
    const l = providerLedger(base("runway", { topups: [topup], studioRows: studio }));
    expect(l.sources.studio).toMatchObject({ state: "ok", rows: 2, estimate: true });
    expect(l.sources.studio.usd).toBeCloseTo(0.5 + 0.61);
  });

  it("unknown is never zero: an unpriced Studio row leaves the total unknown, with the priced part as a floor and the units shown", () => {
    const studio: StudioCostRow[] = [
      { provider: "kling", vendor_model: "kling-v3", unit: "second", quantity: 5, usd_estimate: null, recorded_at: at(12) },
      { provider: "kling", vendor_model: "kling-v2-6", unit: "second", quantity: 10, usd_estimate: null, recorded_at: at(12) },
    ];
    const l = providerLedger(base("kling", { topups: [{ provider: "kling", amount_usd: 20, paid_at: at(1) }], studioRows: studio }));
    // kling-v3 has two audio prices and the row does not say which ran: no price. kling-v2.6 has one: $0.042 a second.
    expect(l.sources.studio.usd).toBeNull();
    expect(l.sources.studio.pricedUsd).toBeCloseTo(0.42);
    expect(l.sources.studio.unpriced).toEqual([{ unit: "second", quantity: 5, rows: 1 }]);
    expect(l.used.usd).toBeNull();
    expect(l.used.pricedUsd).toBeCloseTo(0.42);
    expect(l.remaining).toEqual({ kind: "unknown", why: "used_unknown" });
    expect(l.runsOut).toBeNull();
  });

  it("a probe that failed after the vendor may have run it is 'billing unknown'; one refused at the door costs nothing", () => {
    const rows: ProbeRunRow[] = [
      { model_id: "runway-gen4.5", ok: false, error_code: "auth", created_at: at(8) },
      { model_id: "runway-gen4.5", ok: false, error_code: "quota", created_at: at(8) },
      { model_id: "runway-gen4.5", ok: false, error_code: "timeout", created_at: at(8) },
    ];
    const l = providerLedger(base("runway", { topups: [topup], probeRows: rows }));
    expect(l.sources.probes).toMatchObject({ usd: null, billingUnknown: 1, rows: 1 });
    expect(l.remaining).toEqual({ kind: "unknown", why: "used_unknown" });
    const refused = providerLedger(base("runway", { topups: [topup], probeRows: rows.slice(0, 2) }));
    expect(refused.sources.probes).toMatchObject({ usd: 0, rows: 0 });
  });

  it("a read that failed is unknown, not $0: Studio, probes, the registry, the top-ups, the balances", () => {
    expect(providerLedger(base("runway", { topups: [topup], studioUnread: true })).used.usd).toBeNull();
    expect(providerLedger(base("runway", { topups: [topup], probesUnread: true })).sources.probes.state).toBe("unread");
    expect(providerLedger(base("runway", { topups: [topup], registry: null })).sources.probes.state).toBe("unread");
    const noTopups = providerLedger(base("runway", { topupsUnread: true }));
    expect(noTopups.bought).toEqual({ state: "unread" });
    expect(noTopups.remaining).toEqual({ kind: "unknown", why: "unread" });
    expect(providerLedger(base("runway", { balancesUnread: true })).remaining).toEqual({ kind: "unknown", why: "unread" });
  });

  it("no top-up recorded and no balance API: left is unknown and says why; 'used' covers the last 30 days", () => {
    const l = providerLedger(base("runway", { probeRows: probes }));
    expect(l.bought).toEqual({ state: "none" });
    expect(l.sinceTopup).toBe(false);
    expect(l.startMs).toBe(TODAY - 30 * 86_400_000);
    expect(l.used.usd).toBeCloseTo(0.85);
    expect(l.remaining).toEqual({ kind: "unknown", why: "no_topup" });
  });

  it("more used than the top-ups recorded is unknown, not a negative or zero balance", () => {
    const big: ProbeRunRow[] = [{ model_id: "runway-gen4.5", ok: true, error_code: null, created_at: at(16), vendor_credits: 1200 }];
    expect(providerLedger(base("runway", { topups: [topup], probeRows: big })).remaining).toEqual({ kind: "unknown", why: "negative" });
  });

  it("the pipeline: untracked spend makes the total unknown; a history read in part is a floor; a priced ledger counts", () => {
    expect(providerLedger(base("openai")).sources.pipeline.state).toBe("untracked");
    expect(providerLedger(base("openai")).used.usd).toBeNull();
    const kling = { unit: "video_gen_clips", quantity: 4, stage: "broll:kling", recorded_at: at(10) };
    const priced = providerLedger(base("kling", { pipelineRows: [kling], usdPerUnit: 0.5 }));
    expect(priced.sources.pipeline).toMatchObject({ state: "ok", rows: 1, usd: 2, estimate: false });
    const cut = providerLedger(base("kling", { pipelineRows: [kling], usdPerUnit: 0.5, pipelineFromMs: Date.parse(at(5)) }));
    expect(cut.sources.pipeline).toMatchObject({ state: "partial", usd: null, pricedUsd: 2 });
    const unpriced = providerLedger(base("kling", { pipelineRows: [kling] }));
    expect(unpriced.sources.pipeline.unpriced).toEqual([{ unit: "video_gen_clips", quantity: 4, rows: 1 }]);
  });

  it("runs out: the remaining dollars at the pace of the last 30 days; nothing spent with a balance is 'never'", () => {
    const l = providerLedger(base("runway", { topups: [topup], probeRows: probes }));
    // $9.15 left at $0.85 over a window of one day (at least one day is used) = about 10.8 days.
    expect(l.usdPerDay).toBeCloseTo(0.85);
    expect(l.runsOut).toBeCloseTo(9.15 / 0.85);
    expect(providerLedger(base("runway", { topups: [topup] })).runsOut).toBe("never");
    expect(providerLedger(base("runway", { probeRows: probes })).runsOut).toBeNull();
  });
});
