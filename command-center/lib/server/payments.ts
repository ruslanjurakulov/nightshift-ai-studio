import "server-only";
import type { Role } from "@/lib/auth/roles-shared";
import { buyAccess, paddleClient, paddleConfig } from "@/lib/paddle";
import { DODO_CATALOG_PLAN_PRICES, dodoBuyAccess, dodoViewFor } from "@/lib/dodo";
import { dodoPricing, parsePaymentsProviders, resolvePaymentsProvider, withDodoPlans, type PaymentsProvider } from "@/lib/payments";
import { resolvePaymeServer, type PaymeServerConfig } from "@/lib/payme";
import { PLAN_ENV, planMatrix, type PlanCatalog, type PlanMatrix } from "@/lib/plans";
import { PRICING_ENV, resolvePricing, type Pricing } from "@/lib/pricing";
import { dodoEnvironment, dodoPageView, dodoServer } from "@/lib/server/dodo-api";

/**
 * PAYMENTS_PROVIDER, read per request (a restart of the web container is
 * enough to switch; nothing is inlined at build). Server-only: the browser is
 * told which checkout to open by the page the server renders, never by an env
 * of its own. See lib/payments.ts for the rule (only `dodo` is Dodo).
 */
export function paymentsProvider(): PaymentsProvider {
  return resolvePaymentsProvider(process.env.PAYMENTS_PROVIDER);
}

/** Whether PAYMENTS_PROVIDER lists Payme (Uzcard/Humo top-ups next to the primary seller). Off unless listed. */
export function paymeListed(): boolean {
  return parsePaymentsProviders(process.env.PAYMENTS_PROVIDER).payme;
}

/** This deployment's Payme settings, read per request like the switch; null when not configured. */
export function paymeServer(): PaymeServerConfig | null {
  return resolvePaymeServer({
    PAYME_MERCHANT_ID: process.env.PAYME_MERCHANT_ID,
    PAYME_ENV: process.env.PAYME_ENV,
    PAYME_TEST_ORG_IDS: process.env.PAYME_TEST_ORG_IDS,
  });
}

/**
 * The three things a public or in-app page needs to know about selling, for
 * whichever provider is on. With `paddle` each is exactly the call the page made
 * before this switch existed (resolvePricing / planMatrix / buyAccess on the
 * Paddle settings), so the Paddle pages cannot change by being routed here.
 */
export function sitePricing(): Pricing {
  return paymentsProvider() === "dodo" ? dodoPricing(dodoPageView(), dodoEnvironment()) : resolvePricing(PRICING_ENV, paddleConfig);
}

/**
 * The plan matrix. `orgId` given (an organization's own page): with Dodo in test
 * mode, plans are on sale only to an allow-listed organization (dodoViewFor).
 * Omitted (the public pages): what is on sale here at all.
 */
export function sitePlanMatrix(catalog: PlanCatalog | null, locale: string, orgId?: string | null): PlanMatrix | null {
  if (paymentsProvider() !== "dodo") return planMatrix(catalog, PLAN_ENV, paddleClient);
  const view = orgId === undefined ? dodoPageView() : dodoViewFor(dodoServer(), orgId);
  return withDodoPlans(planMatrix(catalog, PLAN_ENV, null), view, DODO_CATALOG_PLAN_PRICES, locale);
}

export function siteBuyAccess(orgId: string | null | undefined, role: Role | null | undefined): "hidden" | "admin_only" | "allowed" {
  return paymentsProvider() === "dodo" ? dodoBuyAccess(orgId, role, dodoViewFor(dodoServer(), orgId)) : buyAccess(orgId, role, paddleConfig);
}
