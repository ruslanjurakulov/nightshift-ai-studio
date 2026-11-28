import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { monthlyTotals, periodTotals, registerRows, registerTable, totalsNotes, totalsSummaryTable, totalsTable } from "@/lib/owner-analytics/tax";
import { resolvePeriod } from "@/lib/owner-analytics/period";
import type { CostEntry } from "@/lib/owner-analytics/costs";
import type { MoneyRow } from "@/lib/owner-analytics/money";
import { ownerAnalyticsEn } from "@/lib/i18n/owner-analytics/en";
import { ownerAnalyticsRu } from "@/lib/i18n/owner-analytics/ru";
import { ownerAnalyticsUz } from "@/lib/i18n/owner-analytics/uz";

vi.mock("server-only", () => ({}));

const NOW = new Date("2026-11-20T10:00:00Z");
const OCT = resolvePeriod("custom", NOW, { start: "2026-10-01", end: "2026-10-31" }).period;
const PART = resolvePeriod("custom", NOW, { start: "2026-10-05", end: "2026-10-31" }).period;
const Q3 = resolvePeriod("custom", NOW, { start: "2026-07-01", end: "2026-09-30" }).period;
const Q4 =resolvePeriod("custom", NOW, { start: "2026-10-01", end: "2026-12-31" }).period;
const row = (p: Partial<MoneyRow> & { at: string }): MoneyRow => ({
  event: "sale", provider: "dodo", paymentRef: `pay_${p.at}`, orgRef: "o", kind: "pack", item: "x", charge: null, currency: "USD",
  amountMinor: 10000, feeMinor: null, periodStart: null, periodEnd: null, subscriptionRef: null, internal: false, ...p,
});
const cost = (month: string, amountUsd: number): CostEntry => ({ id: 1, month, category: "tools", amountUsd, note: null, enteredAt: "" });

describe("owner tax: period totals", () => {
  const money = [row({ at: "2026-10-02T10:00:00Z" }), row({ at: "2026-10-03T10:00:00Z", event: "refund", amountMinor: 2500 })];

  it("income is sales minus refunds and expenses are the entered costs, before-tax is their difference", () => {
    const t = periodTotals(money, [cost("2026-10-01", 30)], OCT);
    expect([t.income, t.expenses, t.beforeTax, t.expensesGap]).toEqual([75, 30, 45, null]);
  });

  it("no cost entry for a month is unknown expenses, never 0 — and so an unknown difference", () => {
    const t = periodTotals(money, [], OCT);
    expect([t.income, t.expenses, t.beforeTax, t.expensesGap, t.missingMonths]).toEqual([75, null, null, "missing", ["2026-10"]]);
  });

  it("a period that cuts a month has no expense figure (costs are entered per whole month)", () => {
    const t = periodTotals(money, [cost("2026-10-01", 30)], PART);
    expect([t.expenses, t.beforeTax, t.expensesGap]).toEqual([null, null, "partial"]);
  });

  it("a failed costs read is unknown, not zero", () => {
    expect(periodTotals(money, null, OCT)).toMatchObject({ expenses: null, expensesGap: "unread", beforeTax: null });
  });

  it("a quarter sums its three months and names the month still missing", () => {
    const e = [cost("2026-07-01", 10), cost("2026-08-01", 20)];
    expect(periodTotals(money, e, Q3)).toMatchObject({ expenses: null, expensesGap: "missing", missingMonths: ["2026-09"] });
    expect(periodTotals(money, [...e, cost("2026-09-01", 5)], Q3).expenses).toBe(35);
  });

  it("the running quarter is partial (the picker clips it at today), so its expenses are unknown", () => {
    expect(periodTotals(money, [cost("2026-10-01", 1), cost("2026-11-01", 1), cost("2026-12-01", 1)], Q4).expensesGap).toBe("partial");
  });

  it("a payment with no amount makes income unknown; another currency makes it a floor and says so", () => {
    expect(periodTotals([row({ at: "2026-10-02T10:00:00Z", amountMinor: null })], [cost("2026-10-01", 1)], OCT)).toMatchObject({ income: null, beforeTax: null });
    const other = periodTotals([...money, row({ at: "2026-10-04T10:00:00Z", currency: "EUR" })], [cost("2026-10-01", 30)], OCT);
    expect(other.incomeOtherCurrency).toBe(1);
    expect(totalsNotes(ownerAnalyticsEn, other).join(" ")).toContain("other currencies");
  });

  it("income agrees with the register the page prints (paid-but-uncredited money counts in both)", () => {
    const m = [...money, row({ at: "2026-10-06T10:00:00Z", event: "uncredited", amountMinor: 500 })];
    const reg = registerRows(m, [], OCT).reduce((a, r) => a + (r.net ?? 0), 0);
    expect(periodTotals(m, [], OCT).income).toBe(reg);
  });

  it("the totals file states unknown cells as null and the file header carries the same figures", () => {
    const t = periodTotals(money, [], OCT);
    const table = totalsSummaryTable(ownerAnalyticsEn, t, OCT, false);
    expect(table.rows.map((r) => r[1])).toEqual([75, null, null]);
    expect(table.rows.map((r) => r[2])).toEqual(["measured", "unknown", "unknown"]);
    const reg = registerTable(ownerAnalyticsEn, registerRows(money, [], OCT), OCT, false, t);
    expect(reg.preamble?.join("\n")).toContain("Difference before tax: unknown");
    expect(reg.preamble?.join("\n")).toContain("Income: 75.00 USD (measured)");
    const monthly = totalsTable(ownerAnalyticsEn, monthlyTotals(registerRows(money, [], OCT)), "m", OCT, false, t);
    expect(monthly.preamble?.join("\n")).toContain("Income: 75.00 USD");
  });
});

describe("owner tax: the company, not an individual", () => {
  const dicts = { en: ownerAnalyticsEn, ru: ownerAnalyticsRu, uz: ownerAnalyticsUz };
  const taxKeys = Object.keys(ownerAnalyticsEn).filter((k) => k.startsWith("tax"));

  it.each(Object.entries(dicts))("%s: every tax/export string says MCHJ and none says individual", (_l, d) => {
    expect(d.taxCompanyLine).toContain("NIGHTSHIFT AI STUDIO MCHJ");
    expect(d.taxCompanyLine).toContain("313 498 038");
    expect(d.taxNotADeclaration).toContain("NIGHTSHIFT AI STUDIO MCHJ");
    const all = taxKeys.map((k) => (d as Record<string, unknown>)[k] as string).join("\n");
    expect(all).not.toMatch(/individual|jismoniy shaxs|физлиц|физическ|no registered company/i);
  });

  it("every file header carries the company line, and no tax rate or residency claim is made", () => {
    const rows = registerRows([], [], OCT);
    const pre = registerTable(ownerAnalyticsEn, rows, OCT, false).preamble?.join("\n") ?? "";
    expect(pre).toContain("NIGHTSHIFT AI STUDIO MCHJ");
    expect(ownerAnalyticsEn.taxPointAccountant).toMatch(/calculated by the accountant/);
    expect(ownerAnalyticsEn.taxPointAccountant).not.toMatch(/\d+\s?%/);
  });

  it("the tax page source no longer says the owner is an individual", () => {
    const src = readFileSync("app/(app)/[channel]/owner-analytics/tax/page.tsx", "utf8");
    expect(src).not.toMatch(/individual with no registered/i);
    expect(src).toContain("periodTotals");
  });
});
