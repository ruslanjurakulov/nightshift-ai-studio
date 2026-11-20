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
import { applyScope, summarize } from "@/lib/owner-analytics/money";
import { readJobs, readPeople, type ReadFailure } from "./owner-analytics";
import { readActivityFor, readCohortActivity, readMoneyFor } from "./owner-analytics-data";

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
  const inc = sel.includeInternal;
  const done = (table: Table) => {
    if (inc) table.preamble = [...(table.preamble ?? []), d.includedInternal];
    return { ok: true as const, table };
  };
  if (what.startsWith("overview.") || what.startsWith("revenue.") || what === "users.plan_cohorts") {
    const money = await readMoneyFor(sel);
    if (!money.ok) return money;
    const rows = applyScope(money.data, inc);
    if (what === "users.plan_cohorts") return done(planCohortTable(d, rows, p, present));
    if (what === "revenue.series") return done(revenueSeriesTable(d, rows, p, present));
    if (what === "revenue.events") return done(revenueEventsTable(d, rows, p, present));
    if (what === "revenue.kinds") return done(revenueKindsTable(d, summarize(rows, p), p, present));
    if (what === "revenue.items") return done(revenueItemsTable(d, summarize(rows, p), p, present));
    const activity = await readActivityFor(sel);
    const act = activity && activity.read.ok ? applyScope(activity.read.data, inc) : null;
    const k = revenueKpis(rows, act, p);
    const prev = sel.previous ? revenueKpis(rows, activity?.previous ? act : null, sel.previous) : null;
    return done(overviewTable(d, k, prev, p, present));
  }
  if (what === "usage.models") {
    const jobs = await readJobs(p.from, p.to);
    if (!jobs.ok) return jobs;
    return done(jobsTable(d, applyScope(jobs.data, inc), p, present));
  }
  const peopleRead = await readPeople();
  if (!peopleRead.ok) return peopleRead;
  const people = applyScope(peopleRead.data, inc);
  if (what === "users.signups") return done(signupsTable(d, people, p, present));
  if (what === "users.funnel") return done(funnelTable(d, people, p, present));
  if (what === "users.locale") return done(breakdownTable(d, people, p, present, "locale"));
  if (what === "users.acquisition") return done(breakdownTable(d, people, p, present, "acquisition"));
  const cohort = await readCohortActivity(sel);
  if (!cohort.read.ok) return cohort.read;
  return done(cohortTable(d, people, applyScope(cohort.read.data, inc), cohort.fromMonth, p, present));
}
