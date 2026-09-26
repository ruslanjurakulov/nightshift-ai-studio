/**
 * What the public /pricing page may say about money — the pure half, unit-tested
 * in tests/pricing.test.ts.
 *
 * No price in this repository is a fact: the owner sets them in Paddle. So a
 * price reaches the page from exactly two places, in this order of trust:
 *
 *   1. Paddle's own price preview (PricePreview), when this deployment sells
 *      through Paddle — localized for the visitor's country, currency and tax,
 *      i.e. what the checkout will actually ask;
 *   2. a display price the owner typed into a public env var,
 *        NEXT_PUBLIC_PRICE_DISPLAY_STARTER / _CREATOR / _STUDIO  (e.g. "$10")
 *      shown as written — the fallback while a preview loads or fails, and the
 *      only source before Paddle is live.
 *
 * With neither, the page says pricing is not published yet. It never shows an
 * invented or default number (CLAUDE.md rule 5).
 *
 * The credit rates (what a credit buys) are the platform's price list,
 * credit_prices (migration 0020), which only a signed-in account may read; for
 * them see creditRates().
 */

import { CREDIT_PACKS, type CreditPackId, type PaddleConfig, type PaddleEnvironment } from "@/lib/paddle";
import { UNIT_JOB_MINIMUM, UNIT_VIDEO_MINUTE, roundUpCredits, type PriceMap } from "@/lib/credits";

/** The public env this reads. Literal names only — see PRICING's reader. */
export interface PricingEnv {
  NEXT_PUBLIC_PRICE_DISPLAY_STARTER?: string;
  NEXT_PUBLIC_PRICE_DISPLAY_CREATOR?: string;
  NEXT_PUBLIC_PRICE_DISPLAY_STUDIO?: string;
}

export const DISPLAY_PRICE_VAR: Record<CreditPackId, keyof PricingEnv> = {
  starter: "NEXT_PUBLIC_PRICE_DISPLAY_STARTER",
  creator: "NEXT_PUBLIC_PRICE_DISPLAY_CREATOR",
  studio: "NEXT_PUBLIC_PRICE_DISPLAY_STUDIO",
};

const MAX_DISPLAY_LEN = 40;

/**
 * A display price as the owner wrote it, or null. It must contain a digit — a
 * leftover placeholder ("TBD", "price", "…") is not a price and must not be
 * printed as one — and stay short plain text; markup characters are refused
 * rather than escaped, since a price never needs them.
 */
export function readDisplayPrice(raw: string | undefined): string | null {
  const v = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!v || v.length > MAX_DISPLAY_LEN || !/\d/.test(v) || /[<>{}[\]`]/.test(v)) return null;
  return v;
}

export interface PricingPack {
  id: CreditPackId;
  credits: number;
  /** The owner's display price, when set. */
  displayPrice: string | null;
  /** The Paddle price id, when this pack is sold through Paddle. */
  priceId: string | null;
}

export interface Pricing {
  /** "paddle": sold through Paddle's checkout; "display": prices published, no checkout here yet; "none": nothing to show. */
  source: "paddle" | "display" | "none";
  packs: PricingPack[];
  /** What the browser needs for a price preview — public by design. */
  paddle: { environment: PaddleEnvironment; clientToken: string } | null;
}

/**
 * The packs this page lists. When Paddle sells, it lists exactly the packs
 * Paddle sells — a pack with a display price but no checkout would be an offer
 * nobody can take. Otherwise it lists the packs with a display price.
 */
export function resolvePricing(env: PricingEnv, paddle: PaddleConfig | null): Pricing {
  const display = (id: CreditPackId) => readDisplayPrice(env[DISPLAY_PRICE_VAR[id]]);
  if (paddle && paddle.packs.length > 0) {
    return {
      source: "paddle",
      packs: paddle.packs.map((p) => ({ id: p.id, credits: p.credits, displayPrice: display(p.id), priceId: p.priceId })),
      paddle: { environment: paddle.environment, clientToken: paddle.clientToken },
    };
  }
  const packs = CREDIT_PACKS.flatMap((p) => {
    const displayPrice = display(p.id);
    return displayPrice ? [{ id: p.id, credits: p.credits, displayPrice, priceId: null }] : [];
  });
  return { source: packs.length > 0 ? "display" : "none", packs, paddle: null };
}

export type PackPrice =
  | { kind: "preview"; text: string }
  | { kind: "display"; text: string }
  | { kind: "pending" }
  | { kind: "at_checkout" };

/**
 * The price one card shows. Paddle's preview wins (it is what the checkout
 * will charge, in the visitor's currency); the owner's display price stands in
 * while the preview loads or when it fails; with neither, a pack Paddle sells
 * says the price is shown at checkout.
 */
export function packPrice(pack: PricingPack, preview: Record<string, string> | null, loading: boolean): PackPrice {
  const previewed = pack.priceId && preview ? preview[pack.priceId] : undefined;
  if (previewed) return { kind: "preview", text: previewed };
  if (pack.displayPrice) return { kind: "display", text: pack.displayPrice };
  return loading ? { kind: "pending" } : { kind: "at_checkout" };
}

export interface CreditRates {
  /** Credits held per finished minute of video (video_minute x (1 + margin)); null when unpriced. */
  perMinute: number | null;
  /** The smallest hold any run takes (job_minimum; its margin is ignored, as 0020 does). */
  jobMinimum: number | null;
}

/** The two rates a person can reason with, from the live price list. Unset stays null — never 0. */
export function creditRates(prices: PriceMap): CreditRates {
  const minute = prices[UNIT_VIDEO_MINUTE];
  const floor = prices[UNIT_JOB_MINIMUM];
  return {
    perMinute: minute ? roundUpCredits(minute.creditsPerUnit * (1 + minute.margin)) : null,
    jobMinimum: floor ? roundUpCredits(floor.creditsPerUnit) : null,
  };
}

/**
 * Whole minutes of finished video a pack covers at the per-minute rate, or
 * null when there is no positive rate to divide by. Rounded down, and only
 * ever shown labelled "at the per-minute rate": the per-run minimum makes a
 * very short run cost more per minute, and a run charged below its hold costs
 * less, so this is a guide to scale, not a promise.
 */
export function packMinutes(credits: number, perMinute: number | null): number | null {
  if (perMinute === null || !(perMinute > 0) || !Number.isFinite(credits)) return null;
  return Math.floor(credits / perMinute);
}

// Each variable is read by its literal name: Next inlines NEXT_PUBLIC_* only
// for a direct reference, so handing over the whole env object would leave
// these blank in the browser.
export const PRICING_ENV: PricingEnv = {
  NEXT_PUBLIC_PRICE_DISPLAY_STARTER: process.env.NEXT_PUBLIC_PRICE_DISPLAY_STARTER,
  NEXT_PUBLIC_PRICE_DISPLAY_CREATOR: process.env.NEXT_PUBLIC_PRICE_DISPLAY_CREATOR,
  NEXT_PUBLIC_PRICE_DISPLAY_STUDIO: process.env.NEXT_PUBLIC_PRICE_DISPLAY_STUDIO,
};
