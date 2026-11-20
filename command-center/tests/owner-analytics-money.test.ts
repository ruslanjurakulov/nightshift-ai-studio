import { describe, expect, it } from "vitest";
import { churn, coerceMoneyRows, ltvEstimate, moneySeries, mrrAt, summarize, type MoneyRow } from "@/lib/owner-analytics/money";
import { engagement, funnel, jobsByModel, planCohorts, reactivations, signupCohorts, type PersonRow } from "@/lib/owner-analytics/people";
import { resolvePeriod } from "@/lib/owner-analytics/period";
import { revenueEventsTable, overviewTable, revenueKpis } from "@/lib/owner-analytics/kpis";
import { ownerAnalyticsEn as d } from "@/lib/i18n/owner-analytics/en";

const NOW = new Date("2026-11-20T10:00:00Z");
const OCT = resolvePeriod("custom", NOW, { start: "2026-10-01", end: "2026-10-31" }).period;

function sale(p: Partial<MoneyRow> & { at: string }): MoneyRow {
  return {
    event: "sale", provider: "dodo", paymentRef: `pay_${Math.random().toString(36).slice(2)}`, orgRef: "org-1", kind: "pack",
    item: "starter", charge: null, currency: "USD", amountMinor: 1000, feeMinor: null, periodStart: null, periodEnd: null,
    subscriptionRef: null, internal: false, ...p,
  };
}

describe("owner analytics revenue", () => {
  it("drops a malformed row instead of guessing, and keeps a missing amount null", () => {
    const rows = coerceMoneyRows([
      { event: "sale", at: "2026-10-02T10:00:00Z", payment_ref: "pay_1", kind: "pack", amount_minor: null, currency: "usd" },
      { event: "sale", at: "not a date", payment_ref: "pay_2" },
      { event: "gift", at: "2026-10-02T10:00:00Z", payment_ref: "pay_3" },
      { event: "refund", at: "2026-10-02T10:00:00Z" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountMinor: null, currency: "USD", feeMinor: null });
  });

  it("never adds a euro as a dollar, and marks a total with an unknown amount incomplete", () => {
    const s = summarize(
      [
        sale({ at: "2026-10-02T10:00:00Z" }),
        sale({ at: "2026-10-03T10:00:00Z", currency: "EUR", amountMinor: 900 }),
        sale({ at: "2026-10-04T10:00:00Z", amountMinor: null }),
        sale({ at: "2026-10-05T10:00:00Z", event: "refund", amountMinor: 300 }),
        sale({ at: "2026-10-05T10:00:00Z", internal: true, amountMinor: 99999 }),
      ],
      OCT,
    );
    expect(s.gross).toEqual({ usd: 10, unknownCount: 1 });
    expect(s.netBeforeFees).toEqual({ usd: 7, unknownCount: 1 });
    expect(s.otherCurrency).toEqual([{ currency: "EUR", count: 1, minor: 900 }]);
    expect(s.internalExcluded).toBe(1);
    expect(s.sales).toBe(3);
  });

  it("counts plan sales as initial or renewal, and says when the record does not say", () => {
    const s = summarize(
      [
        sale({ at: "2026-10-02T10:00:00Z", kind: "plan", item: "pro", charge: "initial" }),
        sale({ at: "2026-10-03T10:00:00Z", kind: "plan", item: "pro", charge: "renewal" }),
        sale({ at: "2026-10-04T10:00:00Z", kind: "plan", item: "pro", charge: null }),
      ],
      OCT,
    );
    expect(s.byItem[0]).toMatchObject({ item: "pro", count: 3, initial: 1, renewal: 1, chargeUnknown: 1 });
  });

  it("reads MRR from the periods that cover the instant, normalised to a month; no subscriptions is null, not $0", () => {
    expect(mrrAt([sale({ at: "2026-10-02T10:00:00Z" })], "2026-10-15T00:00:00Z").usd).toBeNull();
    const yearly = sale({ at: "2026-01-01T00:00:00Z", kind: "plan", amountMinor: 120000, periodStart: "2026-01-01T00:00:00Z", periodEnd: "2027-01-01T00:00:00Z", subscriptionRef: "1" });
    const m = mrrAt([yearly], "2026-10-15T00:00:00Z");
    expect(m.subscribers).toBe(1);
    expect(m.usd).toBeCloseTo(100, 0);
  });

  it("withholds churn from too few subscribers, and LTV when no churn was seen", () => {
    const plan = (ref: string, end: string) =>
      sale({ at: "2026-09-20T00:00:00Z", kind: "plan", periodStart: "2026-09-20T00:00:00Z", periodEnd: end, subscriptionRef: ref });
    const few = [plan("1", "2026-12-01T00:00:00Z"), plan("2", "2026-10-10T00:00:00Z")];
    expect(churn(few, OCT)).toEqual({ base: 2, churned: 1, rate: null });
    const many = ["1", "2", "3", "4", "5"].map((r, i) => plan(r, i === 0 ? "2026-10-10T00:00:00Z" : "2026-12-01T00:00:00Z"));
    expect(churn(many, OCT).rate).toBeCloseTo(0.2);
    expect(ltvEstimate(20, 0)).toBeNull();
    expect(ltvEstimate(20, 0.2)).toBeCloseTo(100);
  });

  it("puts a bucket with an unknown amount at null, and an empty day at 0", () => {
    const pts = moneySeries([sale({ at: "2026-10-02T10:00:00Z", amountMinor: null })], OCT);
    expect(pts.find((p) => p.x === "2026-10-02")?.gross).toBeNull();
    expect(pts.find((p) => p.x === "2026-10-03")?.gross).toBe(0);
    expect(pts).toHaveLength(31);
  });

  it("drops the payment id column — screen and file — in presentation mode", () => {
    const rows = [sale({ at: "2026-10-02T10:00:00Z", paymentRef: "pay_secret123" })];
    const shown = revenueEventsTable(d, rows, OCT, false);
    const presented = revenueEventsTable(d, rows, OCT, true);
    expect(JSON.stringify(shown)).toContain("pay_secret123");
    expect(JSON.stringify(presented)).not.toContain("pay_secret123");
    expect(presented.columns).not.toContain(d.payment);
  });

  it("states fees as unknown and omits the previous column when not comparing", () => {
    const k = revenueKpis([sale({ at: "2026-10-02T10:00:00Z" })], null, OCT);
    const t = overviewTable(d, k, null, OCT, false);
    expect(t.columns).toHaveLength(2);
    expect(t.preamble?.join(" ")).toContain(d.feesUnknown);
    expect(k.arpu).toBeNull();
  });
});

function person(p: Partial<PersonRow> & { userRef: string; signedUpAt: string }): PersonRow {
  return {
    lastSignInAt: null, locale: null, acquisition: null, internal: false, firstProjectAt: null, firstGenerationAt: null,
    firstExportAt: null, firstPaymentAt: null, firstPlan: null, ...p,
  };
}

describe("owner analytics people", () => {
  it("withholds funnel rates from a tiny cohort but keeps the counts", () => {
    const f = funnel([person({ userRef: "a", signedUpAt: "2026-10-02T00:00:00Z", firstGenerationAt: "2026-10-03T00:00:00Z" })], OCT);
    expect(f.map((s) => s.count)).toEqual([1, 0, 1, 0, 0]);
    expect(f.every((s) => s.ofSignups === null)).toBe(true);
  });

  it("leaves the platform roster out of the funnel", () => {
    const f = funnel([person({ userRef: "op", signedUpAt: "2026-10-02T00:00:00Z", internal: true })], OCT);
    expect(f[0].count).toBe(0);
  });

  it("computes DAU, WAU and MAU from people who did something, and says how many days it rests on", () => {
    const act = [
      { day: "2026-10-31", userRef: "a" },
      { day: "2026-10-31", userRef: "b" },
      { day: "2026-10-25", userRef: "c" },
      { day: "2026-10-05", userRef: "d" },
    ];
    const e = engagement(act, OCT);
    expect(e.wau).toBe(3);
    expect(e.mau).toBe(4);
    expect(e.dau).toBeCloseTo(4 / 31);
    expect(e.stickiness).toBeNull();
    expect(e.daysOfData).toBe(27);
  });

  it("leaves a cohort month that has not happened blank, not 0%", () => {
    const c = signupCohorts([person({ userRef: "a", signedUpAt: "2026-10-02T00:00:00Z" })], [{ day: "2026-11-03", userRef: "a" }], "2026-11");
    expect(c[0].cells).toEqual([0, 1]);
  });

  it("reads month-2 renewals per first plan, and a return after a gap as a reactivation", () => {
    const rows = [
      sale({ at: "2026-08-02T00:00:00Z", kind: "plan", item: "pro", orgRef: "o1" }),
      sale({ at: "2026-09-02T00:00:00Z", kind: "plan", item: "pro", orgRef: "o1" }),
      sale({ at: "2026-08-05T00:00:00Z", kind: "plan", item: "pro", orgRef: "o2" }),
      sale({ at: "2026-10-05T00:00:00Z", kind: "plan", item: "pro", orgRef: "o2" }),
    ];
    const pc = planCohorts(rows, "2026-10");
    expect(pc[0]).toMatchObject({ plan: "pro", month: "2026-08", size: 2 });
    expect(pc[0].cells).toEqual([1, 0.5, 0.5]);
    expect(reactivations(rows, OCT)).toBe(1);
  });

  it("measures time to result on completed jobs only", () => {
    const s = jobsByModel([
      { day: "2026-10-02", kind: "generate", capability: "t2i", model: "m", status: "completed", payer: "credits", internal: false, jobs: 2, creditsCharged: 8, secondsTotal: 60, secondsCounted: 2 },
      { day: "2026-10-02", kind: "generate", capability: "t2i", model: "m", status: "failed", payer: "credits", internal: false, jobs: 1, creditsCharged: 0, secondsTotal: 600, secondsCounted: 1 },
      { day: "2026-10-02", kind: "generate", capability: "t2i", model: "m", status: "completed", payer: "credits", internal: true, jobs: 9, creditsCharged: 9, secondsTotal: 9, secondsCounted: 9 },
    ]);
    expect(s[0]).toMatchObject({ jobs: 3, succeeded: 2, failed: 1, avgSeconds: 30, successRate: null, credits: 8 });
  });
});
