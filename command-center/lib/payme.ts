/**
 * Selling credit packs through Payme Business (Uzcard/Humo), the pure,
 * client-safe half: the UZS catalog, this deployment's Payme settings resolved
 * into what a page may show, and the hosted-checkout link.
 *
 * The flow: our server opens an ORDER for one pack (payme_open_order, an
 * owner/admin of the organization, in their own session; see
 * app/api/billing/payme/checkout) and sends the browser to Payme's hosted
 * checkout with that order id and the pack's catalog amount. Payme then asks
 * the payme-merchant Edge Function whether that order and amount are payable,
 * and credits arrive only when Payme performs the transaction. The browser
 * names a pack by OUR id; it never names an amount Payme will accept (the Edge
 * Function checks the amount against its own copy of this catalog).
 *
 * The checkout link format and hosts are UNCONFIRMED against Payme's official
 * documentation (supabase/functions/_shared/payme.ts, PAYME_SPEC).
 */

import { atLeast, type Role } from "@/lib/auth/roles-shared";
import { isCreditExempt } from "@/lib/credits";

/**
 * Must equal PAYME_PACKS in supabase/functions/_shared/payme.ts (a test compares them). The price is in whole so'm; null
 * means not on sale through Payme. The UZS prices are the owner's decision and have not been made, so none is set here.
 */
export const PAYME_CATALOG_PACKS: readonly { id: string; credits: number; uzs: number | null }[] = [
  { id: "starter", credits: 1000, uzs: null },
  { id: "creator", credits: 5000, uzs: null },
  { id: "studio", credits: 20000, uzs: null },
];

export type PaymeEnvironment = "test" | "live";

/** Must equal PAYME_SPEC.checkoutBase in the shared module. */
export const PAYME_CHECKOUT_BASE: Record<PaymeEnvironment, string> = {
  test: "https://test.paycom.uz",
  live: "https://checkout.paycom.uz",
};

/** Must equal PAYME_SPEC.accountField: the account field the merchant cabinet is configured with. */
export const PAYME_ACCOUNT_FIELD = "order_id";

/** Must equal PAYME_ORDER_ID_RE in the shared module: what payme_open_order returns. */
export const PAYME_ORDER_ID_RE = /^[0-9a-f]{32}$/;

/** The server env this reads. None of it is NEXT_PUBLIC_; the merchant id is not a secret (it is in every checkout link). */
export interface PaymeEnv {
  PAYME_MERCHANT_ID?: string;
  PAYME_ENV?: string;
  PAYME_TEST_ORG_IDS?: string;
}

export interface PaymeServerConfig {
  merchantId: string;
  environment: PaymeEnvironment;
  testOrgs: ReadonlySet<string>;
}

const MERCHANT_ID_RE = /^[A-Za-z0-9]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * This deployment's Payme settings, or null when Payme is not configured. Test unless live is asked for exactly; an
 * environment that is neither (a typo) is null, never a guess about which cashbox to send a buyer to.
 */
export function resolvePaymeServer(env: PaymeEnv): PaymeServerConfig | null {
  const rawEnv = (env.PAYME_ENV ?? "").trim().toLowerCase();
  const environment: PaymeEnvironment | null = rawEnv === "" || rawEnv === "test" ? "test" : rawEnv === "live" ? "live" : null;
  const merchantId = (env.PAYME_MERCHANT_ID ?? "").trim();
  if (!environment || !MERCHANT_ID_RE.test(merchantId)) return null;
  const testOrgs = new Set((env.PAYME_TEST_ORG_IDS ?? "").split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter((x) => UUID_RE.test(x)));
  return { merchantId, environment, testOrgs };
}

export interface PaymePackOnSale {
  id: string;
  credits: number;
  uzs: number;
}

/** The packs that carry a positive whole-so'm price. */
export function paymePacksOnSale(packs: readonly { id: string; credits: number; uzs: number | null }[] = PAYME_CATALOG_PACKS): PaymePackOnSale[] {
  return packs.flatMap((p) => (typeof p.uzs === "number" && Number.isSafeInteger(p.uzs) && p.uzs > 0 ? [{ id: p.id, credits: p.credits, uzs: p.uzs }] : []));
}

/** Live: everyone. Test mode on a real database: only PAYME_TEST_ORG_IDS (the Edge Function applies the same list). */
export function paymeSellsTo(cfg: PaymeServerConfig | null, orgId: string | null | undefined): boolean {
  if (!cfg || !orgId) return false;
  return cfg.environment === "live" || cfg.testOrgs.has(orgId.toLowerCase());
}

/** What a page may know: the mode (for the test badge) and the packs on sale with their price. No merchant id. */
export interface PaymeView {
  environment: PaymeEnvironment;
  packs: PaymePackOnSale[];
}

/** Null (show nothing) unless Payme is configured, sells to this organization, and at least one pack has a price. */
export function paymeViewFor(
  cfg: PaymeServerConfig | null,
  orgId: string | null | undefined,
  packs: readonly { id: string; credits: number; uzs: number | null }[] = PAYME_CATALOG_PACKS,
): PaymeView | null {
  if (!cfg || !paymeSellsTo(cfg, orgId) || isCreditExempt(orgId)) return null;
  const onSale = paymePacksOnSale(packs);
  return onSale.length > 0 ? { environment: cfg.environment, packs: onSale } : null;
}

/** An owner/admin buys; a member sees nothing to press. */
export function paymeBuyAllowed(role: Role | null | undefined): boolean {
  return Boolean(role && atLeast(role, "admin"));
}

export type PaymeLang = "uz" | "ru" | "en";

export function paymeLang(raw: unknown): PaymeLang {
  return raw === "ru" || raw === "en" ? raw : "uz";
}

/**
 * The hosted checkout link: {base}/{base64("m=<merchant>;ac.order_id=<order>;a=<tiyin>;l=<lang>;c=<return url>")}.
 * `;` separates the parameters, so a return URL that contains one (or is not https) is refused rather than sent broken.
 */
export function paymeCheckoutUrl(cfg: PaymeServerConfig, o: { orderId: string; tiyin: number; lang: PaymeLang; returnUrl: string }): string | null {
  if (!PAYME_ORDER_ID_RE.test(o.orderId) || !Number.isSafeInteger(o.tiyin) || o.tiyin <= 0) return null;
  // ASCII only, so btoa (one byte per character) encodes it exactly.
  if (o.returnUrl.includes(";") || !/^https:\/\/[\x21-\x7e]+$/.test(o.returnUrl)) return null;
  const params = `m=${cfg.merchantId};ac.${PAYME_ACCOUNT_FIELD}=${o.orderId};a=${o.tiyin};l=${o.lang};c=${o.returnUrl}`;
  return `${PAYME_CHECKOUT_BASE[cfg.environment]}/${btoa(params)}`;
}

/** A catalog price as a page shows it, in so'm with no fraction ("120 000 UZS" written the locale's way). */
export function paymePriceText(uzs: number, locale: string): string {
  const tag = locale === "uz" ? "uz-UZ" : locale === "ru" ? "ru-RU" : "en-US";
  return new Intl.NumberFormat(tag, { style: "currency", currency: "UZS", maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(uzs);
}
