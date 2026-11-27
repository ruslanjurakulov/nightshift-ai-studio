/**
 * The prepayment plan of the Billing page's top-up controls, run in the operator's browser as they change the days or the
 * cap. Pure and vendor-free (it sees provider ids and USD figures the server already computed), so the client components
 * import it from here and never from the server-only lib/billing.ts.
 */
import { splitCents } from "@/lib/stats";

export interface TopupPlanInput {
  id: string;
  /** USD burned per day, or null when used but unpriced. */
  usdPerDay: number | null;
  /** Current balance in USD, or null when unknown (treated as empty — the plan errs toward enough). */
  balanceUsd: number | null;
}

export interface TopupPlanLine {
  id: string;
  /** USD needed to cover `days` at the current burn, or null when unpriced. */
  need: number | null;
  /** USD to pay now, or null when unpriced (excluded from the total). */
  amount: number | null;
  /** The balance was unknown, so the need assumes an empty account. */
  balanceUnknown: boolean;
}

export interface TopupPlan {
  lines: TopupPlanLine[];
  /** Exactly the sum of the line amounts — what the operator will be charged in total. */
  total: number;
  /** The cap was lower than the need, so amounts were split proportionally. */
  scaled: boolean;
}

const cents = (v: number) => Math.round(v * 100);

/**
 * Plan a prepayment across the selected providers.
 *
 * need_i = max(0, burn_i × days − balance_i). With no cap every provider gets
 * its need (rounded up to the cent). With a cap below the total need, the cap
 * is split in proportion to each provider's need, to the cent, summing to the
 * cap exactly. Unpriced providers get no amount — the page asks for a price.
 */
export function planTopups(inputs: TopupPlanInput[], days: number, cap: number | null = null): TopupPlan {
  const lines: TopupPlanLine[] = inputs.map((p) => {
    if (p.usdPerDay === null) return { id: p.id, need: null, amount: null, balanceUnknown: p.balanceUsd === null };
    const need = Math.max(0, p.usdPerDay * Math.max(0, days) - (p.balanceUsd ?? 0));
    return { id: p.id, need, amount: Math.max(0, Math.ceil(need * 100 - 1e-9)) / 100, balanceUnknown: p.balanceUsd === null };
  });
  const priced = lines.filter((l) => l.need !== null);
  const needCents = priced.reduce((s, l) => s + (l.amount ?? 0) * 100, 0);
  let scaled = false;
  if (cap !== null && Number.isFinite(cap) && cap >= 0 && priced.length > 0 && cents(cap) < Math.round(needCents)) {
    scaled = true;
    const parts = splitCents(cents(cap), priced.map((l) => l.need ?? 0));
    priced.forEach((l, i) => (l.amount = parts[i] / 100));
  }
  const total = Math.round(priced.reduce((s, l) => s + (l.amount ?? 0) * 100, 0)) / 100;
  return { lines, total, scaled };
}
