/**
 * Which payment provider this deployment sells through — the one switch
 * between Paddle (today's, the default) and Dodo Payments (docs/DODO_SETUP.md).
 *
 * The switch is the server-only variable PAYMENTS_PROVIDER, read per request
 * (lib/server/payments.ts), set from the repository variable of the same name
 * by deploy_web.yml like the NIGHTSHIFT_* switches. Only the exact word `dodo`
 * (lower case, nothing around it) turns Dodo on; empty, `paddle`, `Dodo`,
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

export function resolvePaymentsProvider(raw: string | undefined | null): PaymentsProvider {
  return raw === "dodo" ? "dodo" : "paddle";
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
