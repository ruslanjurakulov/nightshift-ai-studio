/**
 * Which payment provider this deployment sells through — the one switch
 * between Paddle (today's, the default) and Dodo Payments (docs/DODO_SETUP.md).
 *
 * The switch is the server-only variable PAYMENTS_PROVIDER, read per request
 * (lib/server/payments.ts), set from the repository variable of the same name
 * by deploy_web.yml like the NIGHTSHIFT_* switches. It may also be a list that
 * adds Payme next to the primary seller (parsePaymentsProviders, below). Only
 * the exact word `dodo` (lower case, nothing around it), alone or in a valid
 * list, turns Dodo on; empty, `paddle`, `Dodo`,
 * ` dodo` or anything else is Paddle, so a typo can
 * never leave the site half on a provider nobody configured. Paddle's own
 * settings are then read exactly as before: the Paddle path does not consult
 * this module beyond "is it paddle".
 *
 * The pure half lives here so tests can pin it without a server.
 */

import { CREDIT_PACKS } from "@/lib/paddle";
import { dodoPriceText, type DodoEnvironment, type DodoView } from "@/lib/dodo";
import type { PlanMatrix } from "@/lib/plans";
import type { Pricing } from "@/lib/pricing";

export type PaymentsProvider = "paddle" | "dodo";

/**
 * PAYMENTS_PROVIDER as a list: the primary seller (Paddle or Dodo, exactly one, as before) plus Payme for Uzcard/Humo
 * top-ups, which sells NEXT TO the primary, never instead of it. `dodo` alone reads exactly as it always did; `dodo,payme`
 * or `payme` (Paddle primary) adds Payme. The rule that kept a typo from leaving the site half on a provider is kept for the
 * list as a whole: every entry must be one of the three words, lower case, comma-separated with nothing around them, no
 * entry twice, and never both Paddle and Dodo. Anything else (`dodo, payme`, `Payme`, `dodo,paddle`) is today's
 * default — Paddle alone, no Payme.
 */
export interface PaymentsProviders {
  primary: PaymentsProvider;
  payme: boolean;
}

const PROVIDER_WORDS = new Set(["paddle", "dodo", "payme"]);
const DEFAULT_PROVIDERS: PaymentsProviders = { primary: "paddle", payme: false };

export function parsePaymentsProviders(raw: string | undefined | null): PaymentsProviders {
  if (typeof raw !== "string" || raw === "") return DEFAULT_PROVIDERS;
  const parts = raw.split(",");
  if (parts.some((p) => !PROVIDER_WORDS.has(p)) || new Set(parts).size !== parts.length) return DEFAULT_PROVIDERS;
  if (parts.includes("paddle") && parts.includes("dodo")) return DEFAULT_PROVIDERS;
  return { primary: parts.includes("dodo") ? "dodo" : "paddle", payme: parts.includes("payme") };
}

/** The primary seller only: what every Paddle/Dodo page has always branched on. */
export function resolvePaymentsProvider(raw: string | undefined | null): PaymentsProvider {
  return parsePaymentsProviders(raw).primary;
}

/** A catalog price written the way an owner's display price is ("$10", "$12.50"), so every page formats it the same way. */
export function dodoDisplayPrice(usdCents: number): string {
  return "$" + (usdCents / 100).toFixed(usdCents % 100 === 0 ? 0 : 2);
}

/**
 * /pricing (and the landing teaser) when Dodo sells: the packs on sale here,
 * at the catalog price the webhook checks (lib/dodo.ts). No preview call:
 * Dodo's price is ours, so the page can say it, and the checkout shows the tax
 * where it applies. The price is written like an owner's display price ("$10")
 * so the pages localize it exactly as they localize one (displayPriceText).
 * Nothing on sale is "none", never an invented price; the seller is Dodo
 * either way (`dodo`), so the page never names Paddle while Dodo sells.
 */
export function dodoPricing(view: DodoView | null, environment: DodoEnvironment = "test"): Pricing {
  const packs = (view?.packs ?? []).map((p) => ({ id: p.id, credits: p.credits, displayPrice: dodoDisplayPrice(p.usdCents), priceId: null }));
  // The order and credits of the packs are Paddle's (a test pins DODO_CATALOG_PACKS to CREDIT_PACKS).
  packs.sort((a, b) => CREDIT_PACKS.findIndex((c) => c.id === a.id) - CREDIT_PACKS.findIndex((c) => c.id === b.id));
  return { source: packs.length > 0 ? "dodo" : "none", packs, paddle: null, dodo: { environment: view?.environment ?? environment } };
}

/**
 * The plan matrix when Dodo sells: the plans configured here carry the catalog
 * price as their display price and are purchasable; every other column is as
 * planMatrix() made it without a checkout (priceId null). The Credits page
 * then subscribes by plan id through the server (PlanPanel's `dodo` prop).
 */
export function withDodoPlans(matrix: PlanMatrix | null, view: DodoView | null, prices: Readonly<Record<string, number>>, locale: string): PlanMatrix | null {
  if (!matrix) return null;
  const onSale = new Set(view?.plans ?? []);
  const columns = matrix.columns.map((c) => {
    const cents = prices[c.id];
    if (c.isDefault) return { ...c, priceId: null };
    // Only what Dodo sells here carries a price: an env display price for a plan with no Dodo product would be an
    // offer nobody can take.
    return { ...c, priceId: null, displayPrice: onSale.has(c.id) && Number.isInteger(cents) ? dodoPriceText(cents, locale) : null };
  });
  const purchasable = columns.some((c) => !c.isDefault && onSale.has(c.id) && c.displayPrice !== null);
  return { ...matrix, columns, purchasable, paddle: null };
}
