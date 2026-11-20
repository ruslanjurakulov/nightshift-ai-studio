import { describe, expect, it } from "vitest";
import { baseline, project, type ScenarioInputs } from "@/lib/owner-analytics/forecast";
import type { PersonRow } from "@/lib/owner-analytics/people";
import type { MoneyRow } from "@/lib/owner-analytics/money";

const base: ScenarioInputs = { newUsersPerMonth: 100, growth: 0.1, conversion: 0.05, churn: 0.1, arpu: 20, costPerPayer: 4, fixedMonthly: 500, cash: 1000, startingPayers: 10 };

describe("owner analytics forecast", () => {
  it("projects month by month from the starting payers", () => {
    const p = project(base, 3);
    expect(p.mid[0].payers).toBeCloseTo(10 * 0.9 + 100 * 0.05);
    expect(p.mid[0].mrr).toBeCloseTo(p.mid[0].payers * 20);
    expect(p.mid[1].users).toBeCloseTo(100 + 110);
  });

  it("brackets the middle path: worse growth and churn below, better above", () => {
    const p = project(base, 12);
    expect(p.low[11].mrr).toBeLessThan(p.mid[11].mrr);
    expect(p.high[11].mrr).toBeGreaterThan(p.mid[11].mrr);
  });

  it("states runway only when there is cash and it runs out", () => {
    expect(project({ ...base, fixedMonthly: 5000 }).runwayMonths).toBe(1);
    expect(project({ ...base, cash: 0 }).runwayMonths).toBeNull();
    expect(project({ ...base, fixedMonthly: 0 }).runwayMonths).toBeNull();
  });

  it("offers no measured baseline from too little history", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const u: PersonRow = { userRef: "a", signedUpAt: "2026-11-10T00:00:00Z", confirmed: true, lastSignInAt: null, locale: null, acquisition: null, internal: false, firstProjectAt: null, firstGenerationAt: null, firstExportAt: null, firstPaymentAt: null, firstPlan: null };
    const b = baseline([u], [], now);
    expect(b.days).toBe(10);
    expect(b.newUsersPerMonth.value).toBeNull();
    expect(b.churn.value).toBeNull();
    expect(b.costPerPayer.value).toBeNull();
    expect(b.fixedMonthly.value).toBeNull();
  });
  describe("the measured baseline uses the revenue tab's own definitions", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const person = (i: number): PersonRow => ({ userRef: `u${i}`, signedUpAt: "2026-06-01T00:00:00Z", confirmed: true, lastSignInAt: null, locale: null, acquisition: null, internal: false, firstProjectAt: null, firstGenerationAt: null, firstExportAt: null, firstPaymentAt: null, firstPlan: null });
    const plan = (ref: string, start: string, end: string, amountMinor: number | null): MoneyRow => ({
      event: "sale", provider: "dodo", paymentRef: ref, orgRef: `o-${ref}`, kind: "plan", item: "x", charge: null, currency: "USD",
      amountMinor, feeMinor: null, periodStart: start, periodEnd: end, subscriptionRef: `s-${ref}`, internal: false, at: start,
    });
    const people = [person(1)];

    it("counts a yearly plan as a twelfth of its price a month, not its whole price over the window", () => {
      const b = baseline(people, [plan("y", "2026-10-01T00:00:00Z", "2027-10-01T00:00:00Z", 12000)], now);
      expect(b.arpu.value).toBeCloseTo(10);
      expect(b.payers.value).toBe(1);
    });

    it("does not divide a payer who joined this month by the whole window", () => {
      const b = baseline(people, [plan("m", "2026-11-10T00:00:00Z", "2026-12-10T00:00:00Z", 1000)], now);
      expect(b.arpu.value).toBeCloseTo(10);
    });

    it("treats disputed subscriptions as gone: they are churn, not payers", () => {
      const money: MoneyRow[] = [];
      for (let i = 0; i < 6; i++) {
        const a = plan(`a${i}`, "2026-08-15T00:00:00Z", "2026-09-15T00:00:00Z", 1000);
        const b = { ...plan(`b${i}`, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", 1000), subscriptionRef: `s-a${i}` };
        money.push(a, b, { ...b, event: "dispute", at: "2026-11-05T00:00:00Z" });
      }
      const base = baseline(people, money, now);
      expect(base.payers.value).toBe(0);
      expect(base.churn.basis).toBe(6);
      expect(base.churn.value).toBeCloseTo(1);
    });

    it("leaves revenue per payer unknown when today's MRR is incomplete, instead of skipping the payment", () => {
      const b = baseline(people, [plan("k", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", 1000), plan("n", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", null)], now);
      expect(b.arpu.value).toBeNull();
      expect(b.payers.value).toBe(2);
    });

    it("says what each basis counts", () => {
      const b = baseline(people, [], now);
      expect([b.newUsersPerMonth.unit, b.conversion.unit, b.churn.unit, b.fixedMonthly.unit]).toEqual(["days", "people", "subscriptions", "months"]);
    });
  });
});
