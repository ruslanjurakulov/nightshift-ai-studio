/**
 * The Credits page's purchase history (invoices) when Dodo sells: the rows migration 0154's dodo_purchase_history returns, read
 * into what the page may say. Client-safe and pure, so the page's words are tested without a database.
 *
 * Rule 5 governs every field: a value the database did not give is unknown and is shown as "—", never as a 0, a "paid" or a
 * pack name we guessed. The status is derived only from what was recorded (refunds processed by the webhook, a lost dispute);
 * a refund whose size we do not know is "refund recorded", never "partly" or "fully".
 */

import { DODO_CATALOG_PACKS, type DodoPackId } from "@/lib/dodo";

export type DodoPurchaseItem = { kind: "pack"; id: DodoPackId } | { kind: "amount"; cents: number } | { kind: "plan" } | null;

export type DodoPurchaseStatus = "paid" | "partly_refunded" | "refunded" | "refund_recorded" | "chargeback";

export interface DodoPurchaseRow {
  /** Dodo's payment id (pay_…): the order reference on Dodo's receipt, and what the invoice link asks for. */
  paymentId: string;
  item: DodoPurchaseItem;
  credits: number | null;
  /** What Dodo reported charged, tax included, in the currency's smallest unit. */
  amountMinor: number | null;
  currency: string | null;
  paidAt: string | null;
  status: DodoPurchaseStatus;
}

export type DodoHistoryRead = { state: "ok"; rows: DodoPurchaseRow[] } | { state: "unsupported" } | { state: "failed" };

const PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{3,64}$/;

/** The signed item as 0154 returns it: `pack:<catalog id>`, `pack:amount_<cents>`, `plan`; anything else is unknown. */
export function purchaseItem(raw: unknown): DodoPurchaseItem {
  if (raw === "plan") return { kind: "plan" };
  if (typeof raw !== "string") return null;
  const amount = /^pack:amount_([1-9][0-9]{0,8})$/.exec(raw);
  if (amount) return { kind: "amount", cents: Number(amount[1]) };
  const pack = /^pack:([a-z][a-z0-9_]{0,30})$/.exec(raw);
  const known = pack ? DODO_CATALOG_PACKS.find((p) => p.id === pack[1]) : undefined;
  return known ? { kind: "pack", id: known.id } : null;
}

/**
 * paid | partly_refunded | refunded | refund_recorded | chargeback, from the recorded refunds. A chargeback outranks a refund
 * (the money went back through the card network). A refund of unknown size, or of a payment whose amount is unknown, is
 * "refund recorded".
 */
export function purchaseStatus(amountMinor: number | null, refundedMinor: number, refundUnsized: boolean, chargeback: boolean): DodoPurchaseStatus {
  if (chargeback) return "chargeback";
  if (refundUnsized) return "refund_recorded";
  if (refundedMinor <= 0) return "paid";
  if (amountMinor === null || amountMinor <= 0) return "refund_recorded";
  return refundedMinor >= amountMinor ? "refunded" : "partly_refunded";
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function iso(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

/** The function's rows, each checked; a row without a valid payment id is dropped (it could not be named or invoiced). */
export function coercePurchaseRows(data: unknown): DodoPurchaseRow[] {
  if (!Array.isArray(data)) return [];
  const out: DodoPurchaseRow[] = [];
  for (const r of data as Record<string, unknown>[]) {
    if (!r || typeof r !== "object" || typeof r.payment_id !== "string" || !PAYMENT_ID_RE.test(r.payment_id)) continue;
    const amountMinor = num(r.amount_minor);
    const refunded = num(r.refunded_minor) ?? 0;
    out.push({
      paymentId: r.payment_id,
      item: purchaseItem(r.item),
      credits: num(r.credits),
      amountMinor,
      currency: typeof r.currency === "string" && /^[A-Z]{3}$/.test(r.currency) ? r.currency : null,
      paidAt: iso(r.paid_at),
      status: purchaseStatus(amountMinor, refunded, r.refund_unsized === true, r.chargeback === true),
    });
  }
  return out;
}

/** A PostgREST / Postgres error that means "0154 is not applied": the function does not exist. */
export function historyMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? "");
}
