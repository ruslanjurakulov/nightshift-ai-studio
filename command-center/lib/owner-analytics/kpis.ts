/**
 * The headline figures and every exportable table of the hub, built from the rows the database returned. Pure.
 *
 * The page and the export route both build from these functions, so the file the owner hands an investor and the screen they
 * presented from cannot disagree. In presentation mode no table carries a payment id, a person or a workspace id: the column is
 * not rendered and not exported, rather than blurred.
 */

import type { Dictionary } from "@/lib/i18n";
import type { Cell, Table } from "./export";
import { churn, ltvEstimate, moneySeries, mrrAt, summarize, type MoneyRow, type RevenueSummary, type SaleKind } from "./money";
import {
  countBy,
  engagement,
  funnel,
  jobsByModel,
  planCohorts,
  reactivations,
  signupCohorts,
  signupsByDay,
  type ActivityRow,
  type JobRow,
  type PersonRow,
} from "./people";
import { bucketFor, previousPeriod, tashkentDay, type Period } from "./period";
import { bucketKey, bucketKeys, inWindow } from "./money";
import { fill, tashkentDateTime } from "./format";
import { TIMEZONE } from "./period";

type D = Dictionary["ownerAnalytics"];

/** Everything since the platform could have taken a payment: plan cohorts and MRR need the whole history, not the window. */
export const HISTORY_FROM = "2024-01-01T00:00:00.000Z";

export interface RevenueKpis {
  summary: RevenueSummary;
  mrr: { usd: number | null; subscribers: number; incomplete: boolean };
  arr: number | null;
  activeUsers: number | null;
  arpu: number | null;
  arppu: number | null;
  churn: { base: number; churned: number; rate: number | null };
  ltv: number | null;
}

const lastInstant = (p: Pick<Period, "to">) => new Date(Date.parse(p.to) - 1).toISOString();

/** The 30 days that end with the period: churn is quoted monthly, whatever length the period has. */
export function trailingMonth(p: Pick<Period, "to">): Pick<Period, "from" | "to"> {
  return { from: new Date(Date.parse(p.to) - 30 * 86_400_000).toISOString(), to: p.to };
}

export function revenueKpis(money: MoneyRow[], activity: ActivityRow[] | null, p: Period): RevenueKpis {
  const summary = summarize(money, p);
  const mrr = mrrAt(money, lastInstant(p));
  const net = summary.netBeforeFees.usd;
  let activeUsers: number | null = null;
  if (activity) {
    const s = new Set<string>();
    for (const a of activity) if (!a.internal && a.day >= p.startDay && a.day <= p.endDay) s.add(a.userRef);
    activeUsers = s.size;
  }
  // Revenue per person is withheld when the revenue under it is incomplete: a floor divided by a count is not an average.
  const netKnown = summary.netBeforeFees.unknownCount === 0 ? net : null;
  const c = churn(money, trailingMonth(p));
  const perSubscriber = mrr.usd !== null && mrr.subscribers > 0 ? mrr.usd / mrr.subscribers : null;
  return {
    summary,
    mrr,
    arr: mrr.usd === null ? null : mrr.usd * 12,
    activeUsers,
    arpu: activeUsers && netKnown !== null ? netKnown / activeUsers : null,
    // USD revenue over the workspaces that paid in USD: a euro payer is not in the numerator, so not in the denominator.
    arppu: summary.payingOrgsUsd > 0 && netKnown !== null ? netKnown / summary.payingOrgsUsd : null,
    churn: c,
    ltv: ltvEstimate(perSubscriber, c.rate),
  };
}

const kindLabel = (d: D, k: SaleKind) =>
  k === "plan" ? d.kindPlan : k === "pack" ? d.kindPack : k === "api_topup" ? d.kindApiTopup : d.kindUnknown;

function preamble(d: D, title: string, p: Period, present: boolean): string[] {
  return [
    fill(d.reportTitle, { title }),
    `${d.period}: ${p.startDay} — ${p.endDay} (${TIMEZONE})`,
    d.timezoneNote,
    ...(present ? [d.presentOn] : []),
  ];
}

const usdOrNull = (a: { usd: number; unknownCount: number }): Cell => (a.unknownCount > 0 ? null : round2(a.usd));
const round2 = (n: number) => Math.round(n * 100) / 100;

export function revenueSeriesTable(d: D, money: MoneyRow[], p: Period, present: boolean): Table {
  return {
    name: d.revenueOverTime,
    preamble: preamble(d, d.revenueOverTime, p, present),
    columns: [d.date, d.gross, d.refunds, d.net],
    rows: moneySeries(money, p).map((r) => [r.x, r.gross === null ? null : round2(r.gross), r.refunds === null ? null : round2(r.refunds), r.net === null ? null : round2(r.net)]),
  };
}

export function revenueKindsTable(d: D, s: RevenueSummary, p: Period, present: boolean): Table {
  return {
    name: d.byKind,
    preamble: preamble(d, d.byKind, p, present),
    columns: [d.source, d.sales, `${d.gross}, ${d.usd}`],
    rows: (["plan", "pack", "api_topup", "unknown"] as SaleKind[]).map((k) => [kindLabel(d, k), s.byKind[k].count, usdOrNull(s.byKind[k].gross)]),
  };
}

export function revenueItemsTable(d: D, s: RevenueSummary, p: Period, present: boolean): Table {
  return {
    name: `${d.planSales} · ${d.packSales}`,
    preamble: preamble(d, `${d.planSales} · ${d.packSales}`, p, present),
    columns: [d.source, d.item, d.count, d.initial, d.renewal, d.chargeUnknown, `${d.gross}, ${d.usd}`],
    rows: s.byItem.map((i) => [
      kindLabel(d, i.kind),
      i.item === "?" ? d.notRecorded : i.item,
      i.count,
      i.kind === "plan" ? i.initial : null,
      i.kind === "plan" ? i.renewal : null,
      i.kind === "plan" ? i.chargeUnknown : null,
      usdOrNull(i.gross),
    ]),
  };
}

export function revenueEventsTable(d: D, money: MoneyRow[], p: Period, present: boolean): Table {
  const rows = money
    .filter((r) => inWindow(r, p) && !r.internal)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  const ev = (e: MoneyRow["event"]) =>
    e === "sale" ? d.eventSale : e === "refund" ? d.eventRefund : e === "dispute" ? d.eventDispute : d.eventUncredited;
  const charge = (r: MoneyRow) => (r.kind !== "plan" ? null : r.charge === "initial" ? d.initial : r.charge === "renewal" ? d.renewal : d.chargeUnknown);
  return {
    name: d.salesTable,
    preamble: preamble(d, d.salesTable, p, present),
    // The payment id column does not exist in presentation mode: not rendered, not exported.
    columns: [d.date, d.event, d.source, d.item, d.renewal, d.provider, d.currency, d.amount, ...(present ? [] : [d.payment])],
    rows: rows.map((r) => [
      tashkentDateTime(r.at),
      ev(r.event),
      kindLabel(d, r.kind),
      r.item ?? d.notRecorded,
      charge(r),
      r.provider,
      r.currency ?? d.unknown,
      r.amountMinor === null ? null : r.amountMinor / 100,
      ...(present ? [] : [r.paymentRef]),
    ]),
  };
}

export function overviewTable(d: D, k: RevenueKpis, prev: RevenueKpis | null, p: Period, present: boolean): Table {
  // Without a comparison there is no "previous" column at all, rather than a column of unknowns.
  const row = (label: string, cur: number | null, before: number | null | undefined): Cell[] => [
    label,
    cur === null ? null : round2(cur),
    ...(prev ? [before === null || before === undefined ? null : round2(before)] : []),
  ];
  const s = k.summary;
  const ps = prev?.summary;
  return {
    name: d.tabOverview,
    preamble: [...preamble(d, d.tabOverview, p, present), `${d.fees}: ${d.feesUnknown}`],
    columns: ["", d.period, ...(prev ? [d.previous] : [])],
    rows: [
      row(`${d.gross}, ${d.usd}`, s.gross.unknownCount ? null : s.gross.usd, ps && (ps.gross.unknownCount ? null : ps.gross.usd)),
      row(`${d.refunds}, ${d.usd}`, s.refunds.unknownCount ? null : s.refunds.usd, ps && (ps.refunds.unknownCount ? null : ps.refunds.usd)),
      row(`${d.disputes}, ${d.usd}`, s.disputes.unknownCount ? null : s.disputes.usd, ps && (ps.disputes.unknownCount ? null : ps.disputes.usd)),
      row(`${d.net}, ${d.usd}`, s.netBeforeFees.unknownCount ? null : s.netBeforeFees.usd, ps && (ps.netBeforeFees.unknownCount ? null : ps.netBeforeFees.usd)),
      row(d.sales, s.sales, ps?.sales),
      row(`${d.mrr}, ${d.usd}`, k.mrr.usd, prev?.mrr.usd),
      row(`${d.arr}, ${d.usd}`, k.arr, prev?.arr),
      row(`${d.arpu}, ${d.usd}`, k.arpu, prev?.arpu),
      row(`${d.arppu}, ${d.usd}`, k.arppu, prev?.arppu),
      row(`${d.ltv} , ${d.usd}, ${d.estimate}`, k.ltv, prev?.ltv),
      row(d.subscribers, k.mrr.subscribers, prev?.mrr.subscribers),
      row(d.churn, k.churn.rate, prev?.churn.rate),
    ],
  };
}

// ── users ────────────────────────────────────────────────────────────────────

export function signupSeries(people: PersonRow[], p: Period): Array<{ x: string; y: number }> {
  const byDay = signupsByDay(people, p);
  const bucket = bucketFor(p.days);
  const acc = new Map(bucketKeys(p).map((k) => [k, 0]));
  for (const [day, n] of byDay) {
    const k = bucketKey(day, bucket);
    if (acc.has(k)) acc.set(k, acc.get(k)! + n);
  }
  return [...acc.entries()].map(([x, y]) => ({ x, y }));
}

export function signupsTable(d: D, people: PersonRow[], p: Period, present: boolean): Table {
  return {
    name: d.signups,
    preamble: preamble(d, d.signupsOverTime, p, present),
    columns: [d.date, d.signups],
    rows: signupSeries(people, p).map((r) => [r.x, r.y]),
  };
}

export function funnelTable(d: D, people: PersonRow[], p: Period, present: boolean): Table {
  const label = { signup: d.stepSignup, project: d.stepProject, generation: d.stepGeneration, export: d.stepExport, payment: d.stepPayment };
  return {
    name: d.funnel,
    preamble: [...preamble(d, d.funnel, p, present), d.funnelNote],
    columns: ["", d.count, "%"],
    rows: funnel(people, p).map((s) => [label[s.key], s.count, s.ofSignups === null ? null : Math.round(s.ofSignups * 1000) / 10]),
  };
}

export function breakdownTable(d: D, people: PersonRow[], p: Period, present: boolean, by: "locale" | "acquisition"): Table {
  const rows = countBy(people, p, by === "locale" ? (u) => u.locale : (u) => u.acquisition);
  const name = by === "locale" ? d.byLocale : d.byAcquisition;
  const lab = (k: string | null) =>
    k === null ? d.notRecorded : by === "acquisition" ? (k === "referral" ? d.acqReferral : d.acqInvite) : k;
  return {
    name,
    preamble: [...preamble(d, name, p, present), ...(by === "acquisition" ? [d.acqNote] : [])],
    columns: [name, d.signups],
    rows: rows.map(([k, n]) => [lab(k), n]),
  };
}

export function cohortTable(d: D, people: PersonRow[], activity: ActivityRow[], fromMonth: string, p: Period, present: boolean): Table {
  const cohorts = signupCohorts(people, activity, p.endDay.slice(0, 7), fromMonth);
  const width = Math.max(0, ...cohorts.map((c) => c.cells.length));
  return {
    name: d.cohorts,
    preamble: [...preamble(d, d.cohorts, p, present), d.cohortsNote],
    columns: ["", d.cohortSize, ...Array.from({ length: width }, (_, i) => d.monthN.replace("{n}", String(i)))],
    rows: cohorts.map((c) => [c.key, c.size, ...Array.from({ length: width }, (_, i) => (c.cells[i] == null ? null : Math.round(c.cells[i]! * 1000) / 10))]),
  };
}

export function planCohortTable(d: D, money: MoneyRow[], p: Period, present: boolean): Table {
  const cohorts = planCohorts(money, p.endDay.slice(0, 7));
  const width = Math.max(0, ...cohorts.map((c) => c.cells.length));
  return {
    name: d.planCohorts,
    preamble: [...preamble(d, d.planCohorts, p, present), d.planCohortsNote],
    columns: [d.item, d.date, d.cohortSize, ...Array.from({ length: width }, (_, i) => d.monthN.replace("{n}", String(i)))],
    rows: cohorts.map((c) => [c.plan === "?" ? d.notRecorded : c.plan, c.month, c.size, ...Array.from({ length: width }, (_, i) => (c.cells[i] == null ? null : Math.round(c.cells[i]! * 1000) / 10))]),
  };
}

export { engagement, reactivations };

// ── usage ────────────────────────────────────────────────────────────────────

export function jobsTable(d: D, jobs: JobRow[], p: Period, present: boolean): Table {
  return {
    name: d.jobsByModel,
    preamble: preamble(d, d.jobsByModel, p, present),
    columns: [d.model, d.kind, d.jobs, d.successRate, d.avgTime, d.credits],
    rows: jobsByModel(jobs).map((j) => [
      j.model,
      j.kind,
      j.jobs,
      j.successRate === null ? null : Math.round(j.successRate * 1000) / 10,
      j.avgSeconds === null ? null : Math.round(j.avgSeconds),
      // No job of this model carried a charge: the credits are unknown, not 0.
      j.creditsCounted > 0 ? round2(j.credits) : null,
    ]),
  };
}

export function jobsSeries(jobs: JobRow[], p: Period): Array<{ x: string; ok: number; failed: number }> {
  const bucket = bucketFor(p.days);
  const acc = new Map(bucketKeys(p).map((k) => [k, { ok: 0, failed: 0 }]));
  for (const j of jobs) {
    if (j.internal) continue;
    const a = acc.get(bucketKey(j.day, bucket));
    if (!a) continue;
    if (j.status === "completed") a.ok += j.jobs;
    else if (j.status === "failed" || j.status === "cancelled" || j.status === "expired") a.failed += j.jobs;
  }
  return [...acc.entries()].map(([x, v]) => ({ x, ...v }));
}

export { previousPeriod, tashkentDay };
