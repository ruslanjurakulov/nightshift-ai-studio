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
/** "uncredited": money a provider reported as paid that the webhook did not credit (a plan change, another currency…). */
export type MoneyEvent = "sale" | "refund" | "dispute" | "uncredited";
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
    if (event !== "sale" && event !== "refund" && event !== "dispute" && event !== "uncredited") continue;
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

// Instants are compared as instants: PostgREST writes "+00:00" and JavaScript ".000Z", and as strings "+" sorts before ".".
export const inWindow = (r: { at: string }, p: Pick<Period, "from" | "to">) => {
  const t = Date.parse(r.at);
  return t >= Date.parse(p.from) && t < Date.parse(p.to);
};
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
  /** Internal and test workspaces: left out of everything above (unless the owner chose to include them). */
  internalExcluded: number;
  /** Paid but not credited by the webhook: real money, kept out of gross so gross stays "what was sold", and stated apart. */
  uncredited: { count: number; usd: Amount; otherCurrency: number };
  payingOrgs: number;
  /** Paying workspaces whose payments were in USD: the denominator that matches a USD revenue figure. */
  payingOrgsUsd: number;
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
    uncredited: { count: 0, usd: zero(), otherCurrency: 0 },
    payingOrgs: 0,
    payingOrgsUsd: 0,
  };
  const items = new Map<string, ItemSales>();
  const other = new Map<string, { currency: string; count: number; minor: number | null }>();
  const payers = new Set<string>();
  const usdPayers = new Set<string>();
  for (const r of rows) {
    if (!inWindow(r, p)) continue;
    if (r.internal) {
      s.internalExcluded++;
      continue;
    }
    if (r.event === "uncredited") {
      s.uncredited.count++;
      if (isUsd(r)) add(s.uncredited.usd, r);
      else s.uncredited.otherCurrency++;
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
      if (r.orgRef) {
        payers.add(r.orgRef);
        usdPayers.add(r.orgRef);
      }
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
  s.payingOrgsUsd = usdPayers.size;
  return s;
}

/**
 * How many months a billed period is, by its length: a monthly plan billed for February (28 days) is one month, not 0.92 of one.
 * A length that is not a recognisable interval is null — that payment makes MRR incomplete rather than a guessed fraction.
 */
export function billedMonths(periodStart: string, periodEnd: string): number | null {
  const days = (Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000;
  if (days >= 27 && days <= 32) return 1;
  if (days >= 88 && days <= 93) return 3;
  if (days >= 180 && days <= 186) return 6;
  if (days >= 360 && days <= 371) return 12;
  return null;
}

/**
 * Payments that were taken back: a dispute, or refunds that add up to the whole sale. Such a period no longer earns, so it is
 * not MRR and not a retained subscriber. A refund with no amount leaves the payment UNCERTAIN: it may or may not be whole.
 */
export function reversals(rows: MoneyRow[]): { full: Set<string>; uncertain: Set<string> } {
  const sale = new Map<string, number | null>();
  const back = new Map<string, number | null>();
  const full = new Set<string>();
  for (const r of rows) {
    if (r.event === "sale") sale.set(r.paymentRef, r.amountMinor);
    else if (r.event === "dispute") full.add(r.paymentRef);
    else if (r.event === "refund") {
      const b = back.get(r.paymentRef);
      back.set(r.paymentRef, b === null || r.amountMinor === null ? null : (b ?? 0) + r.amountMinor);
    }
  }
  const uncertain = new Set<string>();
  for (const [ref, amount] of back) {
    if (full.has(ref)) continue;
    const paid = sale.get(ref);
    if (amount === null || paid === null || paid === undefined) uncertain.add(ref);
    else if (amount >= paid) full.add(ref);
  }
  return { full, uncertain };
}

const covers = (r: MoneyRow, at: number) =>
  r.periodStart !== null && r.periodEnd !== null && Date.parse(r.periodStart) <= at && at < Date.parse(r.periodEnd);

/**
 * MRR at an instant: every plan payment whose billed period covers `at`, divided by the months that period bills (a yearly
 * plan is a twelfth of its price a month). Gross of tax, as the provider reported it. A payment that was taken back does not
 * count. Null when no plan payment exists at all (nothing measured), so the page says "no subscriptions yet" rather than
 * "$0 MRR"; `incomplete` when a covering payment had no amount, another currency, an interval we cannot read, or a refund of
 * unknown size.
 */
export function mrrAt(rows: MoneyRow[], at: string): { usd: number | null; subscribers: number; incomplete: boolean } {
  let usd = 0;
  let any = false;
  let incomplete = false;
  const subs = new Set<string>();
  const t = Date.parse(at);
  const rev = reversals(rows);
  for (const r of rows) {
    if (r.event !== "sale" || r.kind !== "plan" || r.internal) continue;
    any = true;
    if (!covers(r, t) || rev.full.has(r.paymentRef)) continue;
    subs.add(r.subscriptionRef ?? r.paymentRef);
    const months = billedMonths(r.periodStart!, r.periodEnd!);
    if (r.amountMinor === null || !isUsd(r) || months === null || rev.uncertain.has(r.paymentRef)) {
      incomplete = true;
      if (r.amountMinor === null || !isUsd(r) || months === null) continue;
    }
    usd += r.amountMinor / 100 / months;
  }
  return { usd: any ? usd : null, subscribers: subs.size, incomplete };
}

/**
 * Subscribers at the start of a window who were still billed at its end; the rest churned. A payment taken back does not
 * keep anyone subscribed. Null when fewer than MIN_CHURN_BASE subscribers were there to start with: a churn rate from three
 * people is a coin toss, and the page says "not enough data" instead.
 */
export const MIN_CHURN_BASE = 5;
export function churn(rows: MoneyRow[], p: Pick<Period, "from" | "to">): { base: number; churned: number; rate: number | null } {
  const rev = reversals(rows);
  const covering = (at: number) => {
    const s = new Set<string>();
    for (const r of rows) {
      if (r.event === "sale" && r.kind === "plan" && !r.internal && !rev.full.has(r.paymentRef) && covers(r, at)) {
        s.add(r.subscriptionRef ?? r.paymentRef);
      }
    }
    return s;
  };
  const start = covering(Date.parse(p.from));
  // "Still billed at the end": a period that covers the last instant of the window.
  const end = covering(Date.parse(p.to) - 1);
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
    if (r.event === "uncredited") continue;
    if (r.event === "sale") a.gross = a.gross === null || r.amountMinor === null ? null : a.gross + r.amountMinor / 100;
    else a.refunds = a.refunds === null || r.amountMinor === null ? null : a.refunds + r.amountMinor / 100;
  }
  return keys.map((x) => {
    const a = acc.get(x)!;
    return { x, gross: a.gross, refunds: a.refunds, net: a.gross === null || a.refunds === null ? null : a.gross - a.refunds };
  });
}

/**
 * The rows a figure is computed from. By default internal and test workspaces stay flagged and every function leaves them out
 * (and counts what it left out); with `include`, the owner asked to see them, so they are counted like anyone else's.
 */
export function applyScope<T extends { internal: boolean }>(rows: T[], include: boolean): T[] {
  return include ? rows.map((r) => (r.internal ? { ...r, internal: false } : r)) : rows;
}
