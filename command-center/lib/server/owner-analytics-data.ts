import "server-only";
import type { MoneyRow } from "@/lib/owner-analytics/money";
import type { ActivityRow, JobRow } from "@/lib/owner-analytics/people";
import { tashkentDayStartUtc, type Period, type PeriodSelection } from "@/lib/owner-analytics/period";
import { HISTORY_FROM } from "@/lib/owner-analytics/kpis";
import { readActivity, readJobs, readMoney, readSpend, type Read } from "./owner-analytics";
import type { SpendRow } from "@/lib/owner-analytics/costs";

const DAY = 86_400_000;
/** owner_analytics_activity refuses a window over 400 days; one day of slack for the half-open end. */
const ACTIVITY_MAX_DAYS = 399;
/** owner_analytics_jobs refuses a window over 1100 days. */
const JOBS_MAX_DAYS = 1099;

/** All money since the platform could take any, up to the end of the period: MRR, churn and cohorts need history. */
export function readMoneyFor(sel: PeriodSelection): Promise<Read<MoneyRow[]>> {
  return readMoney(HISTORY_FROM, sel.current.to);
}

export interface ActivityFor {
  read: Read<ActivityRow[]>;
  /** The activity covers this period and the 29 days before it (what MAU at its end needs). */
  current: boolean;
  /** The same for the previous period; false means every activity figure of the previous period is unknown. */
  previous: boolean;
}

/**
 * Activity for a period, plus the 29 days before it, and the previous period when comparing. When the span is longer than the
 * database will read, the read is narrowed — and says which period it no longer covers, so a figure of that period is shown
 * as unknown instead of being computed from a part of it.
 */
export async function readActivityFor(sel: PeriodSelection): Promise<ActivityFor | null> {
  const start = (p: Period) => Date.parse(p.from) - 29 * DAY;
  const to = Date.parse(sel.current.to);
  const own = start(sel.current);
  if ((to - own) / DAY > ACTIVITY_MAX_DAYS) return null;
  if (sel.previous && (to - start(sel.previous)) / DAY <= ACTIVITY_MAX_DAYS) {
    return { read: await readActivity(new Date(start(sel.previous)).toISOString(), sel.current.to), current: true, previous: true };
  }
  return { read: await readActivity(new Date(own).toISOString(), sel.current.to), current: true, previous: false };
}

/**
 * Activity for the cohort heatmap: the twelve whole Tashkent months up to the period's end (inside the database's 400-day
 * limit). Returns the first month it covers, so every cell before it is drawn as unmeasured.
 */
export async function readCohortActivity(sel: PeriodSelection): Promise<{ read: Read<ActivityRow[]>; fromMonth: string }> {
  const end = sel.current.endDay;
  const y = Number(end.slice(0, 4));
  const m = Number(end.slice(5, 7)) - 1;
  const first = new Date(Date.UTC(y, m - 11, 1)).toISOString().slice(0, 10);
  return { read: await readActivity(tashkentDayStartUtc(first), sel.current.to), fromMonth: first.slice(0, 7) };
}

/** Jobs for the period and, when comparing, the previous one — as two reads when one would be longer than the database allows. */
export async function readJobsFor(sel: PeriodSelection): Promise<Read<JobRow[]>> {
  const p = sel.previous;
  if (!p) return readJobs(sel.current.from, sel.current.to);
  if ((Date.parse(sel.current.to) - Date.parse(p.from)) / DAY <= JOBS_MAX_DAYS) return readJobs(p.from, sel.current.to);
  const [a, b] = await Promise.all([readJobs(p.from, p.to), readJobs(sel.current.from, sel.current.to)]);
  if (!a.ok) return a;
  if (!b.ok) return b;
  return { ok: true, data: [...a.data, ...b.data], truncated: a.truncated || b.truncated };
}

/** Provider spend for the period and, when comparing, the previous one — two reads when one would pass the database's limit. */
export async function readSpendFor(sel: PeriodSelection): Promise<Read<SpendRow[]>> {
  const p = sel.previous;
  if (!p) return readSpend(sel.current.from, sel.current.to);
  if ((Date.parse(sel.current.to) - Date.parse(p.from)) / DAY <= JOBS_MAX_DAYS) return readSpend(p.from, sel.current.to);
  const [a, b] = await Promise.all([readSpend(p.from, p.to), readSpend(sel.current.from, sel.current.to)]);
  if (!a.ok) return a;
  if (!b.ok) return b;
  // Undated rows come back on both reads: keep one copy.
  return { ok: true, data: [...a.data, ...b.data.filter((r) => r.day !== null)], truncated: a.truncated || b.truncated };
}
