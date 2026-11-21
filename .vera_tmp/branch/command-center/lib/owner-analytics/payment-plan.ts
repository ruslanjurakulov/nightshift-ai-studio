/**
 * The owner's provider payment plan: which API needs paying, by when, and how much keeps it running for the next N days.
 * Pure. Built on the provider runway (runway.ts), which is built on the Billing ledger, so the plan, the runway tab and Billing
 * agree on what is left.
 *
 * What it never does: pay, open a checkout, or pick a provider. It is a list the owner reads; every line carries the provider's
 * own top-up page, and says whether what is left was measured (the provider's reading) or estimated (top-ups minus spend).
 *
 * The amount is `days × the 14-day pace`, the owner's rule. It is rounded up to the provider's minimum top-up when one is known;
 * none is recorded in the platform today, so the line says "minimum not recorded" rather than inventing one. A provider whose
 * pace or balance is unknown is listed as such: an unknown is never a "nothing to pay".
 */

import { BILLED_PROVIDERS } from "@/lib/billing";
import type { ProviderRunway } from "./runway";

const DAY = 86_400_000;
export const PLAN_DAYS = 10;

export type Basis = "measured" | "estimated" | "unknown";

export interface PlanLine {
  provider: string;
  name: string;
  /** The provider's own billing / top-up page; null when none was verified (no guessed link). */
  topUpUrl: string | null;
  basis: Basis;
  /** What is left and the 14-day pace, in `unit` (USD, or the provider's own unit for a native reading — then `amount` is in
   *  that unit too, and the owner converts at the provider's own price). */
  left: number | null;
  perDay: number | null;
  unit: string;
  /** When it runs out at that pace (ISO day), "never" at a zero pace, null when unknown. */
  runsOutOn: string | "never" | null;
  /** Pay by this day (a day before it runs out), or now when it is already empty or runs out within a day. */
  payBy: string | null;
  /** days × pace, rounded up to the minimum top-up when known; null when the pace is unknown. */
  amount: number | null;
  minimumTopUp: number | null;
  /** Why the line is here: it is empty, runs out inside the plan, or cannot be judged. Days are UTC calendar days. */
  reason: "empty" | "runs_out" | "unknown" | "ok";
  /** The provider's reading time, or the ledger's — every line says when it is true. */
  asOf: string | null;
  autoRecharge: boolean;
}

export interface PaymentPlan {
  days: number;
  asOf: string;
  /** Providers to pay inside the plan, soonest first; then the ones that cannot be judged. */
  due: PlanLine[];
  unknown: PlanLine[];
  /** Providers that last beyond the plan. */
  fine: PlanLine[];
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function paymentPlan(rows: ProviderRunway[], nowMs: number, days = PLAN_DAYS, minimums: Record<string, number> = {}): PaymentPlan {
  const lines: PlanLine[] = rows.map((r) => {
    const p = BILLED_PROVIDERS.find((b) => b.id === r.id);
    const basis: Basis = r.left === null ? "unknown" : r.ledger.remaining.kind === "reported" ? "measured" : "estimated";
    const unit = r.nativeRunway ? (r.leftNative?.unit ?? "units") : "usd";
    const perDay = r.perDay14d;
    const daysLeft = r.left === null || perDay === null ? null : perDay <= 0 ? ("never" as const) : r.left / perDay;
    const runsOutOn = daysLeft === null ? null : daysLeft === "never" ? "never" : isoDay(nowMs + daysLeft * DAY);
    const minimum = minimums[r.id] ?? null;
    // The epsilon keeps float noise (10 × 0.07 = 0.7000000000000001) from rounding a cent up.
    const raw = perDay === null ? null : Math.ceil(days * perDay * 100 - 1e-6) / 100;
    const empty = r.status === "empty";
    // An empty provider with no recorded pace has no "days × pace" to pay: null (amount unknown), not a 0 that reads as "nothing".
    const amount =
      raw === null || (empty && raw <= 0) ? null : minimum !== null ? Math.max(minimum, Math.ceil(raw / minimum - 1e-9) * minimum) : raw;
    const reason: PlanLine["reason"] = empty
      ? "empty"
      : daysLeft === null || r.emptyUnchecked
        ? "unknown" // whether it already refuses for want of balance was not checked: never "fine"
        : daysLeft !== "never" && daysLeft < days && !r.autoRecharge
          ? "runs_out"
          : "ok";
    const payBy =
      reason === "empty" ? isoDay(nowMs) : reason === "runs_out" && typeof daysLeft === "number" ? isoDay(nowMs + Math.max(0, daysLeft - 1) * DAY) : null;
    return {
      provider: r.id,
      name: r.name,
      topUpUrl: p?.billingUrl ?? null,
      basis,
      left: r.left,
      perDay,
      unit,
      runsOutOn,
      payBy,
      amount,
      minimumTopUp: minimum,
      reason,
      asOf: r.checkedAt ?? new Date(nowMs).toISOString(),
      autoRecharge: r.autoRecharge,
    };
  });
  const byPayBy = (a: PlanLine, b: PlanLine) => (a.payBy ?? "9999").localeCompare(b.payBy ?? "9999") || a.name.localeCompare(b.name);
  return {
    days,
    asOf: new Date(nowMs).toISOString(),
    due: lines.filter((l) => l.reason === "empty" || l.reason === "runs_out").sort(byPayBy),
    unknown: lines.filter((l) => l.reason === "unknown").sort((a, b) => a.name.localeCompare(b.name)),
    fine: lines.filter((l) => l.reason === "ok").sort((a, b) => a.name.localeCompare(b.name)),
  };
}
