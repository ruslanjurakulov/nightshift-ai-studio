/**
 * Prepaid credits (migration 0020) — the pure half: prices, the Run now
 * estimate, and the shapes the Credits page reads.
 *
 * Pure and client-safe, so it is unit-tested directly (tests/credits.test.ts).
 * The server half that reads Supabase is lib/server/credits.ts. The Python twin
 * of the pricing rules — what a finished run is actually charged — is
 * modules/credits.py; keep the two in step.
 *
 * The rules carried over from the cost ledger, without exception:
 *
 *   - An unset price is UNPRICED, never 0. A video whose ledger has any entry
 *     without a credit price has no credit cost, and is left out of the
 *     estimate rather than counted at its priced floor.
 *   - When there is nothing honest to estimate with, the estimate is null and
 *     says why. Run now then refuses (when credits are enforced) and names the
 *     fix — it never reserves a guessed number.
 *   - Holds are rounded UP to the cent, as the database rounds them.
 */

import { percentile } from "@/lib/billing";
import { DEFAULT_ORG_ID } from "@/lib/orgs";
import type { VideoEconomics } from "@/lib/unitEconomics";
import { fmt, type Dictionary } from "@/lib/i18n";

export const UNIT_VIDEO_MINUTE = "video_minute";
export const UNIT_USD = "usd";
export const UNIT_JOB_MINIMUM = "job_minimum";
export const SPECIAL_UNITS = [UNIT_VIDEO_MINUTE, UNIT_USD, UNIT_JOB_MINIMUM] as const;

/** The cost ledger's units (modules/cost_ledger.py) — offered in the price editor. */
export const LEDGER_UNITS = [
  "gemini_input_tokens",
  "gemini_output_tokens",
  "tts_characters",
  "render_seconds",
  "pexels_requests",
  "upload_bytes",
  "video_gen_clips",
  "image_generations",
  "vision_calls",
] as const;

/** Mirrors the credit_prices_unit_check constraint. */
export const PRICE_UNIT_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const MAX_MARGIN = 10;
export const MAX_GRANT = 100_000_000;

/** The error code reserve_credits raises when available credits do not cover a hold. */
export const INSUFFICIENT_CREDITS_CODE = "NS402";

export interface CreditPrice {
  unit: string;
  creditsPerUnit: number;
  margin: number;
  note: string | null;
  updatedAt: string | null;
}

export type PriceMap = Record<string, CreditPrice>;

export interface CreditAccount {
  balance: number;
  reserved: number;
  available: number;
}

export type CreditTxnKind = "grant" | "purchase" | "reserve" | "capture" | "release" | "refund" | "adjust";

export interface CreditTransaction {
  id: number;
  kind: CreditTxnKind;
  amount: number;
  balanceAfter: number;
  reservedAfter: number;
  jobId: string | null;
  note: string | null;
  createdAt: string;
}

const KINDS: readonly string[] = ["grant", "purchase", "reserve", "capture", "release", "refund", "adjust"];

function finite(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** NIGHTSHIFT_CREDITS_ENFORCE — a server env var, off unless explicitly on. */
export function resolveCreditsEnforce(env: Record<string, string | undefined>): boolean {
  return ["1", "true", "yes", "on"].includes((env.NIGHTSHIFT_CREDITS_ENFORCE ?? "").trim().toLowerCase());
}

/** The operator's own organization never pays (0020 exempts it too). */
export function isCreditExempt(orgId: string | null | undefined): boolean {
  return orgId === DEFAULT_ORG_ID;
}

export function roundUpCredits(v: number): number {
  return Math.ceil(Math.round(v * 100 * 1e6) / 1e6) / 100;
}

/** credit_prices rows -> a map. A row with no usable rate is dropped, so that
 *  unit reads as unpriced rather than free. */
export function parsePrices(rows: unknown): PriceMap {
  const out: PriceMap = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const unit = typeof r.unit === "string" ? r.unit.trim() : "";
    const rate = finite(r.credits_per_unit);
    const margin = finite(r.margin);
    if (!unit || rate === null || rate < 0) continue;
    out[unit] = {
      unit,
      creditsPerUnit: rate,
      margin: margin !== null && margin >= 0 ? margin : 0,
      note: typeof r.note === "string" && r.note ? r.note : null,
      updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
    };
  }
  return out;
}

function charge(p: CreditPrice, quantity: number): number {
  return quantity * p.creditsPerUnit * (1 + p.margin);
}

/** Credits for one ledger quantity: its unit's own price, else the `usd` price
 *  of its priced dollar cost, else null (unpriced). */
export function entryCredits(
  e: { unit: string; quantity: number; usd: number | null },
  prices: PriceMap,
): number | null {
  if (!(SPECIAL_UNITS as readonly string[]).includes(e.unit) && prices[e.unit]) return charge(prices[e.unit], e.quantity);
  if (e.usd !== null && prices[UNIT_USD]) return charge(prices[UNIT_USD], e.usd);
  return null;
}

/** A finished video's credit cost from its ledger drivers; null when any is unpriced. */
export function videoCredits(v: Pick<VideoEconomics, "drivers">, prices: PriceMap): number | null {
  let total = 0;
  for (const d of v.drivers) {
    const c = entryCredits({ unit: d.unit, quantity: d.quantity, usd: d.usd }, prices);
    if (c === null) return null;
    total += c;
  }
  return total;
}

export type EstimateBasis = "per_minute" | "history_minute" | "history_video" | "unknown";
export type EstimateGap = "no_prices" | "no_length" | "no_history" | "unpriced_history";

export interface CreditEstimate {
  /** Credits to hold for this run, or null when there is no honest basis. */
  credits: number | null;
  basis: EstimateBasis;
  /** Past videos the estimate is built on (history bases only). */
  sample: number;
  /** True when the platform's job_minimum raised the estimate. */
  floorApplied: boolean;
  /** Why credits is null. */
  gap: EstimateGap | null;
}

/**
 * What to reserve before a run.
 *
 *   1. A `video_minute` price and a known length: minutes x price. The price
 *      list is the contract, so it wins over history.
 *   2. Otherwise this channel's recent fully credit-priced videos: the p90
 *      credits per finished minute times the length when both are known, else
 *      the p90 credits per video. p90, not the median — a hold is a ceiling on
 *      the charge, and a run that costs more than its hold is capped at it.
 *   3. Otherwise null, with the gap that explains it.
 *
 * The platform's `job_minimum` is a floor under whatever came out.
 */
export function estimateRunCredits(input: {
  prices: PriceMap;
  durationS: number | null;
  videos: Pick<VideoEconomics, "drivers" | "durationS">[];
}): CreditEstimate {
  const { prices } = input;
  const minutes = input.durationS && input.durationS > 0 ? input.durationS / 60 : null;
  const floor = prices[UNIT_JOB_MINIMUM]?.creditsPerUnit ?? null;

  const finish = (raw: number | null, basis: EstimateBasis, sample: number, gap: EstimateGap | null): CreditEstimate => {
    if (raw === null) return { credits: null, basis: "unknown", sample, floorApplied: false, gap };
    const floorApplied = floor !== null && floor > raw;
    return { credits: roundUpCredits(floorApplied ? floor : raw), basis, sample, floorApplied, gap: null };
  };

  const perMinute = prices[UNIT_VIDEO_MINUTE];
  if (perMinute && minutes !== null) return finish(charge(perMinute, minutes), "per_minute", 0, null);

  const hasLedgerPrices = Object.keys(prices).some((u) => u === UNIT_USD || !(SPECIAL_UNITS as readonly string[]).includes(u));
  if (!hasLedgerPrices) return finish(null, "unknown", 0, perMinute ? "no_length" : "no_prices");
  if (input.videos.length === 0) return finish(null, "unknown", 0, "no_history");

  const priced = input.videos.flatMap((v) => {
    const c = videoCredits(v, prices);
    return c === null ? [] : [{ credits: c, durationS: v.durationS }];
  });
  if (priced.length === 0) return finish(null, "unknown", 0, "unpriced_history");

  if (minutes !== null) {
    const rates = priced.flatMap((p) => (p.durationS && p.durationS > 0 ? [p.credits / (p.durationS / 60)] : []));
    const p90 = percentile(rates, 0.9);
    if (p90 !== null) return finish(p90 * minutes, "history_minute", rates.length, null);
  }
  return finish(percentile(priced.map((p) => p.credits), 0.9), "history_video", priced.length, null);
}

/** One credit_accounts row, or a zero account when the org has none yet — no
 *  row means no credits were ever added, which is a fact, not an unknown. */
export function coerceAccount(row: unknown): CreditAccount {
  const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const balance = finite(r.balance) ?? 0;
  const reserved = finite(r.reserved) ?? 0;
  return { balance, reserved, available: Math.max(0, balance - reserved) };
}

export function coerceTransactions(rows: unknown): CreditTransaction[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const id = finite(r.id);
    const amount = finite(r.amount);
    if (id === null || amount === null || typeof r.kind !== "string" || !KINDS.includes(r.kind)) return [];
    return [
      {
        id,
        kind: r.kind as CreditTxnKind,
        amount,
        balanceAfter: finite(r.balance_after) ?? 0,
        reservedAfter: finite(r.reserved_after) ?? 0,
        jobId: typeof r.job_id === "string" && r.job_id ? r.job_id : null,
        note: typeof r.note === "string" && r.note ? r.note : null,
        createdAt: typeof r.created_at === "string" ? r.created_at : "",
      },
    ];
  });
}

/** Did reserve_credits refuse for lack of credits? Reads "available=… needed=…". */
export function parseInsufficient(
  error: { code?: string; details?: string | null } | null | undefined,
): { available: number | null; needed: number | null } | null {
  if (!error || error.code !== INSUFFICIENT_CREDITS_CODE) return null;
  const m = /available=(-?[\d.]+)\s+needed=([\d.]+)/.exec(error.details ?? "");
  return { available: m ? Number(m[1]) : null, needed: m ? Number(m[2]) : null };
}

/** A reservation reference both runners accept (0020's job_id check). */
export function newCreditRef(prefix: "rj" | "gh", uuid: string): string {
  return `${prefix}-${uuid.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64)}`;
}

/** A grant amount as typed, or null when it is not a positive number of credits. */
export function parseGrantAmount(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_GRANT) return null;
  return roundUpCredits(n);
}

/** A price row as typed in the editor, or null with nothing saved. */
export function parsePriceInput(
  unit: string,
  rate: string,
  margin: string,
): { unit: string; credits_per_unit: number; margin: number } | null {
  const u = unit.trim().toLowerCase();
  const r = Number(rate.trim().replace(",", "."));
  const m = margin.trim() === "" ? 0 : Number(margin.trim().replace(",", "."));
  if (!PRICE_UNIT_RE.test(u) || !Number.isFinite(r) || r < 0 || !Number.isFinite(m) || m < 0 || m > MAX_MARGIN)
    return null;
  return { unit: u, credits_per_unit: r, margin: m };
}

/** Credits for display: up to two decimals, no trailing zeros. */
export function formatCredits(n: number | null | undefined, locale = "en"): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
}

/** Does this ledger row move the balance (vs. only the hold)? */
export function movesBalance(kind: CreditTxnKind): boolean {
  return kind !== "reserve" && kind !== "release";
}

/** The run's length: what the request asked for, else the channel's target. */
export function runDurationS(requested: number | undefined, agentConfig: unknown): number | null {
  if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) return requested;
  const cfg = (agentConfig && typeof agentConfig === "object" ? agentConfig : {}) as Record<string, unknown>;
  const t = cfg.target_duration_seconds;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * The message for a Run now refusal that is about credits, or null for any
 * other error (the caller keeps its own). When a hold was already taken and
 * the dispatch then failed, says that the hold comes back by itself — the
 * browser cannot release it, and nobody should think it was spent.
 */
export function creditRunError(data: Record<string, unknown>, t: Dictionary, locale = "en"): string | null {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  let text: string | null = null;
  switch (data.error) {
    case "insufficient_credits": {
      const needed = num(data.needed);
      const available = num(data.available);
      text =
        needed !== null && available !== null
          ? fmt(t.credits.insufficient, { needed: formatCredits(needed, locale), available: formatCredits(available, locale) })
          : t.credits.insufficientShort;
      break;
    }
    case "credit_estimate_unavailable": {
      const gap = typeof data.gap === "string" && data.gap in t.credits.gap ? t.credits.gap[data.gap as EstimateGap] : "";
      text = gap ? `${t.credits.estimateUnavailable} ${gap}` : t.credits.estimateUnavailable;
      break;
    }
    case "credits_unavailable":
      text = t.credits.unavailable;
      break;
    case "credits_not_enforced":
      text = t.credits.notEnforced;
      break;
  }
  if (num(data.credits_held) !== null) return `${text ?? t.agents.runFailed} ${t.credits.heldNote}`;
  return text;
}
