/**
 * The Usage page's pure half (lib/usage.ts) and the refusal figures that
 * carry the extra-credits switch (lib/credits.ts, lib/upsell.ts).
 *
 * What would break: a percentage that rounds a nearly-used allowance up to
 * "100%" (or a spent one down to 0%), an expired period counted as "spent", a
 * subscription with no credits drawn as 0%, a malformed read shown as zeros, a
 * Free plan "gap" that is not on the price list, an upgrade link nobody can
 * follow, and a refusal body that loses (or invents) the extra-credits fields.
 */
import { describe, expect, it } from "vitest";
import {
  coerceUsageSummary,
  formatPercent,
  freeGaps,
  higherPlanExists,
  offerUpgrade,
  planAllowance,
  relativeUntil,
  usageLimits,
  usedPercent,
  type UsageSummary,
} from "@/lib/usage";
import { coercePlanCatalog, planMatrix, type PlanEnv } from "@/lib/plans";
import { appendExtraOff, creditRunError, extraOffFields, isExtraOffRefusal, parseInsufficient } from "@/lib/credits";
import { refusalFrom, upsellView } from "@/lib/upsell";
import { dictionaries } from "@/lib/i18n";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exempt: false,
    extra_enabled: true,
    plan: { id: "creator", name: "Creator", monthly_credits: 2000, is_default: false },
    subscription: { status: "active", current_period_start: day(-9), current_period_end: day(21), cancel_at_period_end: false },
    plan_credits: { granted: 2000, spent: 1240, held: 180, left: 580, period_start: day(-9), period_end: day(21) },
    last_plan_period_end: day(21),
    extra_credits: { available: 500, soonest_expiry: day(300) },
    bonus_credits: { available: 0, soonest_expiry: null },
    spendable_now: 1080,
    run_slots: { exempt: false, limit: 2, active: 1 },
    entitlements: { concurrency: 2, queue_priority: 1, api_access: true },
    ...over,
  };
}
const summary = (over: Record<string, unknown> = {}): UsageSummary => {
  const s = coerceUsageSummary(raw(over));
  if (!s) throw new Error("fixture is not a summary");
  return s;
};

describe("usedPercent", () => {
  it("is 0 only when nothing was spent and 100 only when everything was", () => {
    expect(usedPercent(0, 2000)).toBe(0);
    expect(usedPercent(2000, 2000)).toBe(100);
    expect(usedPercent(2500, 2000)).toBe(100);
    expect(usedPercent(1, 2000)).toBe(1); // a spent credit is never "0%"
    expect(usedPercent(1999, 2000)).toBe(99); // a credit left is never "100%"
    expect(usedPercent(1240, 2000)).toBe(62);
  });
  it("has no percentage when the period granted nothing, or a figure is not a number", () => {
    expect(usedPercent(0, 0)).toBeNull();
    expect(usedPercent(5, 0)).toBeNull();
    expect(usedPercent(Number.NaN, 10)).toBeNull();
    expect(usedPercent(5, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("coerceUsageSummary", () => {
  it("reads a healthy summary", () => {
    const s = summary();
    expect(s.extraEnabled).toBe(true);
    expect(s.planCredits).toMatchObject({ granted: 2000, spent: 1240, held: 180, left: 580 });
    expect(s.extra).toEqual({ available: 500, soonestExpiry: day(300) });
    expect(s.spendableNow).toBe(1080);
    expect(s.subscription).toMatchObject({ status: "active", live: true });
    expect(s.entitlements).toEqual({ concurrency: 2, queue_priority: 1, api_access: true });
  });
  it("is null (unknown, not zeros) when it is not a summary or a figure is not a number", () => {
    expect(coerceUsageSummary(null)).toBeNull();
    expect(coerceUsageSummary("x")).toBeNull();
    expect(coerceUsageSummary([])).toBeNull();
    expect(coerceUsageSummary(raw({ extra_enabled: "yes" }))).toBeNull();
    expect(coerceUsageSummary(raw({ spendable_now: "lots" }))).toBeNull();
    expect(coerceUsageSummary(raw({ extra_credits: { available: null } }))).toBeNull();
    expect(coerceUsageSummary(raw({ extra_credits: null }))).toBeNull();
    expect(coerceUsageSummary(raw({ plan_credits: { granted: 2000, spent: "?", held: 0, left: 1 } }))).toBeNull();
  });
  it("keeps no plan period as null, not as zeros", () => {
    expect(summary({ plan_credits: null }).planCredits).toBeNull();
  });
  it("drops a limit that is not a plain value", () => {
    expect(summary({ entitlements: { concurrency: 2, odd: { nested: true } } }).entitlements).toEqual({ concurrency: 2 });
  });
});

describe("planAllowance", () => {
  it("a subscriber with credits in the period: used share, left, renewal", () => {
    const a = planAllowance(summary());
    expect(a).toMatchObject({ kind: "period", percent: 62, granted: 2000, spent: 1240, held: 180, left: 580, ends: false });
    expect(a.kind === "period" && a.periodEnd).toBe(day(21));
  });
  it("0% and 100% are real readings", () => {
    expect(planAllowance(summary({ plan_credits: { granted: 2000, spent: 0, held: 0, left: 2000, period_start: day(-1), period_end: day(29) } })))
      .toMatchObject({ kind: "period", percent: 0 });
    expect(planAllowance(summary({ plan_credits: { granted: 2000, spent: 2000, held: 0, left: 0, period_start: day(-1), period_end: day(29) } })))
      .toMatchObject({ kind: "period", percent: 100, left: 0 });
  });
  it("a plan that will not renew says so", () => {
    const s = summary({ subscription: { status: "active", current_period_end: day(5), cancel_at_period_end: true } });
    expect(planAllowance(s)).toMatchObject({ kind: "period", ends: true });
    expect(planAllowance(summary({ subscription: { status: "canceled", current_period_end: day(5), cancel_at_period_end: false } })))
      .toMatchObject({ kind: "period", ends: true });
  });
  it("a live plan whose period credits expired is 'ended', never 100% or 0%", () => {
    expect(planAllowance(summary({ plan_credits: null, last_plan_period_end: day(-2) }))).toEqual({ kind: "ended", endedAt: day(-2) });
  });
  it("a live plan that never got credits is 'none'", () => {
    expect(planAllowance(summary({ plan_credits: null, last_plan_period_end: null }))).toEqual({ kind: "none" });
  });
  it("with no live subscription it is Free, whatever lots once existed", () => {
    expect(planAllowance(summary({ subscription: null, plan_credits: null, last_plan_period_end: null }))).toEqual({ kind: "free" });
    expect(planAllowance(summary({ subscription: { status: "canceled", current_period_end: day(-3) }, plan_credits: null, last_plan_period_end: day(-3) })))
      .toEqual({ kind: "free" });
  });
  it("a period that granted nothing has no percentage and is not drawn as one", () => {
    expect(planAllowance(summary({ plan_credits: { granted: 0, spent: 0, held: 0, left: 0, period_start: day(-1), period_end: day(29) } })))
      .toEqual({ kind: "none" });
  });
});

describe("relativeUntil / formatPercent", () => {
  it("says how far away in the viewer's language, and nothing for a past or unreadable date", () => {
    expect(relativeUntil(day(21), NOW, "en")).toBe("in 21 days");
    expect(relativeUntil(day(1), NOW, "en")).toBe("tomorrow");
    expect(relativeUntil(new Date(NOW + 3 * 3_600_000).toISOString(), NOW, "en")).toBe("in 3 hours");
    expect(relativeUntil(new Date(NOW + 20 * 60_000).toISOString(), NOW, "en")).toBe("in 20 minutes");
    expect(relativeUntil(day(21), NOW, "ru")).toMatch(/21/);
    expect(relativeUntil(day(21), NOW, "uz")).toMatch(/21/);
    expect(relativeUntil(day(-1), NOW, "en")).toBeNull();
    expect(relativeUntil(null, NOW, "en")).toBeNull();
    expect(relativeUntil("not a date", NOW, "en")).toBeNull();
  });
  it("formats a whole percent", () => {
    expect(formatPercent(62, "en")).toBe("62%");
    expect(formatPercent(0, "en")).toBe("0%");
    expect(formatPercent(62, "ru")).toMatch(/^62\s?%$/);
  });
});

describe("usageLimits", () => {
  it("shows only limits the plan really carries", () => {
    expect(usageLimits(summary())).toEqual({ runs: { active: 1, limit: 2 }, priority: 1, api: true });
    expect(usageLimits(summary({ run_slots: null, entitlements: {} }))).toEqual({ runs: null, priority: null, api: null });
    expect(usageLimits(summary({ run_slots: { limit: null, active: 0 } })).runs).toBeNull();
    expect(usageLimits(summary({ entitlements: { queue_priority: 0, api_access: false } }))).toMatchObject({ priority: 0, api: false });
  });
});

// ── what Free lacks, and the upgrade link ────────────────────────────────────

const PLAN_ROWS = [
  { id: "free", name: "Free", sort_order: 0, monthly_credits: 0, is_default: true, is_public: true },
  { id: "creator", name: "Creator", sort_order: 1, monthly_credits: 2000, is_default: false, is_public: true },
  { id: "pro", name: "Pro", sort_order: 2, monthly_credits: 6000, is_default: false, is_public: true },
];
const KEY_ROWS = [
  { key: "concurrency", value_type: "int", default_value: 1, exempt_value: 1000, status: "enforced", sort_order: 10 },
  { key: "queue_priority", value_type: "int", default_value: 0, exempt_value: 10, status: "enforced", sort_order: 20 },
  { key: "api_access", value_type: "bool", default_value: false, exempt_value: true, status: "enforced", sort_order: 30 },
  { key: "mcp", value_type: "bool", default_value: false, exempt_value: true, status: "planned", sort_order: 56 },
];
const VALUE_ROWS = [
  { plan_id: "creator", key: "concurrency", value: 2 },
  { plan_id: "creator", key: "queue_priority", value: 1 },
  { plan_id: "creator", key: "api_access", value: true },
  { plan_id: "pro", key: "concurrency", value: 4 },
  { plan_id: "pro", key: "queue_priority", value: 2 },
  { plan_id: "pro", key: "api_access", value: true },
  { plan_id: "pro", key: "mcp", value: true },
];
const ENV: PlanEnv = {
  NEXT_PUBLIC_PADDLE_PLAN_CREATOR: "pri_01creatoraaaaaaaaaa",
  NEXT_PUBLIC_PADDLE_PLAN_PRO: "pri_01proaaaaaaaaaaaaaa",
  NEXT_PUBLIC_PLAN_DISPLAY_CREATOR: "19 USD",
  NEXT_PUBLIC_PLAN_DISPLAY_PRO: "49 USD",
};
const matrix = (env: PlanEnv = ENV) =>
  planMatrix(coercePlanCatalog(PLAN_ROWS, KEY_ROWS, VALUE_ROWS), env, { environment: "sandbox", clientToken: "test_abcdefghijk" });

describe("freeGaps", () => {
  it("lists what a paid plan gives that Free does not, from the price list only", () => {
    expect(freeGaps(matrix())).toEqual([
      { key: "credits" },
      { key: "concurrency", free: 1, best: 4 },
      { key: "queue_priority" },
      { key: "api_access" },
    ]);
  });
  it("never lists a planned limit (mcp) and is empty without a matrix", () => {
    expect(freeGaps(matrix()).some((g) => (g.key as string) === "mcp")).toBe(false);
    expect(freeGaps(null)).toEqual([]);
  });
});

describe("the upgrade link", () => {
  const free = () => summary({ subscription: null, plan_credits: null, last_plan_period_end: null, plan: { id: "free", name: "Free", monthly_credits: 0, is_default: true } });
  it("on Free there is a plan to point at", () => {
    expect(higherPlanExists(free(), matrix())).toBe(true);
    expect(offerUpgrade(free(), matrix())).toBe(true);
  });
  it("a subscriber is offered it only when nothing is spendable for a new run, and only if a higher plan exists", () => {
    expect(offerUpgrade(summary(), matrix())).toBe(false); // plenty left
    expect(offerUpgrade(summary({ spendable_now: 0 }), matrix())).toBe(true);
    const top = summary({ spendable_now: 0, plan: { id: "pro", name: "Pro", monthly_credits: 6000, is_default: false } });
    expect(offerUpgrade(top, matrix())).toBe(false); // nothing above Pro
  });
  it("is never offered without a price list or without a plan anyone can buy", () => {
    expect(offerUpgrade(free(), null)).toBe(false);
    expect(higherPlanExists(free(), matrix({}))).toBe(false); // no price, no display price
  });
});

// ── the refusal that carries the switch ──────────────────────────────────────

describe("refusal figures", () => {
  it("parseInsufficient reads the plain refusal exactly as before", () => {
    expect(parseInsufficient({ code: "NS402", details: "available=12.50 needed=40.00" })).toEqual({ available: 12.5, needed: 40 });
    expect(parseInsufficient({ code: "NS429", details: "available=1 needed=2" })).toBeNull();
  });
  it("and reads extra_off / extra when the workspace has extra credits off", () => {
    expect(parseInsufficient({ code: "NS402", details: "available=50.00 needed=51.0000000000000000 extra_off=1 extra=400.00" })).toEqual({
      available: 50,
      needed: 51,
      extraOff: true,
      extra: 400,
    });
  });
  it("extraOffFields adds nothing to an ordinary refusal", () => {
    expect(extraOffFields("available=1 needed=2")).toEqual({});
    expect(extraOffFields(undefined)).toEqual({});
    expect(extraOffFields("available=1 needed=2 extra_off=10")).toEqual({}); // not the flag
    expect(extraOffFields("available=1 needed=2 extra_off=1")).toEqual({ extra_off: true, extra: null });
    expect(extraOffFields("available=1 needed=2 extra_off=1 extra=7")).toEqual({ extra_off: true, extra: 7 });
  });
  it("isExtraOffRefusal needs the code and the flag", () => {
    expect(isExtraOffRefusal({ error: "insufficient_credits", extra_off: true })).toBe(true);
    expect(isExtraOffRefusal({ error: "insufficient_credits" })).toBe(false);
    expect(isExtraOffRefusal({ error: "run_limit", extra_off: true })).toBe(false);
    expect(isExtraOffRefusal(null)).toBe(false);
  });
  it("Run now says why, in every language, with the figures", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      const t = dictionaries[locale];
      const text = creditRunError({ error: "insufficient_credits", needed: 60, available: 20, extra_off: true, extra: 400 }, t, locale);
      expect(text, locale).toContain("60");
      expect(text, locale).toContain("20");
      expect(text, locale).toContain("400");
      expect(text, locale).not.toBe(creditRunError({ error: "insufficient_credits", needed: 60, available: 20 }, t, locale));
    }
    // Without the extra figure: the short sentence, never "undefined" or "NaN".
    const short = creditRunError({ error: "insufficient_credits", needed: 60, available: 20, extra_off: true }, dictionaries.en, "en");
    expect(short).toBe(dictionaries.en.usage.refusal.extraOffShort);
  });
  it("an ordinary refusal is untouched", () => {
    expect(creditRunError({ error: "insufficient_credits", needed: 60, available: 20 }, dictionaries.en, "en")).toBe(
      "Not enough credits: this run needs 60, 20 available.",
    );
  });
  it("a feature's own sentence gets the switch appended only when that is the reason", () => {
    const t = dictionaries.en;
    expect(appendExtraOff("Not enough credits.", { error: "insufficient_credits", extra_off: true }, t)).toBe(
      `Not enough credits. ${t.usage.refusal.extraOffShort}`,
    );
    expect(appendExtraOff("Not enough credits.", { error: "insufficient_credits" }, t)).toBe("Not enough credits.");
  });
  it("the Studio dialog answers a switched-off refusal with 'turn on extra credits' first", () => {
    const view = upsellView(
      refusalFrom("insufficient_credits", { available: 20, needed: 60, extra_off: true, extra: 400 }),
      undefined,
      null,
    );
    expect(view.reason).toBe("credits");
    expect(view.extraOff).toEqual({ extra: 400 });
    expect(view.buyCredits).toBe(true);
    expect(upsellView(refusalFrom("insufficient_credits", { available: 20, needed: 60 }), undefined, null).extraOff).toBeNull();
  });
});
