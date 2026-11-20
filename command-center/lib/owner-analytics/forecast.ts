/**
 * The forecast panel: a scenario the owner moves with sliders, projected month by month. Pure.
 *
 * A projection is an assumption with arithmetic on it, and everything here keeps that visible:
 * - The baseline is MEASURED (the last 90 days of signups, conversion, churn and revenue per payer), and each baseline value
 *   says how many days or people it rests on. When there are too few, the value is null and the slider starts from nothing the
 *   page claims to know: the owner sets it, and it is labelled an assumption.
 * - The band is the same scenario run with the uncertain inputs moved against and in favour of the owner (growth and churn
 *   by ±BAND_SPREAD), not a statistical confidence interval, and the page calls it a range of assumptions.
 */

import { MIN_CHURN_BASE } from "./money";
import type { MoneyRow } from "./money";
import type { PersonRow } from "./people";
import type { CostEntry, SpendRow } from "./costs";

export interface ScenarioInputs {
  /** New signups in the first projected month. */
  newUsersPerMonth: number;
  /** Month-over-month growth of new signups, as a fraction (0.1 = +10%/month). */
  growth: number;
  /** Share of new signups who become paying in their first month. */
  conversion: number;
  /** Share of paying customers lost each month. */
  churn: number;
  /** Revenue per paying customer per month, USD. */
  arpu: number;
  /** Provider cost of the jobs a paying customer runs in a month, USD. */
  costPerPayer: number;
  /** Other monthly costs (infrastructure, tools), USD. */
  fixedMonthly: number;
  /** Cash on hand today, USD — entered by the owner; nothing in the platform knows it. */
  cash: number;
  /** Paying customers today (measured). */
  startingPayers: number;
}

export interface ProjectionPoint {
  month: number;
  users: number;
  payers: number;
  mrr: number;
  costs: number;
  profit: number;
  cash: number;
}

export interface Projection {
  mid: ProjectionPoint[];
  low: ProjectionPoint[];
  high: ProjectionPoint[];
  /** Months until cash runs out on the middle path; null when it does not within the horizon. */
  runwayMonths: number | null;
}

export const HORIZONS = [3, 6, 12, 24] as const;
export const BAND_SPREAD = 0.5;

function run(i: ScenarioInputs, months: number): ProjectionPoint[] {
  const out: ProjectionPoint[] = [];
  let users = 0;
  let payers = Math.max(0, i.startingPayers);
  let cash = i.cash;
  let signups = Math.max(0, i.newUsersPerMonth);
  for (let m = 1; m <= months; m++) {
    users += signups;
    payers = payers * (1 - clamp01(i.churn)) + signups * clamp01(i.conversion);
    const mrr = payers * Math.max(0, i.arpu);
    const costs = payers * Math.max(0, i.costPerPayer) + Math.max(0, i.fixedMonthly);
    const profit = mrr - costs;
    cash += profit;
    out.push({ month: m, users, payers, mrr, costs, profit, cash });
    signups *= 1 + i.growth;
  }
  return out;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function project(i: ScenarioInputs, months = 24): Projection {
  const mid = run(i, months);
  const low = run({ ...i, growth: i.growth - Math.abs(i.growth) * BAND_SPREAD, churn: i.churn * (1 + BAND_SPREAD) }, months);
  const high = run({ ...i, growth: i.growth + Math.abs(i.growth) * BAND_SPREAD, churn: i.churn * (1 - BAND_SPREAD) }, months);
  const broke = mid.find((p) => p.cash < 0);
  return { mid, low, high, runwayMonths: i.cash > 0 && broke ? broke.month : null };
}

export interface Measured<T> {
  value: T | null;
  /** What it rests on: days of history, or people. */
  basis: number;
}

export interface Baseline {
  days: number;
  newUsersPerMonth: Measured<number>;
  conversion: Measured<number>;
  churn: Measured<number>;
  arpu: Measured<number>;
  payers: Measured<number>;
  /** Customer provider spend per paying workspace per month; null while a cost is unpriced or 0183 is not applied. */
  costPerPayer: Measured<number>;
  /** The average of the owner's entered monthly costs over the last three months that have entries. */
  fixedMonthly: Measured<number>;
}

function costPerPayer(spend: SpendRow[] | null, from: number, to: number, payers: number, months: number, enough: boolean): Measured<number> {
  if (!spend || !enough || payers === 0 || months <= 0) return { value: null, basis: payers };
  let usd = 0;
  for (const r of spend) {
    const t = Date.parse(`${r.day}T00:00:00Z`);
    if (r.internal || t < from || t >= to) continue;
    if (r.unpriced > 0) return { value: null, basis: payers };
    usd += r.usdKnown;
  }
  return { value: usd / payers / months, basis: payers };
}

function fixedMonthly(costs: CostEntry[] | null, now: Date): Measured<number> {
  if (!costs) return { value: null, basis: 0 };
  const thisMonth = now.toISOString().slice(0, 7);
  const byMonth = new Map<string, number>();
  for (const c of costs) {
    const m = c.month.slice(0, 7);
    if (m >= thisMonth) continue; // the current month is not over: its entries are not a month's costs yet
    byMonth.set(m, (byMonth.get(m) ?? 0) + c.amountUsd);
  }
  const last = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 3);
  return { value: last.length ? last.reduce((a, [, v]) => a + v, 0) / last.length : null, basis: last.length };
}

const DAY = 86_400_000;
/** Below this much history the measured rates are not offered as a baseline. */
export const MIN_BASELINE_DAYS = 30;

/**
 * The baseline from the last 90 days before `now` (or less, when the platform is younger). Each value is null when the data
 * under it is too thin, with `basis` saying how thin.
 */
export function baseline(
  people: PersonRow[],
  money: MoneyRow[],
  now: Date,
  spend: SpendRow[] | null = null,
  costs: CostEntry[] | null = null,
): Baseline {
  const to = now.getTime();
  const firstSignup = people.filter((u) => !u.internal).reduce((m, u) => Math.min(m, Date.parse(u.signedUpAt)), to);
  const days = Math.max(0, Math.min(90, Math.floor((to - firstSignup) / DAY)));
  const from = to - days * DAY;
  const inWin = (iso: string | null) => iso !== null && Date.parse(iso) >= from && Date.parse(iso) < to;
  const cohort = people.filter((u) => !u.internal && u.confirmed && inWin(u.signedUpAt));
  const months = days / (365.25 / 12);
  const enough = days >= MIN_BASELINE_DAYS;

  const paid = cohort.filter((u) => u.firstPaymentAt !== null).length;
  // Subscribers billed at the window's start, and how many of those were still billed at its end.
  const covering = (at: number) => {
    const s = new Set<string>();
    for (const r of money) {
      if (r.event !== "sale" || r.kind !== "plan" || r.internal || !r.periodStart || !r.periodEnd) continue;
      if (Date.parse(r.periodStart) <= at && at < Date.parse(r.periodEnd)) s.add(r.subscriptionRef ?? r.paymentRef);
    }
    return s;
  };
  const start = covering(from);
  const end = covering(to - 1);
  const kept = [...start].filter((s) => end.has(s)).length;
  const retained = start.size > 0 ? kept / start.size : null;
  const monthlyChurn = retained !== null && months > 0 ? 1 - Math.pow(retained, 1 / months) : null;

  let usd = 0;
  const payers = new Set<string>();
  for (const r of money) {
    if (r.internal || r.currency !== "USD" || r.amountMinor === null || !inWin(r.at)) continue;
    if (r.event === "sale") {
      usd += r.amountMinor / 100;
      if (r.orgRef) payers.add(r.orgRef);
    } else if (r.event === "refund" || r.event === "dispute") usd -= r.amountMinor / 100;
  }

  return {
    days,
    newUsersPerMonth: { value: enough && months > 0 ? cohort.length / months : null, basis: days },
    conversion: { value: enough && cohort.length >= MIN_CHURN_BASE ? paid / cohort.length : null, basis: cohort.length },
    churn: { value: enough && start.size >= MIN_CHURN_BASE ? monthlyChurn : null, basis: start.size },
    arpu: { value: enough && payers.size > 0 && months > 0 ? usd / payers.size / months : null, basis: payers.size },
    payers: { value: end.size, basis: end.size },
    costPerPayer: costPerPayer(spend, from, to, payers.size, months, enough),
    fixedMonthly: fixedMonthly(costs, now),
  };
}
