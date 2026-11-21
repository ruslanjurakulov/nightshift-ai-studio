/**
 * Buying any number of credits (owner decision 2026-11-21): no fixed packs on the Credits page, the customer types a
 * credit count, and the price per credit falls with volume at exactly the old packs' rates:
 *
 *   1 000 – 4 999 credits   1.0 US cent each   (Starter: 1 000 for $10)
 *   5 000 – 19 999          0.9 cent each      (Creator: 5 000 for $45)
 *   20 000 and more         0.8 cent each      (Studio: 20 000 for $160)
 *
 * One purchase is at most $1 000 (125 000 credits); above that the page says "contact us" and opens no checkout.
 *
 * This copy is what the page shows and what the checkout route signs. The webhook's copy (TOPUP in
 * supabase/functions/_shared/dodo.ts) checks the signed order; a test keeps the two equal. The browser only ever sends the
 * credit count: the price is computed here, on the server, and recorded in the order before Dodo is asked for anything.
 */

export const TOPUP = {
  minCredits: 1000,
  /** $1 000, in US cents. */
  maxCents: 100000,
  /** Rate in TENTHS of a US cent per credit, from the lowest volume up; integers so no float ever prices a purchase. */
  tiers: [
    { fromCredits: 1000, tenthCents: 10 },
    { fromCredits: 5000, tenthCents: 9 },
    { fromCredits: 20000, tenthCents: 8 },
  ],
  contactEmail: "ruslan@nightshift-ai.studio",
} as const;

/** The most credits one purchase can buy (125 000 at the top rate). */
export const TOPUP_MAX_CREDITS = Math.floor((TOPUP.maxCents * 10) / TOPUP.tiers[TOPUP.tiers.length - 1].tenthCents);

export type TopupQuote =
  | { ok: true; credits: number; cents: number; tenthCents: number }
  | { ok: false; reason: "format" | "below" | "above" };

/** The rate (tenths of a cent per credit) for a credit count already known to be >= the minimum. */
function tierFor(credits: number): number {
  let rate: number = TOPUP.tiers[0].tenthCents;
  for (const t of TOPUP.tiers) if (credits >= t.fromCredits) rate = t.tenthCents;
  return rate;
}

/**
 * The price of `credits`, or why there is none. Only a JSON integer is a credit count: "5000", 5000.5, NaN or 1e21 is a
 * format error, never coerced into some other purchase. Cents are rounded half up (19 999 × 0.9¢ = 17 999.1¢ -> 17 999¢);
 * everything is integer arithmetic, safe far beyond the cap.
 */
export function topupQuote(credits: unknown): TopupQuote {
  if (typeof credits !== "number" || !Number.isSafeInteger(credits) || credits < 0) return { ok: false, reason: "format" };
  if (credits < TOPUP.minCredits) return { ok: false, reason: "below" };
  // Above the cap is refused before multiplying, so a huge safe integer never reaches the product.
  if (credits > TOPUP_MAX_CREDITS) return { ok: false, reason: "above" };
  const tenthCents = tierFor(credits);
  const cents = Math.floor((credits * tenthCents + 5) / 10);
  if (cents > TOPUP.maxCents) return { ok: false, reason: "above" };
  return { ok: true, credits, cents, tenthCents };
}

/** What the person typed ("5000", "5 000", "5,000") -> a credit count, or null when it is not a whole number. */
export function parseCreditsText(text: string): number | null {
  let s = text.replace(/[\s  ]/g, "");
  // A comma only as a thousands separator in its place ("5,000"): "1000,5" or "5000.5" is a fraction, refused rather than
  // read as 10 005 or 50 005 credits.
  if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
  if (!/^\d{1,9}$/.test(s)) return null;
  return Number(s);
}

/** The order's item as signed into the checkout metadata and stored in the nonce row (0146): credits AND cents recorded. */
export function topupItemKey(q: { credits: number; cents: number }): string {
  return `pack:credits_${q.credits}_${q.cents}`;
}
