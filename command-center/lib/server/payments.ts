import "server-only";
import type { Role } from "@/lib/auth/roles-shared";
import { buyAccess, paddleClient, paddleConfig, paddleSellsTo, parsePaddleTestOrgs } from "@/lib/paddle";
import { DODO_CATALOG_PLAN_PRICES, dodoBuyAccess, dodoViewFor } from "@/lib/dodo";
import { dodoPricing, resolvePaymentsProvider, withDodoPlans, type PaymentsProvider } from "@/lib/payments";
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

/**
 * PADDLE_TEST_ORG_IDS, read per request (server-only, never inlined into the
 * browser): the workspaces a sandbox checkout may be opened for. The webhook
 * reads the same variable from its own secrets; both must list the same ids.
 */
export function paddleTestOrgs(): ReadonlySet<string> {
  return parsePaddleTestOrgs(process.env.PADDLE_TEST_ORG_IDS);
}

/** Paddle.js settings for this organization's own pages: null when Paddle may not sell to it (sandbox, not allow-listed). */
export function paddleClientFor(orgId: string | null | undefined): typeof paddleClient {
  return paddleSellsTo(paddleClient, orgId, paddleTestOrgs()) ? paddleClient : null;
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
  // The public pages open no checkout, so they show what Paddle sells at all; an organization's page only what it may buy.
  if (paymentsProvider() !== "dodo") return planMatrix(catalog, PLAN_ENV, orgId === undefined ? paddleClient : paddleClientFor(orgId));
  const view = orgId === undefined ? dodoPageView() : dodoViewFor(dodoServer(), orgId);
  return withDodoPlans(planMatrix(catalog, PLAN_ENV, null), view, DODO_CATALOG_PLAN_PRICES, locale);
}

export function siteBuyAccess(orgId: string | null | undefined, role: Role | null | undefined): "hidden" | "admin_only" | "allowed" {
  return paymentsProvider() === "dodo" ? dodoBuyAccess(orgId, role, dodoViewFor(dodoServer(), orgId)) : buyAccess(orgId, role, paddleConfig, paddleTestOrgs());
}
