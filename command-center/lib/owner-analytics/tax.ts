/**
 * The owner's income register: inputs for an accountant, never a declaration (migration 0185 for the frozen rates). Pure.
 *
 * One row per money event in the period — a sale, a refund, a dispute — in the payment's own currency, with its UZS equivalent
 * ONLY where the owner froze a rate for that day and currency. A row without a rate says "no rate stored"; a monthly or
 * quarterly UZS total that depends on one is null (incomplete), never a total of the rows that happened to have a rate.
 * Provider fees are not stored by either webhook: "unknown". Customer country is not stored: "not recorded".
 */

import type { Dictionary } from "@/lib/i18n";
import type { Table } from "./export";
import { fill, tashkentDateTime } from "./format";
import { known, type MoneyRow } from "./money";
import { inWindow } from "./money";
import { TIMEZONE, tashkentDay, type Period } from "./period";

type D = Dictionary["ownerAnalytics"];

export interface FxRate {
  day: string;
  currency: string;
  uzsPerUnit: number;
  source: string;
  /** When the owner froze it; a file exported before a later correction carries the earlier rate. */
  enteredAt: string | null;
}

export function coerceFxRates(data: unknown): FxRate[] {
  if (!Array.isArray(data)) return [];
  const out: FxRate[] = [];
  for (const r of data) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const day = typeof o.rate_date === "string" ? o.rate_date.slice(0, 10) : "";
    const rate = known(o.uzs_per_unit);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof o.currency !== "string" || rate === null || rate <= 0) continue;
    out.push({
      day,
      currency: o.currency,
      uzsPerUnit: rate,
      source: typeof o.source === "string" ? o.source : "",
      enteredAt: typeof o.entered_at === "string" ? o.entered_at : null,
    });
  }
  return out;
}

/**
 * How many decimal places a currency's minor unit has (ISO 4217). The providers send amounts in the minor unit — cents for USD,
 * whole yen for JPY, fils (a thousandth) for KWD — so dividing everything by 100 would put a yen payment in the register at a
 * hundredth of itself. A currency not listed here is not guessed at: its amounts are unknown.
 */
const EXPONENT: Record<string, number> = {
  // two decimals
  USD: 2, EUR: 2, GBP: 2, CHF: 2, CAD: 2, AUD: 2, NZD: 2, SGD: 2, HKD: 2, CNY: 2, INR: 2, RUB: 2, KZT: 2, UZS: 2, TRY: 2,
  AED: 2, SAR: 2, QAR: 2, ILS: 2, EGP: 2, ZAR: 2, BRL: 2, MXN: 2, ARS: 2, COP: 2, PLN: 2, CZK: 2, HUF: 2, RON: 2, SEK: 2,
  NOK: 2, DKK: 2, UAH: 2, GEL: 2, AZN: 2, AMD: 2, KGS: 2, TJS: 2, PHP: 2, THB: 2, MYR: 2, IDR: 2, PKR: 2, BDT: 2, NGN: 2,
  KES: 2, TWD: 2, MAD: 2,
  // no decimals
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, PYG: 0, UGX: 0, XAF: 0, XOF: 0, RWF: 0, KMF: 0, GNF: 0, DJF: 0, VUV: 0, XPF: 0,
  // three decimals
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, LYD: 3, IQD: 3,
};

/** Minor units to major units, or null when the amount or its currency's exponent is unknown. */
export function majorUnits(amountMinor: number | null, currency: string | null): number | null {
  if (amountMinor === null || !currency) return null;
  const e = EXPONENT[currency.toUpperCase()];
  return e === undefined ? null : amountMinor / 10 ** e;
}

export interface RegisterRow {
  at: string;
  day: string;
  event: MoneyRow["event"];
  paymentRef: string;
  provider: string;
  currency: string | null;
  /** In the payment's currency, major units. A sale fills gross (refund 0); a refund or dispute fills refund (gross 0), and
   *  net is gross − refund, so a refund's net is negative and the net column adds up. */
  gross: number | null;
  refund: number | null;
  net: number | null;
  rate: FxRate | null;
  uzs: number | null;
}

/** The register's rows: sales, refunds and disputes in the period. Paid-but-uncredited money is listed too — it is income. */
export function registerRows(money: MoneyRow[], rates: FxRate[], p: Pick<Period, "from" | "to">): RegisterRow[] {
  const byKey = new Map(rates.map((r) => [`${r.day}|${r.currency}`, r]));
  return money
    .filter((r) => !r.internal && inWindow(r, p))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((r) => {
      const day = tashkentDay(new Date(r.at));
      const amount = majorUnits(r.amountMinor, r.currency);
      const isIncome = r.event === "sale" || r.event === "uncredited";
      const gross = isIncome ? amount : 0;
      const refund = isIncome ? 0 : amount === null ? null : amount;
      const net = gross === null || refund === null ? null : gross - refund;
      const rate = r.currency ? (byKey.get(`${day}|${r.currency}`) ?? null) : null;
      return {
        at: r.at,
        day,
        event: r.event,
        paymentRef: r.paymentRef,
        provider: r.provider,
        currency: r.currency,
        gross,
        refund,
        net,
        rate,
        uzs: net !== null && rate ? Math.round(net * rate.uzsPerUnit * 100) / 100 : null,
      };
    });
}

export interface RegisterTotal {
  key: string;
  /** Net per currency in the payment's own currency; null when an amount behind it is unknown. */
  byCurrency: Array<{ currency: string; net: number | null; rows: number }>;
  /** Net in UZS; null unless every row of the group has an amount and a frozen rate. */
  uzs: number | null;
  rowsWithoutRate: number;
}

function groupTotals(rows: RegisterRow[], keyOf: (r: RegisterRow) => string): RegisterTotal[] {
  const groups = new Map<string, RegisterRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  return [...groups.entries()].map(([key, rs]) => {
    const cur = new Map<string, { net: number | null; rows: number }>();
    let uzs: number | null = 0;
    let rowsWithoutRate = 0;
    for (const r of rs) {
      const c = r.currency ?? "?";
      const t = cur.get(c) ?? { net: 0, rows: 0 };
      t.net = t.net === null || r.net === null ? null : t.net + r.net;
      t.rows++;
      cur.set(c, t);
      if (r.uzs === null) {
        uzs = null;
        if (!r.rate) rowsWithoutRate++;
      } else if (uzs !== null) uzs += r.uzs;
    }
    return {
      key,
      byCurrency: [...cur.entries()].map(([currency, t]) => ({ currency, ...t })),
      uzs: uzs === null ? null : Math.round(uzs * 100) / 100,
      rowsWithoutRate,
    };
  });
}

export const monthlyTotals = (rows: RegisterRow[]) => groupTotals(rows, (r) => r.day.slice(0, 7));
export const quarterlyTotals = (rows: RegisterRow[]) =>
  groupTotals(rows, (r) => `${r.day.slice(0, 4)}-Q${Math.floor((Number(r.day.slice(5, 7)) - 1) / 3) + 1}`);

function preamble(d: D, title: string, p: Period, present: boolean): string[] {
  return [
    fill(d.reportTitle, { title }),
    `${d.period}: ${p.startDay} — ${p.endDay} (${TIMEZONE})`,
    d.taxNotADeclaration,
    d.taxFxNote,
    ...(present ? [d.presentOn] : []),
  ];
}

export function registerTable(d: D, rows: RegisterRow[], p: Period, present: boolean): Table {
  const ev = (e: RegisterRow["event"]) =>
    e === "sale" ? d.eventSale : e === "refund" ? d.eventRefund : e === "dispute" ? d.eventDispute : d.eventUncredited;
  return {
    name: d.taxRegister,
    preamble: preamble(d, d.taxRegister, p, present),
    columns: [
      d.date,
      d.event,
      ...(present ? [] : [d.payment]),
      d.provider,
      d.customerCountry,
      d.currency,
      d.gross,
      d.refunds,
      d.fees,
      d.netTax,
      d.fxRate,
      d.fxSource,
      d.uzsAmount,
    ],
    rows: rows.map((r) => [
      tashkentDateTime(r.at),
      ev(r.event),
      ...(present ? [] : [r.paymentRef]),
      r.provider,
      d.notRecorded,
      r.currency ?? d.unknown,
      r.gross,
      r.refund,
      null,
      r.net,
      r.rate ? r.rate.uzsPerUnit : null,
      r.rate ? `${r.rate.source} (${r.rate.day})` : d.noRateStored,
      r.uzs,
    ]),
  };
}

export function totalsTable(d: D, totals: RegisterTotal[], name: string, p: Period, present: boolean): Table {
  const rows: Table["rows"] = [];
  for (const t of totals) {
    for (const c of t.byCurrency) {
      // The UZS total and the count of rows without a rate belong to the period, not to a currency: they are written on its
      // first line and the other lines say "see above" rather than leaving a blank the page would read as unknown.
      const first = t.byCurrency[0] === c;
      rows.push([t.key, c.currency, c.rows, c.net, first ? t.uzs : d.includedAbove, first ? t.rowsWithoutRate : d.includedAbove]);
    }
  }
  return {
    name,
    preamble: preamble(d, name, p, present),
    columns: [d.taxPeriodKey, d.currency, d.count, d.netTax, d.uzsAmount, d.rowsWithoutRate],
    rows,
  };
}
