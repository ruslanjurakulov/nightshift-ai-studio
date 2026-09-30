/**
 * Buying credits with Paddle (SaaS phase C4) — the pure, client-safe half:
 * the packs on sale, this deployment's public Paddle settings, and who may buy.
 *
 * The browser only ever opens Paddle's own overlay checkout: card details go
 * to Paddle (the Merchant of Record) and never touch this app. What the
 * checkout sends back to us is custom_data { org_id, user_id } — a label
 * saying who is being paid for, nothing more. The webhook that credits a
 * purchase (supabase/functions/paddle-webhook, service role, NOT this app)
 * takes the amount from its own copy of CREDIT_PACKS by Paddle price id; a
 * test keeps the two copies equal (tests/paddle-webhook.test.ts).
 *
 * Every value here is public by design: a client-side token is meant to be in
 * the page, and price ids are visible in any checkout.
 */

import { atLeast, type Role } from "@/lib/auth/roles-shared";
import { isCreditExempt } from "@/lib/credits";
import type { Locale } from "@/lib/i18n";

/** Must equal CREDIT_PACKS in supabase/functions/_shared/paddle.ts. */
export const CREDIT_PACKS = [
  { id: "starter", credits: 1000 },
  { id: "creator", credits: 5000 },
  { id: "studio", credits: 20000 },
] as const;

export type CreditPackId = (typeof CREDIT_PACKS)[number]["id"];

export type PaddleEnvironment = "sandbox" | "production";

export interface SellablePack {
  id: CreditPackId;
  credits: number;
  priceId: string;
}

export interface PaddleConfig {
  environment: PaddleEnvironment;
  clientToken: string;
  packs: SellablePack[];
}

export const PADDLE_JS_URL = "https://cdn.paddle.com/paddle/v2/paddle.js";

/** A Paddle price id (pri_…). */
export const PADDLE_PRICE_ID_RE = /^pri_[a-z0-9]{10,40}$/;
const PRICE_ID_RE = PADDLE_PRICE_ID_RE;
const TOKEN_RE = /^(test|live)_[A-Za-z0-9]{10,}$/;

/** The public env this reads. Literal names only — see resolvePaddleConfig's caller. */
export interface PaddleEnv {
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN?: string;
  NEXT_PUBLIC_PADDLE_ENV?: string;
  NEXT_PUBLIC_PADDLE_PRICE_STARTER?: string;
  NEXT_PUBLIC_PADDLE_PRICE_CREATOR?: string;
  NEXT_PUBLIC_PADDLE_PRICE_STUDIO?: string;
}

const PRICE_VAR: Record<CreditPackId, keyof PaddleEnv> = {
  starter: "NEXT_PUBLIC_PADDLE_PRICE_STARTER",
  creator: "NEXT_PUBLIC_PADDLE_PRICE_CREATOR",
  studio: "NEXT_PUBLIC_PADDLE_PRICE_STUDIO",
};

/**
 * This deployment's Paddle settings, or null when buying is not configured.
 *
 * Sandbox unless production is asked for explicitly, and the token must
 * belong to the environment: Paddle's sandbox tokens start `test_`, live ones
 * `live_`. A live token with the environment left empty is a half-finished
 * switch to production; the checkout stays hidden rather than opening against
 * the wrong Paddle. A pack whose price id is unset is left off the page; with
 * no pack at all there is nothing to sell.
 */
export function resolvePaddleConfig(env: PaddleEnv): PaddleConfig | null {
  const client = resolvePaddleClient(env);
  if (!client) return null;
  const { environment, clientToken } = client;

  const packs: SellablePack[] = [];
  const seen = new Set<string>();
  for (const pack of CREDIT_PACKS) {
    const priceId = (env[PRICE_VAR[pack.id]] ?? "").trim();
    if (!PRICE_ID_RE.test(priceId) || seen.has(priceId)) continue;
    seen.add(priceId);
    packs.push({ id: pack.id, credits: pack.credits, priceId });
  }
  return packs.length > 0 ? { environment, clientToken, packs } : null;
}

/**
 * Paddle.js settings alone — the environment and a client token that belongs
 * to it — for checkouts that are not a credit pack (the API top-up opens a
 * server-created transaction). Null when either is missing or they disagree.
 */
export function resolvePaddleClient(env: PaddleEnv): { environment: PaddleEnvironment; clientToken: string } | null {
  const rawEnv = (env.NEXT_PUBLIC_PADDLE_ENV ?? "").trim().toLowerCase();
  const environment: PaddleEnvironment | null =
    rawEnv === "" || rawEnv === "sandbox" ? "sandbox" : rawEnv === "production" ? "production" : null;
  const clientToken = (env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "").trim();
  if (!environment || !TOKEN_RE.test(clientToken)) return null;
  if ((environment === "sandbox") !== clientToken.startsWith("test_")) return null;
  return { environment, clientToken };
}

export const paddleClient = resolvePaddleClient({
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN,
  NEXT_PUBLIC_PADDLE_ENV: process.env.NEXT_PUBLIC_PADDLE_ENV,
});

/** The server-side Paddle API (API balance top-ups): its key, the "API balance
 *  top-up" product the custom price hangs off, and the environment's base URL.
 *  Server env only — PADDLE_API_KEY is a secret and never reaches a browser. */
export interface PaddleApiConfig {
  apiKey: string;
  productId: string;
  baseUrl: string;
}

const PRODUCT_ID_RE = /^pro_[a-z0-9]{10,40}$/;

export function resolvePaddleApi(env: {
  PADDLE_API_KEY?: string;
  PADDLE_API_TOPUP_PRODUCT_ID?: string;
  NEXT_PUBLIC_PADDLE_ENV?: string;
}): PaddleApiConfig | null {
  const apiKey = (env.PADDLE_API_KEY ?? "").trim();
  const productId = (env.PADDLE_API_TOPUP_PRODUCT_ID ?? "").trim();
  const rawEnv = (env.NEXT_PUBLIC_PADDLE_ENV ?? "").trim().toLowerCase();
  if (apiKey.length < 20 || /\s/.test(apiKey) || !PRODUCT_ID_RE.test(productId)) return null;
  if (rawEnv !== "" && rawEnv !== "sandbox" && rawEnv !== "production") return null;
  // A live key against the sandbox (or the reverse) would fail at checkout.
  if (/^pdl_(sdbx|live)_/.test(apiKey) && apiKey.startsWith("pdl_live_") !== (rawEnv === "production")) return null;
  return {
    apiKey,
    productId,
    baseUrl: rawEnv === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com",
  };
}

/**
 * The server-side Paddle API for the customer portal (0034, "Manage
 * subscription"): only the API key and the environment's base URL — unlike
 * resolvePaddleApi, no top-up product is needed. Null when unset or when a
 * live key is paired with the sandbox (or the reverse).
 */
export function resolvePaddleServerKey(env: {
  PADDLE_API_KEY?: string;
  NEXT_PUBLIC_PADDLE_ENV?: string;
}): { apiKey: string; baseUrl: string } | null {
  const apiKey = (env.PADDLE_API_KEY ?? "").trim();
  const rawEnv = (env.NEXT_PUBLIC_PADDLE_ENV ?? "").trim().toLowerCase();
  if (apiKey.length < 20 || /\s/.test(apiKey)) return null;
  if (rawEnv !== "" && rawEnv !== "sandbox" && rawEnv !== "production") return null;
  if (/^pdl_(sdbx|live)_/.test(apiKey) && apiKey.startsWith("pdl_live_") !== (rawEnv === "production")) return null;
  return { apiKey, baseUrl: rawEnv === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com" };
}

/** The customer portal's overview link from a portal-session answer, or null. */
export function portalOverviewUrl(json: unknown): string | null {
  const url = (json as { data?: { urls?: { general?: { overview?: unknown } } } } | null)?.data?.urls?.general?.overview;
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)paddle\.com$/.test(u.hostname) ? url : null;
  } catch {
    return null;
  }
}

/** Next inlines NEXT_PUBLIC_* at build time only when each is named literally. */
export const paddleConfig: PaddleConfig | null = resolvePaddleConfig({
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN,
  NEXT_PUBLIC_PADDLE_ENV: process.env.NEXT_PUBLIC_PADDLE_ENV,
  NEXT_PUBLIC_PADDLE_PRICE_STARTER: process.env.NEXT_PUBLIC_PADDLE_PRICE_STARTER,
  NEXT_PUBLIC_PADDLE_PRICE_CREATOR: process.env.NEXT_PUBLIC_PADDLE_PRICE_CREATOR,
  NEXT_PUBLIC_PADDLE_PRICE_STUDIO: process.env.NEXT_PUBLIC_PADDLE_PRICE_STUDIO,
});

export type BuyAccess = "hidden" | "admin_only" | "allowed";

/**
 * What the Credits page offers. The operator's own organization never pays
 * (0020 exempts it), so it is never offered a checkout; nor is anyone when
 * Paddle is not configured. Buying is an owner/admin act — the same bar as
 * starting a paid run — so an editor or viewer is told who can, not shown a
 * button. (Anyone could, technically, pay for an organization; a payment is
 * never harmful to the organization it credits. The bar is about who decides
 * to spend the organization's money.)
 */
export function buyAccess(orgId: string | null | undefined, role: Role | null | undefined, config: PaddleConfig | null): BuyAccess {
  if (!config || !orgId || isCreditExempt(orgId)) return "hidden";
  return role && atLeast(role, "admin") ? "allowed" : "admin_only";
}

/** What the checkout carries to the webhook. Ids only; the amount is never here. */
export function checkoutCustomData(orgId: string, userId: string | null): { org_id: string; user_id?: string } {
  return userId ? { org_id: orgId, user_id: userId } : { org_id: orgId };
}

/**
 * Paddle's checkout has no Uzbek; Russian is the closer fallback for this
 * audience than English.
 */
export function paddleLocale(locale: Locale): "en" | "ru" {
  return locale === "en" ? "en" : "ru";
}

/**
 * Has the purchase reached the balance yet? The webhook credits
 * asynchronously (usually within seconds), so the page re-reads the balance
 * after checkout.completed and stops once it has grown.
 */
export function purchaseArrived(before: number, now: number): boolean {
  return Number.isFinite(before) && Number.isFinite(now) && now > before;
}

/** What Paddle.PricePreview answers — only the fields read here. */
export interface PricePreviewResponse {
  data?: { details?: { lineItems?: { price?: { id?: string }; formattedTotals?: { total?: string } }[] } };
}

/**
 * Paddle's localized total per price id, from a PricePreview answer. A line
 * without both an id and a formatted total is left out, so the caller shows
 * its fallback ("price shown at checkout") rather than a number we made up.
 */
export function previewTotals(preview: PricePreviewResponse | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of preview?.data?.details?.lineItems ?? []) {
    const id = line?.price?.id;
    const total = line?.formattedTotals?.total;
    if (typeof id === "string" && id && typeof total === "string" && total.trim()) out[id] = total.trim();
  }
  return out;
}
