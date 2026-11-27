/**
 * Vendor-free arithmetic shared by the Billing ledger, the credit estimates and the unit economics: percentiles, cent
 * splitting, days left, and reading the bot's UTC stamps.
 *
 * Deliberately not in lib/billing.ts: that module holds vendor billing URLs, a vendor's credit price and our routing map,
 * and is server-only. lib/credits.ts once imported `percentile` from it, which put the whole vendor table into the public
 * chunk of /, /login, /signup and /pricing. Nothing here may name a vendor or carry a price.
 */

const DAY_MS = 86_400_000;

/** Linear-interpolated percentile of `values` (0..1), or null for none. */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.min(1, Math.max(0, p)) * (xs.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

/** A stored stamp in ms. The bot writes UTC with no zone; a bare stamp is read as UTC, never as the server's local time. */
export function rowMs(recordedAt: string | null | undefined): number {
  const text = String(recordedAt ?? "");
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) || !text.includes("T") ? text : `${text}Z`);
}

/** The oldest `recorded_at` among the rows, in ms, or null. */
export function oldestRowMs(rows: { recorded_at: string }[]): number | null {
  let oldest: number | null = null;
  for (const r of rows) {
    const t = rowMs(r.recorded_at);
    if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
  }
  return oldest;
}

/**
 * Where this provider's own history starts, for the burn window: its first usage row, or its first top-up when that
 * came later (spend before the account was funded is not what the balance is spent at). Null with neither.
 */
export function providerHistoryStart(firstUse: number | null, firstTopup: number | null): number | null {
  if (firstUse !== null && firstTopup !== null) return Math.max(firstUse, firstTopup);
  return firstUse ?? firstTopup;
}

/**
 * Days until a balance is spent at the current burn. `"never"` when nothing is
 * being consumed; null when either side is unknown.
 */
export function daysLeft(balance: number | null, perDay: number | null): number | "never" | null {
  if (balance === null || perDay === null) return null;
  // A negative balance is not "0 days left": the books do not add up (see ledgerBalanceUsd), so it is unknown.
  if (balance < 0) return null;
  if (perDay <= 0) return "never";
  return balance / perDay;
}

export const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/**
 * Split `totalCents` across `weights` proportionally, in whole cents, so the
 * parts add up to exactly the total (largest-remainder rounding).
 */
export function splitCents(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  const ws = sum > 0 ? weights.map((w) => Math.max(0, w)) : weights.map(() => 1);
  const wsum = ws.reduce((s, w) => s + w, 0);
  if (wsum === 0 || totalCents <= 0) return weights.map(() => 0);
  const raw = ws.map((w) => (totalCents * w) / wsum);
  const floors = raw.map(Math.floor);
  let rest = totalCents - floors.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) floors[order[k][1]] += 1;
  return floors;
}

/** Days left at an expected volume: `share` of the last 7 days' daily spend (1 = the same, 2 = twice as much). */
export function runsOutAt(leftUsd: number | null, burn7d: number | null, share: number): number | "never" | null {
  if (burn7d === null || !(share >= 0)) return null;
  return daysLeft(leftUsd, burn7d * share);
}
