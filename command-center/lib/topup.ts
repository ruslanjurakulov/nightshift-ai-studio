import type { BillingSummary } from "@/lib/plans";

/**
 * Buying extra credits on top of a plan. Owner decisions: any credit count, no fixed packs (2026-11-21); an ADD-ON for
 * subscribers only, and never cheaper per credit than any plan's own credit (2026-11-22). Plan credits expire at the
 * period end and a top-up credit lasts longer, so every rate here is above the dearest plan's own credit:
 *
 *   1 000 – 4 999 credits   1.2 US cents each   (1 000 for $12.00, the minimum order)
 *   5 000 – 19 999          1.1 cents each
 *   20 000 and more         1.0 cent each
 *
 * One purchase is at most $1 000 (100 000 credits); above that the page says "contact us" and opens no checkout.
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
    { fromCredits: 1000, tenthCents: 12 },
    { fromCredits: 5000, tenthCents: 11 },
    { fromCredits: 20000, tenthCents: 10 },
  ],
} as const;

/** The most credits one purchase can buy (100 000 at the top rate). */
export const TOPUP_MAX_CREDITS = Math.floor((TOPUP.maxCents * 10) / TOPUP.tiers[TOPUP.tiers.length - 1].tenthCents);

/**
 * Whether this organization may buy extra credits (owner decision 2026-11-22: an add-on for subscribers only). Only while
 * it has a live subscription (active, trialing or past due) to a PAID plan, read from billing_summary() (0034) through
 * readBillingSummary, the same read the Credits and Billing pages show the plan from. The plan the database resolves for
 * the organization must be that subscription's plan and not the default (free) one, so a cancelled, paused or free
 * workspace is "no_plan". A failed read, or a database without 0034, is "unknown": the checkout opens nothing and the page
 * claims nothing then (rule 5), rather than reading an unread plan as either answer.
 */
export type TopupEligibility = "subscriber" | "no_plan" | "unknown";

export function topupEligibility(
  read: { state: "ok"; value: BillingSummary | null } | { state: "unsupported" } | { state: "failed" },
): TopupEligibility {
  if (read.state !== "ok") return "unknown";
  const s = read.value;
  if (!s || !s.subscription?.live || !s.plan || s.plan.isDefault || s.plan.id !== s.subscription.planId) return "no_plan";
  return "subscriber";
}

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
 * format error, never coerced into some other purchase. Cents are rounded half up (19 999 × 1.1¢ = 21 998.9¢ -> 21 999¢);
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
  if (!/^\d+$/.test(s)) return null;
  // Ten digits or more is a whole number far above the cap, not "not a number": it must reach the contact-us block, and
  // Number() of a long digit string is no safe integer (topupQuote would call it a format error). The largest safe
  // integer stands for "more than one purchase can buy".
  if (s.length > 9) return Number.MAX_SAFE_INTEGER;
  return Number(s);
}

/** The order's item as signed into the checkout metadata and stored in the nonce row (0146): credits AND cents recorded. */
export function topupItemKey(q: { credits: number; cents: number }): string {
  return `pack:credits_${q.credits}_${q.cents}`;
}
