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
import { LEGAL } from "@/lib/legal";
import { TOPUP, TOPUP_MAX_CREDITS, topupItemKey, topupQuote } from "@/lib/topup";

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

/**
 * The typed-DOLLAR amount the "Add credits" sheet sold until 2026-11-21 (`pack:amount_<cents>`). No longer sold: the sheet
 * now sells a credit count at volume rates (lib/topup.ts). Kept because the webhook still fulfils a checkout opened before
 * the change, with its copy of these numbers (DODO_AMOUNT in supabase/functions/_shared/dodo.ts; a test keeps them equal).
 *
 *   creditsPerCent  credits per US cent, before tax. 1 credit = 1¢ is the Starter pack's own rate (1,000 for $10), so the
 *                   base rate is unchanged; the larger packs stay the cheaper way to buy many credits.
 *   minCents        $5. The PWYW product's Minimum Price in Dodo must be at most this (docs: features/pay-what-you-want).
 *   maxCents        $300. Dodo has no maximum price setting ("There is no maximum price setting. To cap the amount you
 *                   charge, enforce the cap in your own code": developer-resources/dynamic-pricing-checkout, read
 *                   2026-11-13), so this cap lives here, in the checkout route and again in the webhook.
 */
export const DODO_AMOUNT = {
  creditsPerCent: 1,
  minCents: 500,
  maxCents: 30000,
} as const;

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
  /** The one-time "Pay What You Want" product a typed amount is charged under (pdt_…). Unset: no custom amount on sale. */
  DODO_PRODUCT_AMOUNT?: string;
  /** 32+ characters, the SAME value as the dodo-webhook's: the key checkout metadata is signed with. */
  DODO_METADATA_SECRET?: string;
  /** In test mode, the only organizations that may buy (uuids, comma or space separated). */
  DODO_TEST_ORG_IDS?: string;
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
  /** The Pay What You Want product a typed amount is charged under, or null (no custom amount on sale). */
  amountProduct: string | null;
  /** The key the checkout metadata is signed with (server only, like the API key). */
  metadataSecret: string;
  /** Test mode: the organizations allowed to buy. Ignored live. */
  testOrgs: ReadonlySet<string>;
}

/** Must equal DODO_METADATA_SECRET_MIN in supabase/functions/_shared/dodo.ts. */
export const DODO_METADATA_SECRET_MIN = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** DODO_TEST_ORG_IDS, as the webhook reads it (dodoTestOrgsFromEnv): uuids, lower case; anything else skipped. */
export function parseTestOrgs(raw: string | undefined): ReadonlySet<string> {
  return new Set((raw ?? "").split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter((x) => UUID_RE.test(x)));
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
  // Without the signing key the webhook would refuse every payment this checkout opens: sell nothing instead.
  const metadataSecret = env.DODO_METADATA_SECRET ?? "";
  if (metadataSecret.length < DODO_METADATA_SECRET_MIN || /\s/.test(metadataSecret)) return null;
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
  // Last, as the webhook reads it (dodoAmountProductFromEnv): an id already used by a pack or a plan is not the amount product.
  const amountProduct = take(env.DODO_PRODUCT_AMOUNT);
  if (Object.keys(packs).length === 0 && Object.keys(plans).length === 0 && !amountProduct) return null;
  return {
    apiKey,
    environment,
    baseUrl: DODO_BASE_URL[environment],
    packs,
    plans,
    amountProduct,
    metadataSecret,
    testOrgs: parseTestOrgs(env.DODO_TEST_ORG_IDS),
  };
}

/**
 * Whether this organization may buy here. Live: yes. Test mode on a real
 * database: only the organizations in DODO_TEST_ORG_IDS — a test card is
 * public (4242…), and a test purchase must not leave real credits or a plan
 * on a customer's workspace. The webhook applies the same list.
 */
export function dodoSellsTo(cfg: DodoServerConfig | null, orgId: string | null | undefined): boolean {
  if (!cfg || !orgId) return false;
  return cfg.environment === "live" || cfg.testOrgs.has(orgId.toLowerCase());
}

/** The custom amount as a page may show it: the bounds, the rate and the preset keys (the same numbers the server enforces). */
export interface DodoAmountView {
  minCredits: number;
  maxCredits: number;
  maxCents: number;
  /** The validated public contact address (LEGAL.contactEmail), or null when none is configured: then no mail link is shown. */
  contactEmail: string | null;
}

/** What a page may know about Dodo: the mode (for the test badge) and WHICH items are on sale. No id, no key. */
export interface DodoView {
  environment: DodoEnvironment;
  packs: { id: DodoPackId; credits: number; usdCents: number }[];
  plans: string[];
  /** Null when no Pay What You Want product is configured: the panel then offers the packs only, as before. */
  amount: DodoAmountView | null;
}

/** The view for one organization's own pages: null (nothing on sale) where dodoSellsTo says no. */
export function dodoViewFor(cfg: DodoServerConfig | null, orgId: string | null | undefined): DodoView | null {
  return dodoSellsTo(cfg, orgId) ? dodoView(cfg) : null;
}

export function dodoView(cfg: DodoServerConfig | null): DodoView | null {
  if (!cfg) return null;
  return {
    environment: cfg.environment,
    packs: DODO_CATALOG_PACKS.filter((p) => Boolean(cfg.packs[p.id])).map((p) => ({ id: p.id, credits: p.credits, usdCents: p.usdCents })),
    plans: Object.keys(cfg.plans),
    amount: cfg.amountProduct
      ? { minCredits: TOPUP.minCredits, maxCredits: TOPUP_MAX_CREDITS, maxCents: TOPUP.maxCents, contactEmail: LEGAL.contactEmail }
      : null,
  };
}

/** A catalog price as a page shows it: "$10", "$12.50" — the same price the webhook checks before crediting. */
export function dodoPriceText(usdCents: number, locale: string): string {
  return formatUsdAmount(usdCents / 100, locale, usdCents % 100 === 0 ? 0 : 2, 2);
}

export type DodoBuyAccess = "hidden" | "admin_only" | "allowed";

/** The same bar as Paddle's buyAccess (lib/paddle.ts): never the exempt operator org, never without packs on sale, an owner/admin act. */
export function dodoBuyAccess(orgId: string | null | undefined, role: Role | null | undefined, view: DodoView | null): DodoBuyAccess {
  if (!view || (view.packs.length === 0 && !view.amount) || !orgId || isCreditExempt(orgId)) return "hidden";
  return role && atLeast(role, "admin") ? "allowed" : "admin_only";
}

/**
 * What the checkout route accepts from the browser: one of OUR ids, never a product id; or, for a typed amount, a whole
 * number of US cents inside DODO_AMOUNT's bounds. The credits are never the browser's: the server signs the cents, and the
 * webhook credits the signed cents times its own rate, and only when Dodo reports exactly that amount paid.
 */
export type DodoCheckoutItem =
  | { kind: "pack"; id: DodoPackId }
  | { kind: "plan"; id: string }
  | { kind: "amount"; usdCents: number }
  | { kind: "credits"; credits: number; usdCents: number };

/** What the browser sends for a credit-count purchase: the count only (the server prices it). */
export type DodoCheckoutRequest = { kind: "pack"; id: DodoPackId } | { kind: "plan"; id: string } | { kind: "credits"; credits: number };

/** The only keys a credit-count request may carry: return_path is read by the route, the rest is the order itself. */
const CREDITS_REQUEST_KEYS: readonly string[] = ["kind", "credits", "return_path"];

/**
 * A request from the retired typed-dollar sheet (`kind: "amount"`): a tab opened before the credit-count sheet shipped. The
 * route answers it with its own error so the sheet can say "refresh the page" instead of a generic failure.
 */
export function isRetiredAmountRequest(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { kind?: unknown }).kind === "amount";
}

export function parseCheckoutItem(body: unknown): DodoCheckoutItem | null {
  const o = (body ?? {}) as { kind?: unknown; id?: unknown; credits?: unknown };
  if (o.kind === "pack" && typeof o.id === "string" && DODO_CATALOG_PACKS.some((p) => p.id === o.id)) return { kind: "pack", id: o.id as DodoPackId };
  if (o.kind === "plan" && typeof o.id === "string" && Object.prototype.hasOwnProperty.call(DODO_CATALOG_PLAN_PRICES, o.id)) return { kind: "plan", id: o.id };
  // The browser names a credit count and nothing else: any key outside CREDITS_REQUEST_KEYS (a price, an amount, cents, an
  // id) makes the request malformed rather than being ignored, and the price is computed here (topupQuote), never read from
  // the body. The typed-dollar `amount` kind is no longer sold (owner decision 2026-11-21: credits, minimum 1 000); its
  // in-flight payments still fulfil in the webhook.
  if (o.kind === "credits" && Object.keys(o).every((k) => CREDITS_REQUEST_KEYS.includes(k))) {
    const q = topupQuote(o.credits);
    return q.ok ? { kind: "credits", credits: q.credits, usdCents: q.cents } : null;
  }
  return null;
}

/**
 * The item as it is signed, issued a nonce for, and named in the metadata. A typed amount is `pack:amount_<cents>`: a
 * one-time purchase like a pack, so every rule the webhook keeps for packs applies to it and no plan or subscription event
 * can carry it, with the cents INSIDE the signed text and inside the nonce row 0146 stores (whose item check,
 * ^(pack|plan):[a-z][a-z0-9_]{0,30}$, it already fits, so the nonce binds the amount too). No catalog pack id starts
 * with "amount_" (a test pins it), so the two cannot be confused.
 */
export function dodoItemKey(item: DodoCheckoutItem): string {
  if (item.kind === "credits") return topupItemKey({ credits: item.credits, cents: item.usdCents });
  return item.kind === "amount" ? `pack:amount_${item.usdCents}` : `${item.kind}:${item.id}`;
}

/** Which panel of the Credits page waits for the webhook after the return: a typed amount is bought in the packs panel. */
export function dodoReturnItem(item: DodoCheckoutItem): "pack" | "plan" {
  return item.kind === "plan" ? "plan" : "pack";
}

/** The Credits page path the checkout returns to: /{channel}/credits, nothing else (no open redirect through Dodo). */
export const RETURN_PATH_RE = /^\/[A-Za-z0-9_-]{1,80}\/credits$/;

/** Must equal DODO_METADATA_VERSION in supabase/functions/_shared/dodo.ts. */
export const DODO_METADATA_VERSION = "nightshift-dodo-v1";

/**
 * The text the checkout metadata's signature covers — byte for byte what the
 * webhook's dodoMetadataMessage builds (a test signs here and verifies there).
 */
export function dodoMetadataMessage(f: { orgId: string; userId: string | null; item: string; nonce: string }): string {
  return [DODO_METADATA_VERSION, f.orgId, f.userId ?? "", f.item, f.nonce].join("|");
}

/**
 * The metadata the session carries to the webhook: ids only (no price; for a
 * typed amount, the cents inside the signed item, which the webhook checks
 * against what Dodo reports paid), a nonce and their HMAC
 * (lib/server/dodo-api.ts signs). The
 * webhook names no organization from metadata it cannot verify: Dodo's static
 * payment links let anyone write metadata_* fields.
 */
export function dodoCheckoutMetadata(
  orgId: string,
  userId: string | null,
  item: DodoCheckoutItem,
  nonce: string,
  sig: string,
): Record<string, string> {
  return {
    org_id: orgId,
    ...(userId ? { user_id: userId } : {}),
    nightshift_item: dodoItemKey(item),
    ns_nonce: nonce,
    ns_sig: sig,
  };
}

/** Dodo's buyer terms, linked where it sells (owner-confirmed 2026-11-13; on the live Terms since #700). */
export const DODO_BUYER_TERMS = "https://dodopayments.com/legal/buyer-terms";

/** The return statuses passed on to the page (Dodo's own words for a payment or a subscription); anything else is dropped. */
export const RETURN_STATUS_RE = /^[a-z_]{1,40}$/;

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
