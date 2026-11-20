/**
 * The costs tab's tables, shared by the page and the export route (as kpis.ts is for revenue). Pure.
 * Every unknown is a null cell: an unpriced spend, a month with no entered costs, a result that depends on either.
 */

import type { Dictionary } from "@/lib/i18n";
import type { Table } from "./export";
import type { CostEntry, MonthResult, SpendSummary } from "./costs";
import { fill } from "./format";
import { TIMEZONE, type Period } from "./period";

type D = Dictionary["ownerAnalytics"];
const r2 = (n: number) => Math.round(n * 100) / 100;

function preamble(d: D, title: string, p: Period, present: boolean): string[] {
  return [
    fill(d.reportTitle, { title }),
    `${d.period}: ${p.startDay} — ${p.endDay} (${TIMEZONE})`,
    d.timezoneNote,
    d.costsOwnerOnly,
    ...(present ? [d.presentOn] : []),
  ];
}

export function spendProvidersTable(d: D, s: SpendSummary, p: Period, present: boolean): Table {
  return {
    name: d.spendByProvider,
    preamble: preamble(d, d.spendByProvider, p, present),
    columns: [d.providerName, d.source, `${d.providerSpend}, ${d.usd}`, d.costRows, d.unpriced, `${d.internalSpend}, ${d.usd}`],
    rows: s.byProvider.map((x) => [
      x.provider,
      x.source === "pipeline" ? d.sourcePipeline : d.sourceCreative,
      x.total.unpriced > 0 ? null : r2(x.total.usd),
      x.total.rows + x.internal.rows,
      x.total.unpriced + x.internal.unpriced,
      x.internal.unpriced > 0 ? null : r2(x.internal.usd),
    ]),
  };
}

export function spendModelsTable(d: D, s: SpendSummary, p: Period, present: boolean): Table {
  return {
    name: d.spendByModel,
    preamble: preamble(d, d.spendByModel, p, present),
    columns: [d.providerName, d.model, `${d.providerSpend}, ${d.usd}`, d.costRows, d.unpriced],
    rows: s.byModel.map((x) => [x.provider, x.model, x.total.unpriced > 0 ? null : r2(x.total.usd), x.total.rows, x.total.unpriced]),
  };
}

export function monthlyTable(d: D, months: MonthResult[], p: Period, present: boolean): Table {
  const v = (n: number | null) => (n === null ? null : r2(n));
  return {
    name: d.monthly,
    preamble: [...preamble(d, d.monthly, p, present), d.monthlyNote],
    columns: [d.month, "", `${d.net}, ${d.usd}`, `${d.providerSpend}, ${d.usd}`, `${d.internalSpend}, ${d.usd}`, `${d.enteredCosts}, ${d.usd}`, `${d.operatingResult}, ${d.usd}`],
    rows: months.map((m) => [m.month, m.partial ? d.partialMonth : "", v(m.net), v(m.spend), v(m.internalSpend), v(m.entered), v(m.operating)]),
  };
}

export function costEntriesTable(d: D, entries: CostEntry[], p: Period, present: boolean): Table {
  const label: Record<CostEntry["category"], string> = {
    infrastructure: d.catInfrastructure,
    tools: d.catTools,
    people: d.catPeople,
    marketing: d.catMarketing,
    legal: d.catLegal,
    other: d.catOther,
  };
  return {
    name: d.costEntries,
    preamble: preamble(d, d.costEntries, p, present),
    // A note is free text the owner typed (a name, a salary line): it does not exist in presentation mode, on screen or in a file.
    columns: [d.month, d.category, `${d.amount}, ${d.usd}`, ...(present ? [] : [d.note])],
    rows: entries.map((e) => [e.month.slice(0, 7), label[e.category], r2(e.amountUsd), ...(present ? [] : [e.note])]),
  };
}
