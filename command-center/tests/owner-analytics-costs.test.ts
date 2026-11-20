import { describe, expect, it } from "vitest";
import { coerceBalanceRows, coerceSpendRows, grossProfit, monthlyResults, summarizeSpend, type SpendRow } from "@/lib/owner-analytics/costs";
import { resolvePeriod, tashkentDayStartUtc } from "@/lib/owner-analytics/period";
import type { MoneyRow } from "@/lib/owner-analytics/money";

const NOW = new Date("2026-11-20T10:00:00Z");
const OCT = resolvePeriod("custom", NOW, { start: "2026-10-01", end: "2026-10-31" }).period;
const MID = resolvePeriod("custom", NOW, { start: "2026-10-15", end: "2026-11-10" }).period;

const spend = (p: Partial<SpendRow>): SpendRow => ({
  day: "2026-10-02", source: "creative", provider: "v", model: "m", internal: false, costRows: 1, usdKnown: 2, unpriced: 0, ...p,
});
const sale = (at: string, minor: number): MoneyRow => ({
  event: "sale", at, provider: "dodo", paymentRef: `pay_${at}`, orgRef: "o", kind: "pack", item: "x", charge: null, currency: "USD",
  amountMinor: minor, feeMinor: null, periodStart: null, periodEnd: null, subscriptionRef: null, internal: false,
});

describe("owner analytics costs", () => {
  it("counts an undated pipeline row and makes the internal side incomplete", () => {
    const s = summarizeSpend([spend({ day: null, source: "pipeline", internal: true })], OCT);
    expect(s.undated).toBe(1);
    const m = monthlyResults([], [spend({ day: null, internal: true })], [{ id: 1, month: "2026-10-01", category: "tools", amountUsd: 1, note: null, enteredAt: "" }], OCT, tashkentDayStartUtc);
    expect(m[0].internalSpend).toBeNull();
    expect(m[0].operating).toBeNull();
  });

  it("gives a whole month with everything known an operating result", () => {
    const m = monthlyResults([sale("2026-10-05T10:00:00Z", 1000)], [spend({})], [{ id: 1, month: "2026-10-01", category: "tools", amountUsd: 3, note: null, enteredAt: "" }], OCT, tashkentDayStartUtc);
    expect(m[0]).toMatchObject({ partial: false, net: 10, spend: 2, internalSpend: 0, entered: 3, operating: 5 });
  });

  it("keeps an unpriced cost row out of the sum and counts it, and splits customer from internal spend", () => {
    const s = summarizeSpend([spend({}), spend({ usdKnown: 0, unpriced: 1 }), spend({ internal: true, usdKnown: 5 })], OCT);
    expect(s.customer).toEqual({ usd: 2, unpriced: 1, rows: 2 });
    expect(s.internal).toEqual({ usd: 5, unpriced: 0, rows: 1 });
  });

  it("has no gross profit while a cost is unpriced or revenue is incomplete", () => {
    const money = [sale("2026-10-05T10:00:00Z", 1000)];
    expect(grossProfit(money, summarizeSpend([spend({ unpriced: 1 })], OCT), OCT).grossProfit).toBeNull();
    const gp = grossProfit(money, summarizeSpend([spend({})], OCT), OCT);
    expect(gp).toEqual({ net: 10, spend: 2, grossProfit: 8, margin: 0.8 });
    expect(grossProfit([{ ...money[0], amountMinor: null }], summarizeSpend([spend({})], OCT), OCT).net).toBeNull();
  });

  it("gives a month without entered costs no operating result, and flags a partial month", () => {
    const months = monthlyResults(
      [sale("2026-10-20T10:00:00Z", 1000), sale("2026-11-05T10:00:00Z", 500)],
      [spend({ day: "2026-10-20" }), spend({ day: "2026-11-05", usdKnown: 1 })],
      [{ id: 1, month: "2026-10-01", category: "tools", amountUsd: 3, note: null, enteredAt: "" }],
      MID,
      tashkentDayStartUtc,
    );
    expect(months.map((m) => [m.month, m.partial, m.net, m.spend, m.entered, m.operating])).toEqual([
      // Partial months have no operating result: a whole month's costs against part of a month's revenue is not a number.
      ["2026-10", true, 10, 2, 3, null],
      ["2026-11", true, 5, 1, null, null],
    ]);
  });

  it("drops malformed rows instead of reading them as zero", () => {
    expect(coerceSpendRows([{ day: "x", provider: "v", cost_rows: 1 }, { day: "2026-10-01", provider: "v", cost_rows: 2, usd_known: "1.5", unpriced_count: 0 }])).toHaveLength(1);
    expect(coerceSpendRows([{ day: "2026-10-01", provider: "v", cost_rows: 2, usd_known: "garbage", unpriced_count: 0 }])[0]).toMatchObject({ usdKnown: 0, unpriced: 2 });
    const b = coerceBalanceRows([{ provider: "v", metric: "credits", remaining: null, unit: "credits", source: "manual", checked_at: "2026-10-01T00:00:00Z" }]);
    expect(b[0]).toMatchObject({ remaining: null, source: "manual" });
  });
});
