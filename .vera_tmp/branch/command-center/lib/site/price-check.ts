import { roundUpCredits } from "@/lib/credits";
import type { CreditPackId } from "@/lib/paddle";
import { displayPriceCents } from "@/lib/pricing";
import type { MoneyAnchor } from "@/lib/landing";

/**
 * The landing page's price check: the published per-minute rate times a length,
 * and nothing else. Every input is a number the pricing source holds
 * (lib/landing.ts moneyAnchor): the rate, the smallest quote and, only when the
 * smallest pack's price is a plain dollar amount, what a credit costs in
 * cents. Missing inputs stay missing; the component is not rendered without a
 * rate, so a default can never stand in for a price.
 */
export type PriceRates = {
  /** Credits per finished minute, as charged. */
  perMinute: number;
  /** The smallest quote of any run, or null when none is published. */
  minimum: number | null;
  /** Cents per credit at the smallest priced pack, or null when it is not a plain dollar price. */
  centsPerCredit: number | null;
  /** Which pack that price belongs to (the page names it next to the dollars). */
  pack: CreditPackId | null;
};

/** What a run of this length is quoted: length x rate, never under the minimum
 *  (the same rule as lib/credits.ts estimateRunCredits). */
export function quoteCredits(minutes: number, rates: Pick<PriceRates, "perMinute" | "minimum">): number {
  const raw = minutes * rates.perMinute;
  return roundUpCredits(rates.minimum !== null && rates.minimum > raw ? rates.minimum : raw);
}

/** The quote in cents at the pack's price, rounded to the cent; null without a dollar price. */
export function quoteCents(credits: number, rates: Pick<PriceRates, "centsPerCredit">): number | null {
  if (rates.centsPerCredit === null || !(rates.centsPerCredit > 0)) return null;
  return Math.max(1, Math.round(credits * rates.centsPerCredit));
}

/** The longest whole-minute video the welcome grant pays for, or null when it
 *  pays for none (a grant below the minimum is not "enough for a short one"). */
export function freeMinutes(welcome: number, rates: Pick<PriceRates, "perMinute" | "minimum">): number | null {
  const m = Math.floor(welcome / rates.perMinute);
  if (m < 1) return null;
  return quoteCredits(m, rates) <= welcome ? m : null;
}

/**
 * The rates the page may show, from the money anchor the landing already
 * computed: null unless a per-minute rate is published. Dollars only join in
 * when the smallest pack's price is a plain US-dollar amount (the anchor's own
 * rule: "€9" or "from $5" is never reinterpreted).
 */
export function priceRatesFrom(anchor: MoneyAnchor): PriceRates | null {
  if (!anchor.site) return null;
  let centsPerCredit: number | null = null;
  let pack: CreditPackId | null = null;
  if (anchor.pack.kind === "priced" && anchor.site.usd) {
    const cents = displayPriceCents(anchor.pack.price);
    if (cents !== null && anchor.pack.credits > 0) {
      centsPerCredit = cents / anchor.pack.credits;
      pack = anchor.pack.id;
    }
  }
  return { perMinute: anchor.site.perMinute, minimum: anchor.site.minimum, centsPerCredit, pack };
}
