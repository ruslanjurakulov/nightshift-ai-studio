import "server-only";
import type { Dictionary } from "@/lib/i18n";
import type { Table } from "@/lib/owner-analytics/export";
import type { PeriodSelection } from "@/lib/owner-analytics/period";
import {
  breakdownTable,
  cohortTable,
  funnelTable,
  jobsTable,
  overviewTable,
  planCohortTable,
  revenueEventsTable,
  revenueItemsTable,
  revenueKindsTable,
  revenueKpis,
  revenueSeriesTable,
  signupsTable,
} from "@/lib/owner-analytics/kpis";
import { summarize } from "@/lib/owner-analytics/money";
import { readJobs, readPeople, type ReadFailure } from "./owner-analytics";
import { readActivityFor, readMoneyFor } from "./owner-analytics-data";

/** Every table the hub can export, by the name its export button sends. Anything else is refused before anything is read. */
export const EXPORTABLE = [
  "overview.kpis",
  "revenue.series",
  "revenue.kinds",
  "revenue.items",
  "revenue.events",
  "users.signups",
  "users.funnel",
  "users.locale",
  "users.acquisition",
  "users.cohorts",
  "users.plan_cohorts",
  "usage.models",
] as const;
export type Exportable = (typeof EXPORTABLE)[number];
export const isExportable = (v: unknown): v is Exportable => typeof v === "string" && (EXPORTABLE as readonly string[]).includes(v);

/**
 * The table for an export, rebuilt from the database for this request — never from anything the browser sent but the name and
 * the period. The same builders the page renders with, so the file matches the screen.
 */
export async function buildExport(
  what: Exportable,
  sel: PeriodSelection,
  t: Dictionary,
  present: boolean,
): Promise<{ ok: true; table: Table } | { ok: false; reason: ReadFailure }> {
  const d = t.ownerAnalytics;
  const p = sel.current;
  if (what.startsWith("overview.") || what.startsWith("revenue.") || what === "users.plan_cohorts") {
    const money = await readMoneyFor(sel);
    if (!money.ok) return money;
    if (what === "users.plan_cohorts") return { ok: true, table: planCohortTable(d, money.data, p, present) };
    if (what === "revenue.series") return { ok: true, table: revenueSeriesTable(d, money.data, p, present) };
    if (what === "revenue.events") return { ok: true, table: revenueEventsTable(d, money.data, p, present) };
    if (what === "revenue.kinds") return { ok: true, table: revenueKindsTable(d, summarize(money.data, p), p, present) };
    if (what === "revenue.items") return { ok: true, table: revenueItemsTable(d, summarize(money.data, p), p, present) };
    const activity = await readActivityFor(sel);
    const act = activity && activity.ok ? activity.data : null;
    const k = revenueKpis(money.data, act, p);
    const prev = sel.previous ? revenueKpis(money.data, act, sel.previous) : null;
    return { ok: true, table: overviewTable(d, k, prev, p, present) };
  }
  if (what === "usage.models") {
    const jobs = await readJobs(p.from, p.to);
    if (!jobs.ok) return jobs;
    return { ok: true, table: jobsTable(d, jobs.data, p, present) };
  }
  const people = await readPeople();
  if (!people.ok) return people;
  if (what === "users.signups") return { ok: true, table: signupsTable(d, people.data, p, present) };
  if (what === "users.funnel") return { ok: true, table: funnelTable(d, people.data, p, present) };
  if (what === "users.locale") return { ok: true, table: breakdownTable(d, people.data, p, present, "locale") };
  if (what === "users.acquisition") return { ok: true, table: breakdownTable(d, people.data, p, present, "acquisition") };
  const activity = await readActivityFor(sel);
  if (!activity) return { ok: false, reason: "error" };
  if (!activity.ok) return activity;
  return { ok: true, table: cohortTable(d, people.data, activity.data, p, present) };
}
