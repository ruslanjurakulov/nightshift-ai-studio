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

const PRICE_ID_RE = /^pri_[a-z0-9]{10,40}$/;
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
  const rawEnv = (env.NEXT_PUBLIC_PADDLE_ENV ?? "").trim().toLowerCase();
  const environment: PaddleEnvironment | null =
    rawEnv === "" || rawEnv === "sandbox" ? "sandbox" : rawEnv === "production" ? "production" : null;
  const clientToken = (env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "").trim();
  if (!environment || !TOKEN_RE.test(clientToken)) return null;
  if ((environment === "sandbox") !== clientToken.startsWith("test_")) return null;

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
