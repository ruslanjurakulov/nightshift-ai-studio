import "server-only";
import type { Role } from "@/lib/auth/roles-shared";
import { buyAccess, paddleClient, paddleConfig } from "@/lib/paddle";
import { DODO_CATALOG_PLAN_PRICES, dodoBuyAccess } from "@/lib/dodo";
import { dodoPricing, resolvePaymentsProvider, withDodoPlans, type PaymentsProvider } from "@/lib/payments";
import { PLAN_ENV, planMatrix, type PlanCatalog, type PlanMatrix } from "@/lib/plans";
import { PRICING_ENV, resolvePricing, type Pricing } from "@/lib/pricing";
import { dodoEnvironment, dodoPageView } from "@/lib/server/dodo-api";

/**
 * PAYMENTS_PROVIDER, read per request (a restart of the web container is
 * enough to switch; nothing is inlined at build). Server-only: the browser is
 * told which checkout to open by the page the server renders, never by an env
 * of its own. See lib/payments.ts for the rule (only `dodo` is Dodo).
 */
export function paymentsProvider(): PaymentsProvider {
  return resolvePaymentsProvider(process.env.PAYMENTS_PROVIDER);
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

export function sitePlanMatrix(catalog: PlanCatalog | null, locale: string): PlanMatrix | null {
  return paymentsProvider() === "dodo"
    ? withDodoPlans(planMatrix(catalog, PLAN_ENV, null), dodoPageView(), DODO_CATALOG_PLAN_PRICES, locale)
    : planMatrix(catalog, PLAN_ENV, paddleClient);
}

export function siteBuyAccess(orgId: string | null | undefined, role: Role | null | undefined): "hidden" | "admin_only" | "allowed" {
  return paymentsProvider() === "dodo" ? dodoBuyAccess(orgId, role, dodoPageView()) : buyAccess(orgId, role, paddleConfig);
}
