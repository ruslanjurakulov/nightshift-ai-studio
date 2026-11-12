/**
 * Selling through Dodo Payments — the pure, client-safe half: the catalog
 * (what is sold and at what price), this deployment's server-side Dodo
 * settings resolved into what a page may show, and who may buy.
 *
 * The flow differs from Paddle's on purpose. Paddle's overlay is opened by the
 * browser with a price id; a Dodo checkout session is created by OUR server
 * (POST /api/billing/dodo/checkout, with the API key that never leaves it),
 * which puts { org_id, user_id } into the session's metadata and sends the
 * browser to Dodo's hosted checkout. So no Dodo id or key is ever in the page:
 * the browser names a pack or plan by OUR id ("starter", "pro"), the server
 * picks the product. The webhook (supabase/functions/dodo-webhook) credits the
 * payment from its own copy of the catalog and checks the amount against it;
 * a test keeps the two copies equal (tests/dodo-webhook.test.ts).
 *
 * Facts about Dodo here are from docs.dodopayments.com, read 2026-11-12
 * (api-reference/introduction, api-reference/checkout-sessions/create,
 * api-reference/customers/create-customer-portal-session,
 * miscellaneous/test-mode-vs-live-mode).
 */

import { atLeast, type Role } from "@/lib/auth/roles-shared";
import { isCreditExempt } from "@/lib/credits";
import { formatUsdAmount } from "@/lib/number-format";

/** Must equal DODO_PACKS in supabase/functions/_shared/dodo.ts (credits AND price, US cents before tax). */
export const DODO_CATALOG_PACKS = [
  { id: "starter", credits: 1000, usdCents: 1000 },
  { id: "creator", credits: 5000, usdCents: 4500 },
  { id: "studio", credits: 20000, usdCents: 16000 },
] as const;

/** Must equal DODO_PLAN_PRICES in supabase/functions/_shared/dodo.ts: monthly price by plans.id, US cents before tax. */
export const DODO_CATALOG_PLAN_PRICES: Readonly<Record<string, number>> = {
  creator: 1900,
  pro: 4900,
  studio: 12900,
};

export type DodoPackId = (typeof DODO_CATALOG_PACKS)[number]["id"];
export type DodoEnvironment = "test" | "live";

export const DODO_PRODUCT_ID_RE = /^pdt_[A-Za-z0-9]{3,64}$/;

/** Dodo's two API hosts: a test-mode key works only against test, a live one only against live. */
export const DODO_BASE_URL: Record<DodoEnvironment, string> = {
  test: "https://test.dodopayments.com",
  live: "https://live.dodopayments.com",
};

/** The server env this reads (server-only: none of it is NEXT_PUBLIC_, and the key is a secret). */
export interface DodoEnv {
  DODO_PAYMENTS_API_KEY?: string;
  DODO_PAYMENTS_ENV?: string;
  DODO_PRODUCT_STARTER?: string;
  DODO_PRODUCT_CREATOR?: string;
  DODO_PRODUCT_STUDIO?: string;
  DODO_PLAN_CREATOR?: string;
  DODO_PLAN_PRO?: string;
  DODO_PLAN_STUDIO?: string;
}

const PACK_VAR: Record<DodoPackId, keyof DodoEnv> = {
  starter: "DODO_PRODUCT_STARTER",
  creator: "DODO_PRODUCT_CREATOR",
  studio: "DODO_PRODUCT_STUDIO",
};

/** plan id -> its env var. A plan the database adds later without an entry here is not sold through Dodo. */
export const DODO_PLAN_VAR: Record<string, keyof DodoEnv> = {
  creator: "DODO_PLAN_CREATOR",
  pro: "DODO_PLAN_PRO",
  studio: "DODO_PLAN_STUDIO",
};

export interface DodoServerConfig {
  apiKey: string;
  environment: DodoEnvironment;
  baseUrl: string;
  /** Our pack id -> Dodo product id, for the packs configured here. */
  packs: Partial<Record<DodoPackId, string>>;
  /** Our plan id -> Dodo product id. */
  plans: Record<string, string>;
}

/**
 * This deployment's Dodo settings, or null when selling through Dodo is not
 * configured. Test mode unless live is asked for explicitly, and a key that
 * says which mode it belongs to (dodo_test_… / dodo_live_…) must belong to that
 * one — the half-finished switch to live must not open the wrong checkout. A
 * product id that is unset or malformed leaves that item unsold; with nothing
 * to sell, null. One product id cannot be two items.
 */
export function resolveDodoServer(env: DodoEnv): DodoServerConfig | null {
  const rawEnv = (env.DODO_PAYMENTS_ENV ?? "").trim().toLowerCase();
  const environment: DodoEnvironment | null = rawEnv === "" || rawEnv === "test" ? "test" : rawEnv === "live" ? "live" : null;
  const apiKey = (env.DODO_PAYMENTS_API_KEY ?? "").trim();
  if (!environment || apiKey.length < 20 || /\s/.test(apiKey)) return null;
  if (/^dodo_(test|live)_/.test(apiKey) && apiKey.startsWith("dodo_live_") !== (environment === "live")) return null;
  const seen = new Set<string>();
  const take = (raw: string | undefined): string | null => {
    const id = (raw ?? "").trim();
    if (!DODO_PRODUCT_ID_RE.test(id) || seen.has(id)) return null;
    seen.add(id);
    return id;
  };
  const packs: Partial<Record<DodoPackId, string>> = {};
  for (const p of DODO_CATALOG_PACKS) {
    const id = take(env[PACK_VAR[p.id]]);
    if (id) packs[p.id] = id;
  }
  const plans: Record<string, string> = {};
  for (const [planId, v] of Object.entries(DODO_PLAN_VAR)) {
    const id = take(env[v]);
    if (id && Number.isInteger(DODO_CATALOG_PLAN_PRICES[planId])) plans[planId] = id;
  }
  if (Object.keys(packs).length === 0 && Object.keys(plans).length === 0) return null;
  return { apiKey, environment, baseUrl: DODO_BASE_URL[environment], packs, plans };
}

/** What a page may know about Dodo: the mode (for the test badge) and WHICH items are on sale. No id, no key. */
export interface DodoView {
  environment: DodoEnvironment;
  packs: { id: DodoPackId; credits: number; usdCents: number }[];
  plans: string[];
}

export function dodoView(cfg: DodoServerConfig | null): DodoView | null {
  if (!cfg) return null;
  return {
    environment: cfg.environment,
    packs: DODO_CATALOG_PACKS.filter((p) => Boolean(cfg.packs[p.id])).map((p) => ({ id: p.id, credits: p.credits, usdCents: p.usdCents })),
    plans: Object.keys(cfg.plans),
  };
}

/** A catalog price as a page shows it: "$10", "$12.50" — the same price the webhook checks before crediting. */
export function dodoPriceText(usdCents: number, locale: string): string {
  return formatUsdAmount(usdCents / 100, locale, usdCents % 100 === 0 ? 0 : 2, 2);
}

export type DodoBuyAccess = "hidden" | "admin_only" | "allowed";

/** The same bar as Paddle's buyAccess (lib/paddle.ts): never the exempt operator org, never without packs on sale, an owner/admin act. */
export function dodoBuyAccess(orgId: string | null | undefined, role: Role | null | undefined, view: DodoView | null): DodoBuyAccess {
  if (!view || view.packs.length === 0 || !orgId || isCreditExempt(orgId)) return "hidden";
  return role && atLeast(role, "admin") ? "allowed" : "admin_only";
}

/** What the checkout route accepts from the browser: one of OUR ids, never a product id or an amount. */
export type DodoCheckoutItem = { kind: "pack"; id: DodoPackId } | { kind: "plan"; id: string };

export function parseCheckoutItem(body: unknown): DodoCheckoutItem | null {
  const o = (body ?? {}) as { kind?: unknown; id?: unknown };
  if (o.kind === "pack" && typeof o.id === "string" && DODO_CATALOG_PACKS.some((p) => p.id === o.id)) return { kind: "pack", id: o.id as DodoPackId };
  if (o.kind === "plan" && typeof o.id === "string" && Object.prototype.hasOwnProperty.call(DODO_CATALOG_PLAN_PRICES, o.id)) return { kind: "plan", id: o.id };
  return null;
}

/** The Credits page path the checkout returns to: /{channel}/credits, nothing else (no open redirect through Dodo). */
export const RETURN_PATH_RE = /^\/[A-Za-z0-9_-]{1,80}\/credits$/;

/** The metadata the session carries to the webhook. Ids only; the amount is never here. */
export function dodoCheckoutMetadata(orgId: string, userId: string | null, item: DodoCheckoutItem): Record<string, string> {
  return { org_id: orgId, ...(userId ? { user_id: userId } : {}), nightshift_item: `${item.kind}:${item.id}` };
}

/** A URL Dodo answered with, only when it is https on Dodo's own domain (checkout_url, the portal link). */
export function dodoHostedUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "dodopayments.com" || u.hostname.endsWith(".dodopayments.com")) ? u.toString() : null;
  } catch {
    return null;
  }
}
