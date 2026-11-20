/**
 * Revenue for the owner analytics hub, computed from owner_analytics_money() rows (migration 0182). Pure: no server imports.
 *
 * The database returns what the payment provider reported and nothing else; this file adds it up and refuses to fill a gap:
 * - Only USD is summed. There is no stored exchange rate, so a payment in another currency is COUNTED apart and never added as
 *   dollars (a euro read as a dollar is a made-up number).
 * - A sale or refund whose amount was not reported makes its total INCOMPLETE: the figure is shown with that flag, never as if
 *   the missing amount were zero.
 * - Provider fees are not stored by either webhook, so fees are always unknown and "net" is net BEFORE provider fees.
 * - The operator's own workspace (internal) is left out of every figure, and counted so the page can say how much it left out.
 */

import { bucketFor, tashkentDay, type Bucket, type Period } from "./period";

export const SALE_KINDS = ["plan", "pack", "api_topup", "unknown"] as const;
export type SaleKind = (typeof SALE_KINDS)[number];
export type MoneyEvent = "sale" | "refund" | "dispute";
export type Charge = "initial" | "renewal" | null;

export interface MoneyRow {
  event: MoneyEvent;
  at: string;
  provider: string;
  paymentRef: string;
  orgRef: string | null;
  kind: SaleKind;
  item: string | null;
  charge: Charge;
  currency: string | null;
  amountMinor: number | null;
  feeMinor: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  subscriptionRef: string | null;
  internal: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A number the database supplied, or null. null / "" / NaN never become 0. */
export function known(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function isInstant(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

/** Rows as typed rows. A malformed row is dropped, not repaired: a guessed field is worse than a missing row. */
export function coerceMoneyRows(data: unknown): MoneyRow[] {
  if (!Array.isArray(data)) return [];
  const out: MoneyRow[] = [];
  for (const r of data) {
    if (!isObj(r) || !isInstant(r.at)) continue;
    const event = r.event;
    if (event !== "sale" && event !== "refund" && event !== "dispute") continue;
    const kind = (SALE_KINDS as readonly unknown[]).includes(r.kind) ? (r.kind as SaleKind) : "unknown";
    const charge = r.charge === "initial" || r.charge === "renewal" ? r.charge : null;
    const paymentRef = str(r.payment_ref);
    if (!paymentRef) continue;
    out.push({
      event,
      at: r.at,
      provider: str(r.provider) ?? "unknown",
      paymentRef,
      orgRef: str(r.org_ref),
      kind,
      item: str(r.item),
      charge,
      currency: str(r.currency)?.toUpperCase() ?? null,
      amountMinor: known(r.amount_minor),
      feeMinor: known(r.fee_minor),
      periodStart: isInstant(r.period_start) ? r.period_start : null,
      periodEnd: isInstant(r.period_end) ? r.period_end : null,
      subscriptionRef: r.subscription_ref === null || r.subscription_ref === undefined ? null : String(r.subscription_ref),
      internal: r.internal === true,
    });
  }
  return out;
}

/** A dollar figure and whether every part of it was known. */
export interface Amount {
  usd: number;
  /** Rows that belong in this figure but carried no amount: the figure is a floor, not the total. */
  unknownCount: number;
}
const zero = (): Amount => ({ usd: 0, unknownCount: 0 });
function add(a: Amount, r: MoneyRow): void {
  if (r.amountMinor === null) a.unknownCount++;
  else a.usd += r.amountMinor / 100;
}

const inWindow = (r: MoneyRow, p: Pick<Period, "from" | "to">) => r.at >= p.from && r.at < p.to;
const isUsd = (r: MoneyRow) => r.currency === "USD";

export interface ItemSales {
  item: string;
  kind: SaleKind;
  count: number;
  initial: number;
  renewal: number;
  chargeUnknown: number;
  gross: Amount;
}

export interface RevenueSummary {
  gross: Amount;
  refunds: Amount;
  disputes: Amount;
  /** Gross less refunds and disputes; provider fees are NOT taken out (they are not stored). */
  netBeforeFees: Amount;
  sales: number;
  refundCount: number;
  disputeCount: number;
  byKind: Record<SaleKind, { count: number; gross: Amount }>;
  byItem: ItemSales[];
  /** Payments in another currency: counted, never added. */
  otherCurrency: Array<{ currency: string; count: number; minor: number | null }>;
  /** The operator's own workspace: left out of everything above. */
  internalExcluded: number;
  payingOrgs: number;
}

export function summarize(rows: MoneyRow[], p: Pick<Period, "from" | "to">): RevenueSummary {
  const s: RevenueSummary = {
    gross: zero(),
    refunds: zero(),
    disputes: zero(),
    netBeforeFees: zero(),
    sales: 0,
    refundCount: 0,
    disputeCount: 0,
    byKind: { plan: { count: 0, gross: zero() }, pack: { count: 0, gross: zero() }, api_topup: { count: 0, gross: zero() }, unknown: { count: 0, gross: zero() } },
    byItem: [],
    otherCurrency: [],
    internalExcluded: 0,
    payingOrgs: 0,
  };
  const items = new Map<string, ItemSales>();
  const other = new Map<string, { currency: string; count: number; minor: number | null }>();
  const payers = new Set<string>();
  for (const r of rows) {
    if (!inWindow(r, p)) continue;
    if (r.internal) {
      s.internalExcluded++;
      continue;
    }
    if (!isUsd(r)) {
      // A null currency is as unknown as a foreign one: it is counted here, under "?", not summed as dollars.
      const c = r.currency ?? "?";
      const o = other.get(`${r.event}:${c}`) ?? { currency: c, count: 0, minor: 0 };
      o.count++;
      o.minor = o.minor === null || r.amountMinor === null ? null : o.minor + (r.event === "sale" ? r.amountMinor : -r.amountMinor);
      other.set(`${r.event}:${c}`, o);
      if (r.event === "sale") {
        s.sales++;
        s.byKind[r.kind].count++;
        if (r.orgRef) payers.add(r.orgRef);
      }
      continue;
    }
    if (r.event === "sale") {
      s.sales++;
      add(s.gross, r);
      s.byKind[r.kind].count++;
      add(s.byKind[r.kind].gross, r);
      if (r.orgRef) payers.add(r.orgRef);
      const key = `${r.kind}:${r.item ?? "?"}`;
      const it = items.get(key) ?? { item: r.item ?? "?", kind: r.kind, count: 0, initial: 0, renewal: 0, chargeUnknown: 0, gross: zero() };
      it.count++;
      if (r.kind === "plan") {
        if (r.charge === "initial") it.initial++;
        else if (r.charge === "renewal") it.renewal++;
        else it.chargeUnknown++;
      }
      add(it.gross, r);
      items.set(key, it);
    } else if (r.event === "refund") {
      s.refundCount++;
      add(s.refunds, r);
    } else {
      s.disputeCount++;
      add(s.disputes, r);
    }
  }
  s.netBeforeFees = {
    usd: s.gross.usd - s.refunds.usd - s.disputes.usd,
    unknownCount: s.gross.unknownCount + s.refunds.unknownCount + s.disputes.unknownCount,
  };
  s.byItem = [...items.values()].sort((a, b) => b.gross.usd - a.gross.usd || b.count - a.count);
  s.otherCurrency = [...other.values()];
  s.payingOrgs = payers.size;
  return s;
}

const MONTH_DAYS = 365.25 / 12;

/**
 * MRR at an instant: every plan payment whose billed period covers `at`, normalised to a month (a yearly plan is a twelfth of
 * its price a month). Gross of tax, as the provider reported it. Null when no plan payment exists at all (nothing measured), so
 * the page says "no subscriptions yet" rather than "$0 MRR"; `incomplete` when a covering payment had no amount or currency.
 */
export function mrrAt(rows: MoneyRow[], at: string): { usd: number | null; subscribers: number; incomplete: boolean } {
  let usd = 0;
  let any = false;
  let incomplete = false;
  const subs = new Set<string>();
  for (const r of rows) {
    if (r.event !== "sale" || r.kind !== "plan" || r.internal) continue;
    any = true;
    if (!r.periodStart || !r.periodEnd || !(r.periodStart <= at && at < r.periodEnd)) continue;
    subs.add(r.subscriptionRef ?? r.paymentRef);
    if (r.amountMinor === null || !isUsd(r)) {
      incomplete = true;
      continue;
    }
    const days = (Date.parse(r.periodEnd) - Date.parse(r.periodStart)) / 86_400_000;
    if (!(days > 0)) {
      incomplete = true;
      continue;
    }
    usd += (r.amountMinor / 100) * (MONTH_DAYS / days);
  }
  return { usd: any ? usd : null, subscribers: subs.size, incomplete };
}

/**
 * Subscribers at the start of a window who were still billed at its end; the rest churned. Null when fewer than
 * MIN_CHURN_BASE subscribers were there to start with: a churn rate from three people is a coin toss, and the page says
 * "not enough data" instead.
 */
export const MIN_CHURN_BASE = 5;
export function churn(rows: MoneyRow[], p: Pick<Period, "from" | "to">): { base: number; churned: number; rate: number | null } {
  const covering = (at: string) => {
    const s = new Set<string>();
    for (const r of rows) {
      if (r.event === "sale" && r.kind === "plan" && !r.internal && r.periodStart && r.periodEnd && r.periodStart <= at && at < r.periodEnd) {
        s.add(r.subscriptionRef ?? r.paymentRef);
      }
    }
    return s;
  };
  const start = covering(p.from);
  // "Still billed at the end": a period that covers the last instant of the window.
  const end = covering(new Date(Date.parse(p.to) - 1).toISOString());
  let churned = 0;
  for (const s of start) if (!end.has(s)) churned++;
  return { base: start.size, churned, rate: start.size >= MIN_CHURN_BASE ? churned / start.size : null };
}

/**
 * LTV, an ESTIMATE: monthly revenue per paying workspace divided by monthly churn. Null — and the page says why — when churn
 * is not measurable yet or none was observed (dividing by zero churn is an infinite customer, not a number).
 */
export function ltvEstimate(arppuMonthly: number | null, monthlyChurn: number | null): number | null {
  if (arppuMonthly === null || monthlyChurn === null || monthlyChurn <= 0) return null;
  return arppuMonthly / monthlyChurn;
}

export interface MoneyPoint {
  x: string;
  gross: number | null;
  refunds: number | null;
  net: number | null;
}

/** The key of the bucket a Tashkent day falls in: the day, the Monday of its week, or the first of its month. */
export function bucketKey(day: string, bucket: Bucket): string {
  if (bucket === "day") return day;
  if (bucket === "month") return `${day.slice(0, 7)}-01`;
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
}

/** Every bucket key of a period, in order, so an empty day is drawn as 0 sales — which it is, because the period was read. */
export function bucketKeys(p: Pick<Period, "startDay" | "endDay" | "days">): string[] {
  const bucket = bucketFor(p.days);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let t = Date.parse(`${p.startDay}T00:00:00Z`); t <= Date.parse(`${p.endDay}T00:00:00Z`); t += 86_400_000) {
    const k = bucketKey(new Date(t).toISOString().slice(0, 10), bucket);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** Gross, refunds and net (before fees) per bucket, USD only. A bucket with an unknown amount reads null, not its known part. */
export function moneySeries(rows: MoneyRow[], p: Period): MoneyPoint[] {
  const bucket = bucketFor(p.days);
  const keys = bucketKeys(p);
  const acc = new Map(keys.map((k) => [k, { gross: 0 as number | null, refunds: 0 as number | null }]));
  for (const r of rows) {
    if (!inWindow(r, p) || r.internal || !isUsd(r)) continue;
    const k = bucketKey(tashkentDay(new Date(r.at)), bucket);
    const a = acc.get(k);
    if (!a) continue;
    if (r.event === "sale") a.gross = a.gross === null || r.amountMinor === null ? null : a.gross + r.amountMinor / 100;
    else a.refunds = a.refunds === null || r.amountMinor === null ? null : a.refunds + r.amountMinor / 100;
  }
  return keys.map((x) => {
    const a = acc.get(x)!;
    return { x, gross: a.gross, refunds: a.refunds, net: a.gross === null || a.refunds === null ? null : a.gross - a.refunds };
  });
}
