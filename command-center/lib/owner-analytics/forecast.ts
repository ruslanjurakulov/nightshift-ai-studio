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

import { MIN_CHURN_BASE, churn as churnIn, mrrAt } from "./money";
import type { MoneyRow } from "./money";
import { tashkentDay } from "./period";
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
  /** What it rests on, counted in `unit`. */
  basis: number;
  unit: "days" | "people" | "subscriptions" | "months";
}

export interface Baseline {
  days: number;
  newUsersPerMonth: Measured<number>;
  conversion: Measured<number>;
  churn: Measured<number>;
  arpu: Measured<number>;
  /** Paid subscriptions billed today (a subscription taken back does not count). */
  payers: Measured<number>;
  /** Customer provider spend per paid subscription per month; null while a cost is unpriced, the read was cut, or 0184 is not applied. */
  costPerPayer: Measured<number>;
  /** The average of the owner's entered monthly costs over the last three months that have entries. */
  fixedMonthly: Measured<number>;
}

function costPerPayer(spend: SpendRow[] | null, from: number, to: number, payers: number, months: number, enough: boolean): Measured<number> {
  const none: Measured<number> = { value: null, basis: payers, unit: "subscriptions" };
  if (!spend || !enough || payers === 0 || months <= 0) return none;
  let usd = 0;
  for (const r of spend) {
    if (r.internal) continue;
    // A cost with no readable date may be inside the window: the per-payer cost is then not measurable.
    if (r.day === null) return none;
    const t = Date.parse(`${r.day}T00:00:00Z`);
    if (t < from || t >= to) continue;
    if (r.unpriced > 0) return none;
    usd += r.usdKnown;
  }
  return { value: usd / payers / months, basis: payers, unit: "subscriptions" };
}

function fixedMonthly(costs: CostEntry[] | null, now: Date): Measured<number> {
  if (!costs) return { value: null, basis: 0, unit: "months" };
  // The owner's months are Tashkent months: in the first hours of one, the month that just ended (Tashkent) is complete.
  const thisMonth = tashkentDay(now).slice(0, 7);
  const byMonth = new Map<string, number>();
  for (const c of costs) {
    const m = c.month.slice(0, 7);
    if (m >= thisMonth) continue; // the current month is not over: its entries are not a month's costs yet
    byMonth.set(m, (byMonth.get(m) ?? 0) + c.amountUsd);
  }
  const last = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 3);
  return { value: last.length ? last.reduce((a, [, v]) => a + v, 0) / last.length : null, basis: last.length, unit: "months" };
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
  // Churn, starting payers and revenue per payer come from the same functions the revenue tab uses (money.ts), so a refunded or
  // disputed period never keeps anyone subscribed and a yearly plan counts as a twelfth of its price a month. Revenue per payer
  // is today's MRR divided by today's subscriptions — the figure the measured line ends on — and unknown when that MRR is
  // incomplete (an amount missing, another currency, a refund of unknown size).
  const c = churnIn(money, { from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  const monthlyChurn = c.rate !== null && months > 0 ? 1 - Math.pow(1 - c.rate, 1 / months) : null;
  const today = mrrAt(money, new Date(to - 1).toISOString());
  const subs = today.subscribers;
  const arpu = today.usd !== null && !today.incomplete && subs > 0 ? today.usd / subs : null;

  return {
    days,
    newUsersPerMonth: { value: enough && months > 0 ? cohort.length / months : null, basis: days, unit: "days" },
    conversion: { value: enough && cohort.length >= MIN_CHURN_BASE ? paid / cohort.length : null, basis: cohort.length, unit: "people" },
    churn: { value: enough ? monthlyChurn : null, basis: c.base, unit: "subscriptions" },
    arpu: { value: arpu, basis: subs, unit: "subscriptions" },
    payers: { value: subs, basis: subs, unit: "subscriptions" },
    costPerPayer: costPerPayer(spend, from, to, subs, months, enough),
    fixedMonthly: fixedMonthly(costs, now),
  };
}
