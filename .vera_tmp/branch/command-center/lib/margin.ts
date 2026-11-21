/**
 * The operator's margin report (migration 0063): the shapes the page reads,
 * and the rules for putting them on screen. Pure: no server imports.
 *
 * The database decides every number; this file only refuses to invent one.
 * operator_margin_report() returns NULL for anything it cannot know (a cost
 * nobody priced, credits whose purchase price is not on record, a job paid
 * from the API balance) and a number only where it can stand behind it, so a
 * null here is carried all the way to the screen as "unpriced" — never read as
 * 0, never dropped from a total so that the total looks complete (CLAUDE.md #5).
 */

export const MARGIN_FLAGS = [
  "released_jobs",
  "unpriced_cost",
  "unvalued_credits",
  "api_balance_jobs",
  "free_credits",
  "internal_jobs",
] as const;
export type MarginFlag = (typeof MARGIN_FLAGS)[number];

export function isMarginFlag(v: unknown): v is MarginFlag {
  return typeof v === "string" && (MARGIN_FLAGS as readonly string[]).includes(v);
}

export interface MarginRow {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  model: string;
  capability: string;
  jobsCompleted: number;
  /** Failed, cancelled or expired: no revenue, credits released. */
  jobsReleased: number;
  /** The operator's own organization: counted, never in revenue or cost. */
  jobsInternal: number;
  creditsSold: number;
  creditsReleased: number;
  creditsPaid: number;
  creditsFree: number;
  creditsUnvalued: number;
  /** null = unpriced: some credit could not be valued, or a job was paid from the API balance. */
  revenueUsd: number | null;
  /** Provider cost of the completed jobs; null = a cost is unpriced or was never recorded. */
  providerUsd: number | null;
  /** Provider cost of the released jobs: money spent that earned nothing. */
  providerUsdReleased: number | null;
  jobsUncosted: number;
  jobsReleasedUncosted: number;
  marginUsd: number | null;
  marginPct: number | null;
  flags: MarginFlag[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A known number, or null. null/undefined/"" never become 0. */
function known(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A count or credit total, which the database always supplies; a missing one is 0 only here, where 0 means "none counted". */
function count(v: unknown): number {
  return known(v) ?? 0;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Rows from operator_margin_report() as typed rows; anything malformed is dropped, not guessed. */
export function coerceMarginRows(data: unknown): MarginRow[] {
  if (!Array.isArray(data)) return [];
  const out: MarginRow[] = [];
  for (const r of data) {
    if (!isObj(r)) continue;
    const day = typeof r.day === "string" ? r.day.slice(0, 10) : "";
    if (!DAY_RE.test(day) || typeof r.model !== "string" || typeof r.capability !== "string") continue;
    out.push({
      day,
      model: r.model,
      capability: r.capability,
      jobsCompleted: count(r.jobs_completed),
      jobsReleased: count(r.jobs_released),
      jobsInternal: count(r.jobs_internal),
      creditsSold: count(r.credits_sold),
      creditsReleased: count(r.credits_released),
      creditsPaid: count(r.credits_paid),
      creditsFree: count(r.credits_free),
      creditsUnvalued: count(r.credits_unvalued),
      revenueUsd: known(r.revenue_usd),
      providerUsd: known(r.provider_usd),
      providerUsdReleased: known(r.provider_usd_released),
      jobsUncosted: count(r.jobs_uncosted),
      jobsReleasedUncosted: count(r.jobs_released_uncosted),
      marginUsd: known(r.margin_usd),
      marginPct: known(r.margin_pct),
      flags: Array.isArray(r.flags) ? r.flags.filter(isMarginFlag) : [],
    });
  }
  return out;
}

export interface MarginTotals {
  jobsCompleted: number;
  jobsReleased: number;
  creditsSold: number;
  creditsReleased: number;
  /** null as soon as ANY row's figure is unknown: a partial sum reads as the whole. */
  revenueUsd: number | null;
  providerUsd: number | null;
  providerUsdReleased: number | null;
  marginUsd: number | null;
  marginPct: number | null;
  /** Rows whose revenue or cost is unknown, so the header can say how much is missing. */
  unpricedRows: number;
}

function sumKnown(values: (number | null)[]): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/** Totals over the visible rows. Credits and job counts always add; money adds only when every row knows its own. */
export function marginTotals(rows: readonly MarginRow[]): MarginTotals {
  const revenueUsd = rows.length ? sumKnown(rows.map((r) => r.revenueUsd)) : 0;
  const providerUsd = rows.length ? sumKnown(rows.map((r) => r.providerUsd)) : 0;
  const providerUsdReleased = rows.length ? sumKnown(rows.map((r) => r.providerUsdReleased)) : 0;
  const marginUsd = revenueUsd !== null && providerUsd !== null ? revenueUsd - providerUsd : null;
  return {
    jobsCompleted: rows.reduce((a, r) => a + r.jobsCompleted, 0),
    jobsReleased: rows.reduce((a, r) => a + r.jobsReleased, 0),
    creditsSold: rows.reduce((a, r) => a + r.creditsSold, 0),
    creditsReleased: rows.reduce((a, r) => a + r.creditsReleased, 0),
    revenueUsd,
    providerUsd,
    providerUsdReleased,
    marginUsd,
    marginPct: marginUsd !== null && revenueUsd !== null && revenueUsd > 0 ? (marginUsd / revenueUsd) * 100 : null,
    unpricedRows: rows.filter((r) => r.revenueUsd === null || r.providerUsd === null).length,
  };
}

/** How one margin cell reads: a number, "unpriced" (an input is unknown), or "no revenue" (known, but a percentage of nothing). */
export type MarginCell = { kind: "value"; pct: number } | { kind: "unpriced" } | { kind: "no_revenue" };

export function marginCell(row: Pick<MarginRow, "revenueUsd" | "providerUsd" | "marginPct">): MarginCell {
  if (row.marginPct !== null) return { kind: "value", pct: row.marginPct };
  if (row.revenueUsd === null || row.providerUsd === null) return { kind: "unpriced" };
  return { kind: "no_revenue" };
}

export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];
export const DEFAULT_PERIOD: Period = 30;

/** The period a `?days=` names; anything else is the default, never an unbounded range. */
export function parsePeriod(raw: string | string[] | undefined): Period {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  return (PERIODS as readonly number[]).includes(n) ? (n as Period) : DEFAULT_PERIOD;
}

/** The UTC date range, inclusive, that ends today: what operator_margin_report(p_from, p_to) takes. */
export function periodRange(days: Period, now: Date = new Date()): { from: string; to: string } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return { from: day(from), to: day(to) };
}

/** Dollars as a person reads them: cents for amounts of a dollar or more, four places below that where a model's per-job cost lives. null is the caller's to label. */
export function formatUsd(v: number): string {
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  return `${sign}$${a >= 1 || a === 0 ? a.toFixed(2) : a.toFixed(4)}`;
}
