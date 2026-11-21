import { describe, expect, it } from "vitest";
import {
  coerceMarginRows,
  formatUsd,
  marginCell,
  marginTotals,
  parsePeriod,
  periodRange,
  type MarginRow,
} from "../lib/margin";

/**
 * The margin report (migration 0063) reaches the screen through these rules.
 * What would break without them: a null cost read as $0 so a loss shows as a
 * profit, a total that quietly leaves out the row it could not price, and a
 * "?days=" that asks the database for an unbounded range.
 */

const raw = (over: Record<string, unknown> = {}) => ({
  day: "2026-05-10",
  model: "m-paid",
  capability: "t2i",
  jobs_completed: 1,
  jobs_released: 0,
  jobs_internal: 0,
  credits_sold: 10,
  credits_released: 0,
  credits_paid: 10,
  credits_free: 0,
  credits_unvalued: 0,
  revenue_usd: 0.12,
  provider_usd: 0.04,
  provider_usd_released: 0,
  jobs_uncosted: 0,
  jobs_released_uncosted: 0,
  margin_usd: 0.08,
  margin_pct: 66.67,
  flags: [],
  ...over,
});
const row = (over: Record<string, unknown> = {}): MarginRow => coerceMarginRows([raw(over)])[0];

describe("coerceMarginRows", () => {
  it("keeps a null as null, never 0", () => {
    const r = row({ revenue_usd: null, provider_usd: null, provider_usd_released: null, margin_usd: null, margin_pct: null });
    expect(r.revenueUsd).toBeNull();
    expect(r.providerUsd).toBeNull();
    expect(r.providerUsdReleased).toBeNull();
    expect(r.marginUsd).toBeNull();
    expect(r.marginPct).toBeNull();
  });

  it("keeps a real zero as zero (free credits earned nothing, and that is known)", () => {
    const r = row({ revenue_usd: 0, margin_pct: null, margin_usd: -0.01 });
    expect(r.revenueUsd).toBe(0);
    expect(r.marginPct).toBeNull();
  });

  it("reads numeric strings, and refuses garbage rather than guessing", () => {
    expect(row({ revenue_usd: "0.120000" }).revenueUsd).toBe(0.12);
    expect(row({ revenue_usd: "abc" }).revenueUsd).toBeNull();
    expect(row({ revenue_usd: "" }).revenueUsd).toBeNull();
  });

  it("drops a row that is not a row, and unknown flags", () => {
    const rows = coerceMarginRows([raw(), null, "x", { model: "m" }, raw({ day: "May 10" }), raw({ flags: ["released_jobs", "nonsense"] })]);
    expect(rows).toHaveLength(2);
    expect(rows[1].flags).toEqual(["released_jobs"]);
    expect(coerceMarginRows(null)).toEqual([]);
    expect(coerceMarginRows({})).toEqual([]);
  });
});

describe("marginCell", () => {
  it("shows a percentage only where the database gave one", () => {
    expect(marginCell(row())).toEqual({ kind: "value", pct: 66.67 });
  });

  it("an unknown input is unpriced, not a number", () => {
    expect(marginCell(row({ provider_usd: null, margin_usd: null, margin_pct: null }))).toEqual({ kind: "unpriced" });
    expect(marginCell(row({ revenue_usd: null, margin_usd: null, margin_pct: null }))).toEqual({ kind: "unpriced" });
  });

  it("known revenue of zero is 'no revenue', a different thing from unpriced", () => {
    expect(marginCell(row({ revenue_usd: 0, margin_pct: null }))).toEqual({ kind: "no_revenue" });
  });
});

describe("marginTotals", () => {
  it("adds money only when every row knows its own", () => {
    const t = marginTotals([row(), row({ day: "2026-05-09" })]);
    expect(t.revenueUsd).toBeCloseTo(0.24);
    expect(t.providerUsd).toBeCloseTo(0.08);
    expect(t.marginUsd).toBeCloseTo(0.16);
    expect(t.marginPct).toBeCloseTo(66.67, 1);
    expect(t.unpricedRows).toBe(0);
  });

  it("an unpriced cost makes the total unpriced, not a smaller number", () => {
    const t = marginTotals([row(), row({ model: "m-unpriced", provider_usd: null, margin_usd: null, margin_pct: null })]);
    expect(t.providerUsd).toBeNull();
    expect(t.marginUsd).toBeNull();
    expect(t.marginPct).toBeNull();
    expect(t.revenueUsd).toBeCloseTo(0.24); // revenue was known on both rows
    expect(t.unpricedRows).toBe(1);
  });

  it("an unvalued revenue makes revenue and margin unpriced", () => {
    const t = marginTotals([row(), row({ revenue_usd: null, margin_usd: null, margin_pct: null })]);
    expect(t.revenueUsd).toBeNull();
    expect(t.marginUsd).toBeNull();
  });

  it("credits and job counts still add up", () => {
    const t = marginTotals([row({ jobs_released: 2, credits_released: 12 }), row({ credits_sold: 5, jobs_released: 1, credits_released: 3 })]);
    expect(t.creditsSold).toBe(15);
    expect(t.jobsReleased).toBe(3);
    expect(t.creditsReleased).toBe(15);
  });

  it("a loss is negative, not hidden", () => {
    const t = marginTotals([row({ revenue_usd: 0.01, provider_usd: 0.05 })]);
    expect(t.marginUsd).toBeCloseTo(-0.04);
    expect(t.marginPct).toBeCloseTo(-400, 0);
  });
});

describe("period", () => {
  it("accepts only the offered periods", () => {
    expect(parsePeriod("7")).toBe(7);
    expect(parsePeriod("90")).toBe(90);
    expect(parsePeriod(["7", "90"])).toBe(7);
    for (const bad of [undefined, "", "0", "-1", "30000", "abc", "7; drop"]) expect(parsePeriod(bad)).toBe(30);
  });

  it("ends today in UTC and spans exactly that many days, inclusive", () => {
    const now = new Date("2026-05-10T23:30:00Z");
    expect(periodRange(7, now)).toEqual({ from: "2026-05-04", to: "2026-05-10" });
    expect(periodRange(30, new Date("2026-05-10T00:00:01Z"))).toEqual({ from: "2026-04-11", to: "2026-05-10" });
  });

  it("stays inside what the database accepts (366 days)", () => {
    const { from, to } = periodRange(90, new Date("2026-05-10T12:00:00Z"));
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBeLessThanOrEqual(365);
  });
});

describe("formatUsd", () => {
  it("shows small per-job costs in four places and larger sums in cents", () => {
    expect(formatUsd(0.04)).toBe("$0.0400");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(-0.01)).toBe("-$0.0100");
  });
});
