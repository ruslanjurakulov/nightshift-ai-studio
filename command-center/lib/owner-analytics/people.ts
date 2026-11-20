/**
 * People, activity and jobs for the owner analytics hub (migration 0182's owner_analytics_people / _activity / _jobs). Pure.
 *
 * What "active" means here is what the database can prove: a person asked for a generation, made a project, asked for an export
 * or signed in on that Tashkent day. A page view is not recorded against a person, so DAU is "people who did something", and the
 * page says so. Rates computed from too few people are withheld (null), not shown as a confident percentage.
 */

import { known, type MoneyRow } from "./money";
import { tashkentDay, type Period } from "./period";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const instant = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface PersonRow {
  userRef: string;
  signedUpAt: string;
  lastSignInAt: string | null;
  locale: string | null;
  acquisition: "referral" | "invite" | null;
  internal: boolean;
  firstProjectAt: string | null;
  firstGenerationAt: string | null;
  firstExportAt: string | null;
  firstPaymentAt: string | null;
  firstPlan: string | null;
}
export interface ActivityRow {
  day: string;
  userRef: string;
}
export interface JobRow {
  day: string;
  kind: string;
  capability: string;
  model: string;
  status: string;
  payer: string;
  internal: boolean;
  jobs: number;
  creditsCharged: number;
  secondsTotal: number;
  secondsCounted: number;
}

export function coercePeopleRows(data: unknown): PersonRow[] {
  if (!Array.isArray(data)) return [];
  const out: PersonRow[] = [];
  for (const r of data) {
    if (!isObj(r)) continue;
    const userRef = str(r.user_ref);
    const signedUpAt = instant(r.signed_up_at);
    if (!userRef || !signedUpAt) continue;
    out.push({
      userRef,
      signedUpAt,
      lastSignInAt: instant(r.last_sign_in_at),
      locale: str(r.locale),
      acquisition: r.acquisition === "referral" || r.acquisition === "invite" ? r.acquisition : null,
      internal: r.internal === true,
      firstProjectAt: instant(r.first_project_at),
      firstGenerationAt: instant(r.first_generation_at),
      firstExportAt: instant(r.first_export_at),
      firstPaymentAt: instant(r.first_payment_at),
      firstPlan: str(r.first_plan),
    });
  }
  return out;
}

export function coerceActivityRows(data: unknown): ActivityRow[] {
  if (!Array.isArray(data)) return [];
  const out: ActivityRow[] = [];
  for (const r of data) {
    if (!isObj(r)) continue;
    const day = typeof r.day === "string" ? r.day.slice(0, 10) : "";
    const userRef = str(r.user_ref);
    if (DAY_RE.test(day) && userRef) out.push({ day, userRef });
  }
  return out;
}

export function coerceJobRows(data: unknown): JobRow[] {
  if (!Array.isArray(data)) return [];
  const out: JobRow[] = [];
  for (const r of data) {
    if (!isObj(r)) continue;
    const day = typeof r.day === "string" ? r.day.slice(0, 10) : "";
    const jobs = known(r.jobs);
    if (!DAY_RE.test(day) || jobs === null) continue;
    out.push({
      day,
      kind: str(r.kind) ?? "unknown",
      capability: str(r.capability) ?? "unknown",
      model: str(r.model) ?? "unknown",
      status: str(r.status) ?? "unknown",
      payer: str(r.payer) ?? "unknown",
      internal: r.internal === true,
      jobs,
      creditsCharged: known(r.credits_charged) ?? 0,
      secondsTotal: known(r.seconds_total) ?? 0,
      secondsCounted: known(r.seconds_counted) ?? 0,
    });
  }
  return out;
}

/** The smallest group a rate is drawn from. Below it the page says "not enough data" with the count. */
export const MIN_RATE_BASE = 5;
export function rate(part: number, whole: number): number | null {
  return whole >= MIN_RATE_BASE ? part / whole : null;
}

const within = (iso: string | null, p: Pick<Period, "from" | "to">) => iso !== null && iso >= p.from && iso < p.to;

export interface FunnelStep {
  key: "signup" | "project" | "generation" | "export" | "payment";
  count: number;
  /** Share of the signups; null when the cohort is too small to say. */
  ofSignups: number | null;
}

/** The activation funnel of the people who signed up in the period: how many reached each milestone, at any time since. */
export function funnel(people: PersonRow[], p: Pick<Period, "from" | "to">): FunnelStep[] {
  const cohort = people.filter((u) => !u.internal && within(u.signedUpAt, p));
  const n = cohort.length;
  const count = (f: (u: PersonRow) => string | null) => cohort.filter((u) => f(u) !== null).length;
  const steps: Array<[FunnelStep["key"], number]> = [
    ["signup", n],
    ["project", count((u) => u.firstProjectAt)],
    ["generation", count((u) => u.firstGenerationAt)],
    ["export", count((u) => u.firstExportAt)],
    ["payment", count((u) => u.firstPaymentAt)],
  ];
  return steps.map(([key, c]) => ({ key, count: c, ofSignups: rate(c, n) }));
}

/** Signups per Tashkent day, for the people outside the platform roster. */
export function signupsByDay(people: PersonRow[], p: Pick<Period, "from" | "to">): Map<string, number> {
  const m = new Map<string, number>();
  for (const u of people) {
    if (u.internal || !within(u.signedUpAt, p)) continue;
    const d = tashkentDay(new Date(u.signedUpAt));
    m.set(d, (m.get(d) ?? 0) + 1);
  }
  return m;
}

/** Counts by a field, with the unrecorded ones under null (the page names them "not recorded", never folds them away). */
export function countBy(people: PersonRow[], p: Pick<Period, "from" | "to">, f: (u: PersonRow) => string | null) {
  const m = new Map<string | null, number>();
  for (const u of people) {
    if (u.internal || !within(u.signedUpAt, p)) continue;
    const k = f(u);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export interface Engagement {
  /** Average over the period's days of the people active each day. */
  dau: number | null;
  /** People active in the 7 and 30 days ending on the period's last day. */
  wau: number;
  mau: number;
  /** DAU / MAU; null when MAU is below the rate floor. */
  stickiness: number | null;
  /** How many days of activity the figures rest on (what was read, not what was asked for). */
  daysOfData: number;
}

/** DAU, WAU, MAU and stickiness. `activity` must cover the 29 days before the period too, for MAU at its end. */
export function engagement(activity: ActivityRow[], p: Pick<Period, "startDay" | "endDay" | "days">): Engagement {
  const byDay = new Map<string, Set<string>>();
  for (const a of activity) {
    let s = byDay.get(a.day);
    if (!s) byDay.set(a.day, (s = new Set()));
    s.add(a.userRef);
  }
  let sum = 0;
  for (let i = 0; i < p.days; i++) sum += byDay.get(addDays(p.startDay, i))?.size ?? 0;
  const window = (n: number) => {
    const s = new Set<string>();
    for (let i = 0; i < n; i++) for (const u of byDay.get(addDays(p.endDay, -i)) ?? []) s.add(u);
    return s.size;
  };
  const mau = window(30);
  const dau = p.days > 0 ? sum / p.days : null;
  const days = [...byDay.keys()].sort();
  return {
    dau,
    wau: window(7),
    mau,
    stickiness: dau !== null && mau >= MIN_RATE_BASE ? dau / mau : null,
    daysOfData: days.length === 0 ? 0 : Math.round((Date.parse(days[days.length - 1]) - Date.parse(days[0])) / 86_400_000) + 1,
  };
}

const monthOf = (iso: string) => tashkentDay(new Date(iso)).slice(0, 7);
function monthIndex(m: string): number {
  return Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
}

export interface Cohort {
  key: string;
  size: number;
  /** Share active in each month since (0 = the signup month); null for a month that has not happened yet. */
  cells: Array<number | null>;
}

/**
 * Activity retention by signup month: of the people who signed up in month m, the share active in month m + k. Months are
 * Tashkent months. A month after `asOfMonth` is null — it has not happened, so it is not 0%.
 */
export function signupCohorts(people: PersonRow[], activity: ActivityRow[], asOfMonth: string, maxCohorts = 12): Cohort[] {
  const activeMonths = new Map<string, Set<number>>();
  for (const a of activity) {
    let s = activeMonths.get(a.userRef);
    if (!s) activeMonths.set(a.userRef, (s = new Set()));
    s.add(monthIndex(a.day.slice(0, 7)));
  }
  const groups = new Map<string, PersonRow[]>();
  for (const u of people) {
    if (u.internal) continue;
    const m = monthOf(u.signedUpAt);
    const g = groups.get(m) ?? [];
    g.push(u);
    groups.set(m, g);
  }
  const now = monthIndex(asOfMonth);
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, maxCohorts)
    .map(([m, us]) => {
      const start = monthIndex(m);
      const cells: Array<number | null> = [];
      for (let k = 0; start + k <= now && k < 13; k++) {
        const n = us.filter((u) => activeMonths.get(u.userRef)?.has(start + k)).length;
        cells.push(n / us.length);
      }
      return { key: m, size: us.length, cells };
    });
}

/**
 * Subscriber retention by first plan: of the workspaces whose first plan payment was in month m on plan P, the share that paid
 * for a plan again in month m + k. Month 1 is "did they renew in month 2". Read from sales, so it is measured, not modelled.
 */
export function planCohorts(rows: MoneyRow[], asOfMonth: string): Array<Cohort & { plan: string; month: string }> {
  const byOrg = new Map<string, MoneyRow[]>();
  for (const r of rows) {
    if (r.event !== "sale" || r.kind !== "plan" || r.internal || !r.orgRef) continue;
    const g = byOrg.get(r.orgRef) ?? [];
    g.push(r);
    byOrg.set(r.orgRef, g);
  }
  const groups = new Map<string, Array<Set<number>>>();
  for (const sales of byOrg.values()) {
    sales.sort((a, b) => (a.at < b.at ? -1 : 1));
    const first = sales[0];
    const key = `${first.item ?? "?"}|${monthOf(first.at)}`;
    const months = new Set(sales.map((s) => monthIndex(monthOf(s.at))));
    const g = groups.get(key) ?? [];
    g.push(months);
    groups.set(key, g);
  }
  const now = monthIndex(asOfMonth);
  return [...groups.entries()]
    .sort((a, b) => (a[0].split("|")[1] < b[0].split("|")[1] ? 1 : -1))
    .map(([key, orgs]) => {
      const [plan, month] = key.split("|");
      const start = monthIndex(month);
      const cells: Array<number | null> = [];
      for (let k = 0; start + k <= now && k < 13; k++) cells.push(orgs.filter((s) => s.has(start + k)).length / orgs.length);
      return { key, plan, month, size: orgs.length, cells };
    });
}

/**
 * Workspaces that paid for a plan in the period after at least one whole Tashkent month with no plan payment: they came back.
 * Measured from sales only; a person who returned without paying is in the activity cohorts, not here.
 */
export function reactivations(rows: MoneyRow[], p: Pick<Period, "from" | "to">): number {
  const byOrg = new Map<string, number[]>();
  for (const r of rows) {
    if (r.event !== "sale" || r.kind !== "plan" || r.internal || !r.orgRef) continue;
    const g = byOrg.get(r.orgRef) ?? [];
    g.push(monthIndex(monthOf(r.at)));
    byOrg.set(r.orgRef, g);
  }
  let n = 0;
  for (const [org, months] of byOrg) {
    const inside = rows.filter((r) => r.orgRef === org && r.event === "sale" && r.kind === "plan" && within(r.at, p));
    if (inside.length === 0) continue;
    const first = Math.min(...inside.map((r) => monthIndex(monthOf(r.at))));
    const before = months.filter((m) => m < first);
    if (before.length > 0 && first - Math.max(...before) >= 2) n++;
  }
  return n;
}

export interface JobSummary {
  model: string;
  kind: string;
  jobs: number;
  succeeded: number;
  failed: number;
  /** Success share of the finished jobs; null below the rate floor. */
  successRate: number | null;
  avgSeconds: number | null;
  timed: number;
  credits: number;
}

const FAILED = new Set(["failed", "cancelled", "expired"]);

export function jobsByModel(rows: JobRow[], includeInternal = false): JobSummary[] {
  const m = new Map<string, JobSummary>();
  for (const r of rows) {
    if (r.internal && !includeInternal) continue;
    const key = `${r.model}|${r.kind}`;
    const s = m.get(key) ?? { model: r.model, kind: r.kind, jobs: 0, succeeded: 0, failed: 0, successRate: null, avgSeconds: null, timed: 0, credits: 0 };
    s.jobs += r.jobs;
    if (r.status === "completed") s.succeeded += r.jobs;
    else if (FAILED.has(r.status)) s.failed += r.jobs;
    s.credits += r.creditsCharged;
    s.timed += r.status === "completed" ? r.secondsCounted : 0;
    // Time to result is measured on completed jobs only: a failure's "time" is how long it took to fail.
    s.avgSeconds = r.status === "completed" && r.secondsCounted > 0
      ? (((s.avgSeconds ?? 0) * (s.timed - r.secondsCounted)) + r.secondsTotal) / s.timed
      : s.avgSeconds;
    m.set(key, s);
  }
  for (const s of m.values()) s.successRate = rate(s.succeeded, s.succeeded + s.failed);
  return [...m.values()].sort((a, b) => b.jobs - a.jobs);
}
