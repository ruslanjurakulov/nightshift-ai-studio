import { describe, expect, it } from "vitest";
import { registryPrices } from "@/lib/billing";
import { providerRunways, runsOutAt, type ModelActivity, type RunwayData } from "@/lib/owner-analytics/runway";
import { runwayProvidersTable } from "@/lib/owner-analytics/runway-tables";
import { ownerAnalyticsEn as d } from "@/lib/i18n/owner-analytics/en";

// Synthetic fixtures only: no real price, top-up or balance.
const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const registry = registryPrices([{ id: "lab-video", provider: "minimax", spec: { vendor_model: "lab-v1", pricing: { unit: "second", provider_usd_per_unit: 1 } } }]);
const studio = (daysAgo: number, usd: number | null) => ({
  provider: "minimax", vendor_model: "lab-v1", unit: "second", quantity: 5, usd_estimate: usd, recorded_at: iso(NOW - daysAgo * DAY),
});
const act = (over: Partial<ModelActivity> = {}): ModelActivity => ({
  model: "lab-video", unit: "second", jobs: 7, completed: 7, failed: 0, quotaFailed: 0, units: 35, unitsCounted: 7,
  firstAt: iso(NOW - 7 * DAY), lastAt: iso(NOW - 3600_000), lastStatus: "completed", lastErrorCode: null, ...over,
});
function data(over: Partial<RunwayData> = {}): RunwayData {
  return {
    now: NOW, sinceMs: NOW - 90 * DAY, horizonCapped: false,
    topups: [{ provider: "minimax", amount_usd: 100, paid_at: iso(NOW - 10 * DAY) }], topupsUnread: false,
    balances: [], balancesUnread: false, settings: [],
    // One pipeline row for another vendor: the ledger was read and holds rows, so minimax's pipeline share is a measured 0.
    pipelineRows: [{ unit: "tts_characters", quantity: 10, stage: "tts", recorded_at: iso(NOW - DAY) }], pipelineUnread: false, pipelineFromMs: NOW - 90 * DAY,
    studioRows: [1, 2, 3, 4, 5, 6, 6.5].map((n) => studio(n - 0.5, 5)), studioUnread: false, studioFromMs: NOW - 90 * DAY,
    probeRows: [], probesUnread: false, probesFromMs: NOW - 90 * DAY,
    registry,
    activity: { all: [act()], d7: [act()], d1: [act({ jobs: 1 })], missing: false },
    ...over,
  };
}
const minimax = (x: RunwayData) => providerRunways(x).find((r) => r.id === "minimax")!;

describe("provider runway", () => {
  it("estimates what is left as top-ups minus spend, runs out at the 7-day pace, and says it is an estimate", () => {
    const r = minimax(data());
    expect(r.leftUsd).toBeCloseTo(65);
    expect(r.usd7d).toBeCloseTo(35);
    expect(r.burn7d).toBeCloseTo(5);
    expect(r.runsOut).toBeCloseTo(13);
    expect(r.estimate).toBe(true);
    expect(r.status).toBe("ok");
    expect(r.models[0]).toMatchObject({ model: "lab-video", jobs7d: 7, jobs1d: 1, units7d: 35 });
  });

  it("is EMPTY when the newest job was refused for want of balance, whatever the estimate says", () => {
    const r = minimax(data({ activity: { all: [act({ lastStatus: "failed", lastErrorCode: "quota" })], d7: [act()], d1: [act()], missing: false } }));
    expect(r.status).toBe("empty");
    expect(r.quotaAt).not.toBeNull();
  });

  it("warns under three days, unless the provider recharges itself", () => {
    const tight = data({ topups: [{ provider: "minimax", amount_usd: 45, paid_at: iso(NOW - 10 * DAY) }] });
    expect(minimax(tight).status).toBe("low");
    const auto = { ...tight, settings: [{ provider: "minimax", usd_per_unit: null, include_in_bulk: false, card_saved_on_provider: true, auto_recharge_on_provider: true, low_balance_days: 3 }] };
    expect(minimax(auto).status).toBe("ok");
  });

  it("prefers the provider's own reading and carries its time", () => {
    const at = iso(NOW - 2 * 3600_000);
    const r = minimax(data({ balances: [{ provider: "minimax", metric: "usd", remaining: 20, total: null, unit: "usd", tier: null, resets_at: null, source: "api", checked_at: at }] }));
    expect(r.checkedAt).toBe(at);
    expect(r.ledger.remaining.kind).toBe("reported");
  });

  it("leaves the runway unknown when a cost has no price, instead of counting it as free", () => {
    const x = data();
    x.studioRows = [...x.studioRows, { ...studio(1, null), vendor_model: "unlisted" }];
    const r = minimax(x);
    expect(r.usd7d).toBeNull();
    expect(r.runsOut).toBeNull();
    expect(r.status).toBe("unknown");
  });

  it("says the balance before tracking is unknown when spend predates the first top-up", () => {
    const x = data();
    x.studioRows = [...x.studioRows, studio(30, 5)];
    expect(minimax(x).beforeTrackingUnknown).toBe(true);
    expect(minimax(data()).beforeTrackingUnknown).toBe(false);
  });

  it("re-runs the runway at an expected volume", () => {
    expect(runsOutAt(60, 5, 1)).toBeCloseTo(12);
    expect(runsOutAt(60, 5, 2)).toBeCloseTo(6);
    expect(runsOutAt(null, 5, 1)).toBeNull();
  });

  it("writes unknowns as empty cells and the method beside every balance", () => {
    const t = runwayProvidersTable(d, providerRunways(data()), NOW);
    const row = t.rows.find((r) => r[0] === "MiniMax")!;
    expect(String(row[t.columns.indexOf(d.runwayLeftBasis)])).toContain("estimate");
    expect(t.preamble?.join(" ")).toContain(d.runwayMethod);
  });
});
