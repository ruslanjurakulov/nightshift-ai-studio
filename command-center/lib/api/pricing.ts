/**
 * The public API's money rules (migration 0031) — pure, client-safe, and the
 * TypeScript twin of the SQL: api_tier_for / api_tier_limits, api_video_price
 * and api_org_eligible. tests/api-pricing.test.ts pins the two together.
 *
 * The API is paid from its own prepaid balance in US cents, separate from the
 * site's credits. Its prices are the api_prices rows the owner sets (0031
 * seeds a fresh database with a starting list); nothing here holds a price —
 * a page or document that shows one reads the live list, and says no price
 * is published when it cannot.
 */

import { derivePlan, type LedgerPurchaseRow } from "@/lib/account";
import { isCreditExempt } from "@/lib/credits";
import { formatUsdAmount } from "@/lib/number-format";

/** The API terms an admin accepts on activation (shown with a link to /terms). */
export const API_TERMS_VERSION = "api-2026-09";

export const TOPUP_MIN_CENTS = 500;
export const TOPUP_MAX_CENTS = 500_000;

export interface ApiTier {
  tier: 0 | 1 | 2 | 3 | 4;
  /** Cumulative paid top-ups (net of refunds) that reach this tier. */
  minPaidCents: number;
  rpm: number;
  concurrency: number;
  monthlyCapCents: number;
}

/** Must equal api_tier_for / api_tier_limits in 0031. */
export const API_TIERS: readonly ApiTier[] = [
  { tier: 0, minPaidCents: 0, rpm: 10, concurrency: 1, monthlyCapCents: 0 },
  { tier: 1, minPaidCents: 500, rpm: 30, concurrency: 2, monthlyCapCents: 10_000 },
  { tier: 2, minPaidCents: 5_000, rpm: 60, concurrency: 3, monthlyCapCents: 50_000 },
  { tier: 3, minPaidCents: 25_000, rpm: 120, concurrency: 5, monthlyCapCents: 200_000 },
  { tier: 4, minPaidCents: 100_000, rpm: 300, concurrency: 10, monthlyCapCents: 1_000_000 },
];

export function tierFor(paidCents: number, exempt = false): ApiTier {
  if (exempt) return API_TIERS[4];
  let t = API_TIERS[0];
  for (const tier of API_TIERS) if (paidCents >= tier.minPaidCents) t = tier;
  return t;
}

export type ApiPriceMap = Record<string, number>;

/** api_prices rows -> a map; a row without a usable number is dropped, so
 *  that unit reads as unpriced rather than free. */
export function parseApiPrices(rows: unknown): ApiPriceMap {
  const out: ApiPriceMap = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const row = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const cents = typeof row.cents === "string" ? Number(row.cents) : row.cents;
    if (typeof row.unit === "string" && typeof cents === "number" && Number.isFinite(cents) && cents >= 0)
      out[row.unit] = cents;
  }
  return out;
}

/** What one video of `seconds` costs, in cents; null when unpriced. */
export function videoPriceCents(seconds: number | null | undefined, prices: ApiPriceMap): number | null {
  const perMinute = prices.video_minute;
  if (perMinute === undefined || !seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  const raw = Math.ceil(round6((seconds * perMinute) / 60));
  return Math.max(raw, Math.ceil(prices.job_minimum ?? 0));
}

/** An HD download through the API: the site's credit price x cents per credit. */
export function downloadPriceCents(siteCredits: number, prices: ApiPriceMap): number | null {
  const rate = prices.download_cents_per_credit;
  if (rate === undefined || !Number.isFinite(siteCredits) || siteCredits < 0) return null;
  return Math.ceil(round6(siteCredits * rate));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * May this organization activate the API? The operator's own organization, or
 * one that has bought any credit pack — read from its purchase rows exactly as
 * the account panel reads its plan (derivePlan): a purchase means a paid plan.
 * Since 0034 a plan with the api_access entitlement opens it too (the caller
 * passes that). Mirrors api_org_eligible() in 0031/0034, which is what decides.
 */
export function apiEligible(
  orgId: string | null | undefined,
  purchaseRows: readonly LedgerPurchaseRow[] | null,
  /** 0034: the organization's plan has the api_access entitlement. */
  apiAccess = false,
): boolean {
  if (isCreditExempt(orgId) || apiAccess) return true;
  const plan = derivePlan(purchaseRows);
  return plan.kind === "pack" || plan.kind === "purchased";
}

/** A top-up typed in dollars ("25", "25.50", "25,5") -> cents, or null when it
 *  is not a whole number of cents between $5 and $5,000. */
export function parseTopupDollars(text: string): number | null {
  const s = text.trim().replace(/^\$/, "").replace(",", ".");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents >= TOPUP_MIN_CENTS && cents <= TOPUP_MAX_CENTS ? cents : null;
}

/** An optional limit typed in dollars: "" -> null (no limit), else cents. */
export function parseLimitDollars(text: string): { ok: true; cents: number | null } | { ok: false } {
  const s = text.trim().replace(/^\$/, "").replace(",", ".");
  if (s === "") return { ok: true, cents: null };
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return { ok: false };
  return { ok: true, cents: Math.round(Number(s) * 100) };
}

export function formatUsd(cents: number | null | undefined, locale = "en"): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  // Always two decimals, laid out by table (lib/number-format.ts): the same text on the server and in the browser.
  return formatUsdAmount(cents / 100, locale, 2, 2);
}

/**
 * The Paddle transaction for a custom top-up: ONE non-catalog line under the
 * owner's "API balance top-up" product, in USD, for exactly the amount asked.
 * custom_data says who is paid for and that it is an API top-up; the webhook
 * credits what Paddle says was charged, never this request's word.
 */
export function topupTransactionBody(input: {
  orgId: string;
  userId: string;
  cents: number;
  productId: string;
}): Record<string, unknown> {
  return {
    items: [
      {
        quantity: 1,
        price: {
          description: "Nightshift API balance top-up",
          name: `API balance top-up ${(input.cents / 100).toFixed(2)} USD`,
          product_id: input.productId,
          unit_price: { amount: String(input.cents), currency_code: "USD" },
          tax_mode: "account_setting",
          quantity: { minimum: 1, maximum: 1 },
        },
      },
    ],
    currency_code: "USD",
    collection_mode: "automatic",
    custom_data: { org_id: input.orgId, user_id: input.userId, purpose: "api_topup" },
  };
}
