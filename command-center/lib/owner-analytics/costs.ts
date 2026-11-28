/**
 * Costs and profit for the owner analytics hub (migration 0184). Pure: no server imports.
 *
 * Three costs, three honesty rules:
 * - Provider spend: the priced rows are summed and the unpriced ones COUNTED; a total with an unpriced row is a floor, and says so.
 * - Balances: shown as the provider reported them, in the provider's own unit, never converted; a balance the owner typed in is
 *   labelled as such with its date.
 * - The owner's monthly costs: a month with no entry is "not entered", never $0 — so an operating result for that month is
 *   unknown, not flattering.
 * Gross profit is net revenue (before provider fees, which nothing stores) less the provider spend of customer workspaces.
 */

import { known, summarize, type MoneyRow } from "./money";
import type { Period } from "./period";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface SpendRow {
  /** Tashkent day; null for a pipeline row whose recorded date could not be read (undated: counted, makes totals incomplete). */
  day: string | null;
  source: "creative" | "pipeline";
  provider: string;
  model: string;
  internal: boolean;
  costRows: number;
  usdKnown: number;
  unpriced: number;
}

export interface BalanceRow {
  provider: string;
  metric: string;
  remaining: number | null;
  total: number | null;
  unit: string;
  source: "api" | "manual";
  checkedAt: string;
}

export const COST_CATEGORIES = ["infrastructure", "tools", "people", "marketing", "legal", "other"] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export interface CostEntry {
  id: number;
  month: string;
  category: CostCategory;
  amountUsd: number;
  note: string | null;
  enteredAt: string;
}

export function coerceSpendRows(data: unknown): SpendRow[] {
  if (!Array.isArray(data)) return [];
  const out: SpendRow[] = [];
  for (const r of data) {
    if (!isObj(r)) continue;
    const day = typeof r.day === "string" ? r.day.slice(0, 10) : null;
    const provider = str(r.provider);
    const rows = known(r.cost_rows);
    if ((day !== null && !DAY_RE.test(day)) || !provider || rows === null) continue;
    // A sum the database sent that does not parse is not a known 0: the rows behind it are unpriced.
    const usd = known(r.usd_known);
    out.push({
      day,
      source: r.source === "pipeline" ? "pipeline" : "creative",
      provider,
      model: str(r.model) ?? "unknown",
      internal: r.internal === true,
      costRows: rows,
      usdKnown: usd ?? 0,
      unpriced: usd === null ? rows : (known(r.unpriced_count) ?? rows),
    });
  }
  return out;
}

export function coerceBalanceRows(data: unknown): BalanceRow[] {
  if (!Array.isArray(data)) return [];
  const out: BalanceRow[] = [];
  for (const r of data) {
    if (!isObj(r)) continue;
    const provider = str(r.provider);
    const metric = str(r.metric);
    const unit = str(r.unit);
    const checkedAt = typeof r.checked_at === "string" && Number.isFinite(Date.parse(r.checked_at)) ? r.checked_at : null;
    if (!provider || !metric || !unit || !checkedAt) continue;
    out.push({
      provider,
      metric,
      remaining: known(r.remaining),
      total: known(r.total),
      unit,
      source: r.source === "manual" ? "manual" : "api",
      checkedAt,
    });
  }
  return out;
}

export function coerceCostEntries(data: unknown): CostEntry[] {
  if (!Array.isArray(data)) return [];
  const out: CostEntry[] = [];
  for (const r of data) {
    if (!isObj(r)) continue;
    const id = known(r.id);
    const month = typeof r.month === "string" ? r.month.slice(0, 10) : "";
    const amount = known(r.amount_usd);
    const category = (COST_CATEGORIES as readonly unknown[]).includes(r.category) ? (r.category as CostCategory) : null;
    if (id === null || !DAY_RE.test(month) || amount === null || !category) continue;
    out.push({ id, month, category, amountUsd: amount, note: str(r.note), enteredAt: typeof r.entered_at === "string" ? r.entered_at : "" });
  }
  return out;
}

export interface SpendTotal {
  usd: number;
  unpriced: number;
  rows: number;
}
const zero = (): SpendTotal => ({ usd: 0, unpriced: 0, rows: 0 });
const addTo = (t: SpendTotal, r: SpendRow) => {
  t.usd += r.usdKnown;
  t.unpriced += r.unpriced;
  t.rows += r.costRows;
};

export interface SpendSummary {
  /** Cost rows whose date could not be read: they may belong to this period, so every total is incomplete while any exist. */
  undated: number;
  customer: SpendTotal;
  internal: SpendTotal;
  byProvider: Array<{ provider: string; source: SpendRow["source"]; total: SpendTotal; internal: SpendTotal }>;
  byModel: Array<{ provider: string; model: string; total: SpendTotal }>;
}

/** Provider spend in a period, split into what serving customers cost and what the operator's own use cost. */
export function summarizeSpend(rows: SpendRow[], p: Pick<Period, "startDay" | "endDay">): SpendSummary {
  const s: SpendSummary = { undated: 0, customer: zero(), internal: zero(), byProvider: [], byModel: [] };
  const prov = new Map<string, SpendSummary["byProvider"][number]>();
  const model = new Map<string, SpendSummary["byModel"][number]>();
  for (const r of rows) {
    if (r.day === null) {
      s.undated += r.costRows;
      continue;
    }
    if (r.day < p.startDay || r.day > p.endDay) continue;
    addTo(r.internal ? s.internal : s.customer, r);
    const pk = `${r.source}:${r.provider}`;
    const pv = prov.get(pk) ?? { provider: r.provider, source: r.source, total: zero(), internal: zero() };
    addTo(r.internal ? pv.internal : pv.total, r);
    prov.set(pk, pv);
    if (!r.internal) {
      const mk = `${r.provider}|${r.model}`;
      const mv = model.get(mk) ?? { provider: r.provider, model: r.model, total: zero() };
      addTo(mv.total, r);
      model.set(mk, mv);
    }
  }
  s.byProvider = [...prov.values()].sort((a, b) => b.total.usd + b.internal.usd - (a.total.usd + a.internal.usd));
  s.byModel = [...model.values()].sort((a, b) => b.total.usd - a.total.usd);
  return s;
}

export interface Profit {
  /** Net revenue before provider fees; null when any amount behind it is unknown. */
  net: number | null;
  /** Customer provider spend; null when any cost row behind it is unpriced. */
  spend: number | null;
  grossProfit: number | null;
  /** Gross profit / net revenue; null when either is unknown or revenue is 0. */
  margin: number | null;
}

export function grossProfit(money: MoneyRow[], spend: SpendSummary, p: Period): Profit {
  const s = summarize(money, p);
  const net = s.netBeforeFees.unknownCount === 0 ? s.netBeforeFees.usd : null;
  const cost = spend.customer.unpriced === 0 ? spend.customer.usd : null;
  // Undated rows are the pipeline's (internal): they make the operating result unknown, not the customers' gross profit.
  const gp = net !== null && cost !== null ? net - cost : null;
  return { net, spend: cost, grossProfit: gp, margin: gp !== null && net !== null && net > 0 ? gp / net : null };
}

export interface MonthResult {
  month: string;
  /** The period covers only part of this month: its figures are for the part, and the entered costs are for the whole. */
  partial: boolean;
  net: number | null;
  spend: number | null;
  internalSpend: number | null;
  /** Null when the owner entered nothing for this month: unknown, not zero. */
  entered: number | null;
  operating: number | null;
}

export function monthsOf(p: Pick<Period, "startDay" | "endDay">): string[] {
  const out: string[] = [];
  let y = Number(p.startDay.slice(0, 4));
  let m = Number(p.startDay.slice(5, 7));
  const end = p.endDay.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= end) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

const lastDay = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * The operating result per calendar month the period touches: net revenue, less customer and internal provider spend, less what
 * the owner entered for that month. A partial month is flagged; a month without entries has no operating result.
 */
export function monthlyResults(
  money: MoneyRow[],
  spendRows: SpendRow[],
  entries: CostEntry[],
  p: Period,
  dayStartUtc: (day: string) => string,
): MonthResult[] {
  return monthsOf(p).map((month) => {
    const first = `${month}-01`;
    const last = lastDay(month);
    const startDay = first < p.startDay ? p.startDay : first;
    const endDay = last > p.endDay ? p.endDay : last;
    const next = new Date(Date.parse(`${endDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const window = { from: dayStartUtc(startDay), to: dayStartUtc(next) };
    const s = summarize(money, window);
    const sp = summarizeSpend(spendRows, { startDay, endDay });
    const mine = entries.filter((e) => e.month.slice(0, 7) === month);
    const net = s.netBeforeFees.unknownCount === 0 ? s.netBeforeFees.usd : null;
    const spend = sp.customer.unpriced === 0 ? sp.customer.usd : null;
    const internalSpend = sp.internal.unpriced === 0 && sp.undated === 0 ? sp.internal.usd : null;
    const entered = mine.length > 0 ? mine.reduce((a, e) => a + e.amountUsd, 0) : null;
    const partial = startDay !== first || endDay !== last;
    // A partial month would subtract a whole month's entered costs from part of a month's revenue: no result, not a wrong one.
    const operating =
      !partial && net !== null && spend !== null && internalSpend !== null && entered !== null ? net - spend - internalSpend - entered : null;
    return { month, partial, net, spend, internalSpend, entered, operating };
  });
}
