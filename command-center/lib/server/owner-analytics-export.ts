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
import { readCostEntries, readJobs, readPeople, readSpend, type ReadFailure } from "./owner-analytics";
import { monthlyResults, summarizeSpend } from "@/lib/owner-analytics/costs";
import { costEntriesTable, monthlyTable, spendModelsTable, spendProvidersTable } from "@/lib/owner-analytics/cost-tables";
import { tashkentDayStartUtc } from "@/lib/owner-analytics/period";
import { readActivityFor, readCohortActivity, readMoneyFor } from "./owner-analytics-data";
import { readRunway } from "./owner-runway";
import { providerRunways } from "@/lib/owner-analytics/runway";
import { runwayModelsTable, runwayProvidersTable } from "@/lib/owner-analytics/runway-tables";

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
  "costs.providers",
  "costs.models",
  "costs.monthly",
  "costs.entries",
  "runway.providers",
  "runway.models",
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
  if (what.startsWith("runway.")) {
    // A runway is measured up to now, whatever period is picked (the page says the same).
    const nowMs = Date.now();
    const data = await readRunway(nowMs);
    if (!data) return { ok: false, reason: "error" };
    const rows = providerRunways(data);
    return done(what === "runway.providers" ? runwayProvidersTable(d, rows, nowMs, present) : runwayModelsTable(d, rows, nowMs, present));
  }
  if (what.startsWith("costs.")) {
    const fromMonth = `${p.startDay.slice(0, 7)}-01`;
    const toMonth = `${p.endDay.slice(0, 7)}-01`;
    if (what === "costs.entries") {
      const e = await readCostEntries(fromMonth, toMonth);
      if (!e.ok) return e;
      return done(costEntriesTable(d, e.data, p, present));
    }
    const spend = await readSpend(p.from, p.to);
    if (!spend.ok) return spend;
    const sp = summarizeSpend(applyScope(spend.data, inc), p);
    if (what === "costs.providers") return done(spendProvidersTable(d, sp, p, present));
    if (what === "costs.models") return done(spendModelsTable(d, sp, p, present));
    const [money, e] = await Promise.all([readMoneyFor(sel), readCostEntries(fromMonth, toMonth)]);
    if (!money.ok) return money;
    if (!e.ok) return e;
    return done(monthlyTable(d, monthlyResults(applyScope(money.data, inc), applyScope(spend.data, inc), e.data, p, tashkentDayStartUtc), p, present));
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
