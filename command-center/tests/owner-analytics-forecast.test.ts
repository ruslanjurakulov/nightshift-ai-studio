import { describe, expect, it } from "vitest";
import { baseline, project, type ScenarioInputs } from "@/lib/owner-analytics/forecast";
import type { PersonRow } from "@/lib/owner-analytics/people";

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
});
