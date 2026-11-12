import "server-only";
import { fetchWithTimeout } from "@/lib/server/fetch-timeout";
import {
  dodoCheckoutMetadata,
  dodoHostedUrl,
  dodoView,
  resolveDodoServer,
  type DodoCheckoutItem,
  type DodoServerConfig,
  type DodoView,
} from "@/lib/dodo";

/**
 * Dodo Payments' server API: checkout sessions and customer-portal links. The
 * API key (DODO_PAYMENTS_API_KEY, a GitHub/server secret) is read here and sent
 * only to Dodo's API host — never logged, never returned to a browser. Errors
 * carry the HTTP status alone.
 *
 * Read per call rather than at module load, so the Dodo settings follow the
 * running container's env the same way PAYMENTS_PROVIDER does.
 */
export function dodoServer(): DodoServerConfig | null {
  return resolveDodoServer({
    DODO_PAYMENTS_API_KEY: process.env.DODO_PAYMENTS_API_KEY,
    DODO_PAYMENTS_ENV: process.env.DODO_PAYMENTS_ENV,
    DODO_PRODUCT_STARTER: process.env.DODO_PRODUCT_STARTER,
    DODO_PRODUCT_CREATOR: process.env.DODO_PRODUCT_CREATOR,
    DODO_PRODUCT_STUDIO: process.env.DODO_PRODUCT_STUDIO,
    DODO_PLAN_CREATOR: process.env.DODO_PLAN_CREATOR,
    DODO_PLAN_PRO: process.env.DODO_PLAN_PRO,
    DODO_PLAN_STUDIO: process.env.DODO_PLAN_STUDIO,
  });
}

/** The mode DODO_PAYMENTS_ENV names (test unless it says live), for the badge even while nothing is configured. */
export function dodoEnvironment(): "test" | "live" {
  return (process.env.DODO_PAYMENTS_ENV ?? "").trim().toLowerCase() === "live" ? "live" : "test";
}

/** What a page may show about Dodo (no key, no product id), or null when it is not configured. */
export function dodoPageView(): DodoView | null {
  return dodoView(dodoServer());
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function dodo(cfg: DodoServerConfig, path: string, init: RequestInit, doFetch: FetchLike): Promise<{ status: number; json: unknown }> {
  const res = await doFetch(cfg.baseUrl + path, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    cache: "no-store",
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * POST /checkouts (docs: api-reference/checkout-sessions/create): one product,
 * quantity 1, our ids in metadata, discount codes and currency switching OFF
 * (the webhook credits only the catalog price in USD), no trial on a plan, a
 * return and a cancel URL on our own Credits page. Returns Dodo's hosted
 * checkout_url, or the HTTP status Dodo answered (never its body: it is not
 * logged).
 */
export async function createDodoCheckout(
  cfg: DodoServerConfig,
  args: { productId: string; orgId: string; userId: string | null; email: string | null; item: DodoCheckoutItem; returnUrl: string; cancelUrl: string },
  doFetch: FetchLike = fetchWithTimeout,
): Promise<{ ok: true; url: string } | { ok: false; status: number }> {
  const body = {
    product_cart: [{ product_id: args.productId, quantity: 1 }],
    ...(args.email ? { customer: { email: args.email } } : {}),
    metadata: dodoCheckoutMetadata(args.orgId, args.userId, args.item),
    return_url: args.returnUrl,
    cancel_url: args.cancelUrl,
    feature_flags: { allow_discount_code: false, allow_currency_selection: false },
    // No trial, whatever the product in Dodo says: "trial_period_days ... overrides the trial period set in the product's
    // price" (checkout-sessions/create). A trial would give a plan's entitlements before anything was paid; credits come
    // only from a paid period (the webhook), so the owner's catalog has no trials (docs/BILLING_PLANS.md 3.2).
    ...(args.item.kind === "plan" ? { subscription_data: { trial_period_days: 0 } } : {}),
  };
  const { status, json } = await dodo(cfg, "/checkouts", { method: "POST", body: JSON.stringify(body) }, doFetch);
  const url = dodoHostedUrl((json as { checkout_url?: unknown } | null)?.checkout_url);
  return status >= 200 && status < 300 && url ? { ok: true, url } : { ok: false, status };
}

/**
 * POST /customers/{customer_id}/customer-portal/session (docs:
 * api-reference/customers/create-customer-portal-session): a fresh link to
 * Dodo's portal, where the customer updates the card, cancels, and downloads
 * invoices. Never cached; null on any failure.
 */
export async function createDodoPortalLink(
  cfg: DodoServerConfig,
  customerId: string,
  returnUrl: string,
  doFetch: FetchLike = fetchWithTimeout,
): Promise<string | null> {
  if (!/^cus_[A-Za-z0-9]{3,64}$/.test(customerId)) return null;
  const { status, json } = await dodo(
    cfg,
    `/customers/${customerId}/customer-portal/session?return_url=${encodeURIComponent(returnUrl)}`,
    { method: "POST" },
    doFetch,
  );
  return status >= 200 && status < 300 ? dodoHostedUrl((json as { link?: unknown } | null)?.link) : null;
}
