/**
 * Dodo Payments webhook — the pure half: the catalog, Standard Webhooks
 * signature verification, and what each event means for an organization's
 * credits. The second payment provider next to Paddle (docs/DODO_SETUP.md).
 *
 * Runtime-neutral, like ./paddle.ts: only Web Crypto, fetch and JSON, so the
 * Supabase Edge Function (supabase/functions/dodo-webhook/index.ts) runs it
 * as-is and the Command Center's vitest suite tests it directly
 * (command-center/tests/dodo-webhook.test.ts). It imports ./paddle.ts for the
 * pieces that are provider-neutral (the capped body read, the proportional
 * refund rule, the store error), so the two webhooks cannot drift apart on
 * them. Paddle's file is not changed by this one.
 *
 * Every fact about Dodo below is from docs.dodopayments.com, read 2026-11-12:
 *   webhooks (signature, headers, retries): /developer-resources/webhooks
 *   event types: /developer-resources/webhooks/intents/webhook-events-guide
 *   payloads: /developer-resources/webhooks/intents/{payment,refund,dispute,subscription}
 *   subscription states: /features/subscription
 * A field the docs do not promise is treated as absent, and an absent field
 * that a decision needs makes the event `rejected` for a person, never guessed.
 *
 * The rules this file exists to keep — the same as Paddle's:
 *
 *   - Nothing the browser sent decides an amount. The Command Center's server
 *     creates the checkout session and puts { org_id, user_id } into its
 *     metadata — WHO is paying, nothing more. The credits come from the
 *     catalog by Dodo product id, and the amount Dodo charged must equal the
 *     catalog's price for that product, in USD, before anything is granted.
 *   - Every grant goes through the same database functions as Paddle's:
 *     add_purchased_credits (packs), grant_subscription_credits_for (plan
 *     periods, 0143: 0034's body under a provider) and refund_purchased_credits
 *     (refunds and lost disputes). The Dodo payment id is the external id, so
 *     a payment delivered twice, under two webhook ids, still credits once.
 *   - Idempotency by event: the Standard Webhooks `webhook-id` is the
 *     payment_events key (provider 'dodo'), so a retry or a dashboard replay
 *     of a processed event changes nothing.
 *   - A paid purchase that cannot be credited is answered 200 and recorded
 *     `rejected`: retrying cannot fix it, a person must. A failure retrying CAN
 *     fix (the database, an event that arrived before the one it depends on)
 *     is answered 5xx so Dodo delivers it again.
 *   - No secret, and nothing of the payer beyond ids, is ever logged or stored.
 */

import {
  MAX_BODY_BYTES,
  StoreError,
  readBodyCapped,
  refundCredits,
  type EventRecord,
  type EventStatus,
  type Logger,
  type PurchaseRecord,
  type SubscriptionStatus,
  type WebhookResponse,
} from "./paddle.ts";

export { MAX_BODY_BYTES, StoreError, readBodyCapped };
export type { EventRecord, EventStatus, Logger, PurchaseRecord, WebhookResponse };

// ───────────────────────────────────────────────────────────────────────────
// The catalog
// ───────────────────────────────────────────────────────────────────────────

/**
 * The packs on sale through Dodo, with the price each must be charged at, in
 * US cents (before tax). The owner's catalog, 2026-11-12: Starter 1,000
 * credits $10, Creator 5,000 $45, Studio 20,000 $160. The Command Center's copy
 * (command-center/lib/dodo.ts) must say the same; a test compares the two, and
 * another compares the credits with Paddle's CREDIT_PACKS.
 *
 * The price lives here, not in an env var, on purpose: the page shows it, the
 * webhook checks it, and the owner sets it in Dodo — three places that must
 * agree, and a change of price is a reviewed change, not a typo in a variable.
 * A product charged at anything else is recorded `rejected`, not credited.
 */
export const DODO_PACKS = [
  { id: "starter", credits: 1000, usdCents: 1000 },
  { id: "creator", credits: 5000, usdCents: 4500 },
  { id: "studio", credits: 20000, usdCents: 16000 },
] as const;

export type DodoPackId = (typeof DODO_PACKS)[number]["id"];

/**
 * Monthly plan prices in US cents (before tax), by plan id in the plans table
 * (0034; the display names are 0095's: creator = Plus, pro = Pro, studio =
 * Business). The credits of a period come from the database (plans.monthly_credits),
 * never from here. A plan without a price here cannot be sold through Dodo.
 */
export const DODO_PLAN_PRICES: Readonly<Record<string, number>> = {
  creator: 1900,
  pro: 4900,
  studio: 12900,
};

/** Dodo's documented examples: pdt_0NVbdIG3JNg9Yc8ey5JHW, pay_gr4RizvMOXFJ6xca3y2tU, sub_Iuaq622bbmmfOGrVTqdXv,
 *  cus_TV52uJWWXt2yIoBBxpjaa. The docs promise no length, so these accept 3-64 ASCII letters and digits after
 *  the prefix (0143's subscription checks say the same). */
export const DODO_PRODUCT_ID_RE = /^pdt_[A-Za-z0-9]{3,64}$/;
const PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{3,64}$/;
const SUBSCRIPTION_ID_RE = /^sub_[A-Za-z0-9]{3,64}$/;
const CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]{3,64}$/;
/** Refund and dispute ids: the docs show no example, so only a safe shape is required. They are namespaced before
 *  they reach the ledger (refundKey), where every external id is unique across providers and kinds. */
const OTHER_ID_RE = /^[A-Za-z0-9_-]{3,100}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Standard Webhooks message id (msg_…); the payment_events key is limited to 200 characters. */
const WEBHOOK_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface DodoPack {
  id: DodoPackId;
  credits: number;
  usdCents: number;
}

/** product id -> pack. */
export type DodoPackTable = ReadonlyMap<string, DodoPack>;
/** product id -> { plan id, price }. */
export type DodoPlanTable = ReadonlyMap<string, { planId: string; usdCents: number }>;

/** The webhook's env var for a pack's Dodo product id, e.g. DODO_PRODUCT_STARTER. */
export function dodoProductEnvName(pack: DodoPackId): string {
  return `DODO_PRODUCT_${pack.toUpperCase()}`;
}

/** product id -> pack, from the environment. A missing or malformed id leaves that pack unsellable. */
export function dodoPackTableFromEnv(get: (name: string) => string | undefined): DodoPackTable {
  const table = new Map<string, DodoPack>();
  for (const pack of DODO_PACKS) {
    const id = (get(dodoProductEnvName(pack.id)) ?? "").trim();
    if (DODO_PRODUCT_ID_RE.test(id) && !table.has(id)) table.set(id, { id: pack.id, credits: pack.credits, usdCents: pack.usdCents });
  }
  return table;
}

/** DODO_PLAN_PRO=pdt_… -> plan "pro". The plan ids themselves live in the database; one the database does not
 *  know is refused there. */
export const DODO_PLAN_ENV_RE = /^DODO_PLAN_([A-Z][A-Z0-9_]{1,30})$/;

/**
 * The plan products from the environment. Skipped: a malformed id, a plan with
 * no price in DODO_PLAN_PRICES, and an id that is also a pack — one product
 * cannot be both a one-time pack and a subscription.
 */
export function dodoPlanTableFromEnv(
  entries: Iterable<readonly [string, string | undefined]>,
  packs: DodoPackTable = new Map(),
): DodoPlanTable {
  const table = new Map<string, { planId: string; usdCents: number }>();
  for (const [name, raw] of entries) {
    const m = DODO_PLAN_ENV_RE.exec(name);
    if (!m) continue;
    const id = (raw ?? "").trim();
    const planId = m[1].toLowerCase();
    const usdCents = DODO_PLAN_PRICES[planId];
    if (!DODO_PRODUCT_ID_RE.test(id) || packs.has(id) || table.has(id) || !Number.isInteger(usdCents)) continue;
    table.set(id, { planId, usdCents });
  }
  return table;
}

// ───────────────────────────────────────────────────────────────────────────
// Signature (Standard Webhooks)
// ───────────────────────────────────────────────────────────────────────────

/** "The Standard Webhooks libraries allow 5 minutes" (Dodo's webhooks page); a captured delivery replayed later fails. */
export const SIGNATURE_TOLERANCE_S = 300;

export type DodoSignatureCheck = "ok" | "missing" | "malformed" | "stale" | "mismatch";

export interface DodoSignatureHeaders {
  id: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
}

function base64ToBytes(b64: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * The HMAC key from the endpoint's signing secret: "If it starts with whsec_,
 * remove that prefix, then base64-decode the rest". Null when it does not
 * decode to at least 16 bytes — a pasted wrong value must make the webhook
 * refuse every delivery (500, said once), not verify against garbage.
 */
export function dodoSigningKey(secret: string | null | undefined): Uint8Array | null {
  const s = (secret ?? "").trim();
  if (!s) return null;
  const bytes = base64ToBytes(s.startsWith("whsec_") ? s.slice("whsec_".length) : s);
  return bytes && bytes.byteLength >= 16 ? bytes : null;
}

/**
 * `webhook-signature: v1,<base64> v1,<base64>` — one or more space-separated
 * signatures (several while a secret is being rotated: the old one stays
 * valid for 24 hours). Entries of another version are skipped; only well-formed
 * v1 signatures of 32 bytes (HMAC-SHA256) are returned.
 */
export function parseDodoSignatures(header: string | null | undefined): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const part of (header ?? "").trim().split(/\s+/)) {
    const comma = part.indexOf(",");
    if (comma <= 0 || part.slice(0, comma) !== "v1") continue;
    const bytes = base64ToBytes(part.slice(comma + 1));
    if (bytes && bytes.byteLength === 32) out.push(bytes);
  }
  return out;
}

/**
 * HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}` with the
 * decoded secret, compared by SubtleCrypto's verify() (constant-time), so a
 * forger learns nothing from how long a wrong guess took. The raw body exactly
 * as received — re-serialised JSON would not match. Any one v1 signature
 * matching is enough.
 */
export async function verifyDodoSignature(
  rawBody: string,
  headers: DodoSignatureHeaders,
  key: Uint8Array,
  nowSeconds: number,
  toleranceS: number = SIGNATURE_TOLERANCE_S,
): Promise<DodoSignatureCheck> {
  const id = (headers.id ?? "").trim();
  const ts = (headers.timestamp ?? "").trim();
  const sig = (headers.signature ?? "").trim();
  if (!id || !ts || !sig) return "missing";
  if (!/^\d{1,12}$/.test(ts) || !WEBHOOK_ID_RE.test(id)) return "malformed";
  const signatures = parseDodoSignatures(sig);
  if (signatures.length === 0) return "malformed";
  if (Math.abs(nowSeconds - Number(ts)) > toleranceS) return "stale";
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const data = new TextEncoder().encode(`${id}.${ts}.${rawBody}`);
  for (const s of signatures) {
    if (await crypto.subtle.verify("HMAC", cryptoKey, s, data)) return "ok";
  }
  return "mismatch";
}

// ───────────────────────────────────────────────────────────────────────────
// What an event means
// ───────────────────────────────────────────────────────────────────────────

export interface DodoEvent {
  /** The `webhook-id` header: the idempotency key. */
  eventId: string;
  /** The body's `type`, e.g. payment.succeeded. */
  eventType: string;
  /** The body's ISO `timestamp` (when the event occurred): orders subscription states. */
  occurredAt: string | null;
  data: Record<string, unknown>;
}

/** The events that move credits or a subscription's state. Anything else is answered 200 `ignored`. */
export const DODO_SUBSCRIPTION_EVENTS = [
  "subscription.active",
  "subscription.updated",
  "subscription.past_due",
  "subscription.on_hold",
  "subscription.paused",
  "subscription.unpaused",
  "subscription.renewed",
  "subscription.plan_changed",
  "subscription.cancelled",
  "subscription.expired",
] as const;
export const DODO_HANDLED_EVENTS = [
  "payment.succeeded",
  "refund.succeeded",
  "dispute.accepted",
  "dispute.lost",
  "dispute.expired",
  ...DODO_SUBSCRIPTION_EVENTS,
] as const;

/**
 * Dodo's subscription status -> ours (0034's five). From /features/subscription:
 * past_due keeps access (a grace period), on_hold removes it (a renewal failed),
 * paused freezes it, cancelled will not renew, expired reached its term. on_hold
 * becomes `paused` because that is our status without access that can still come
 * back; cancelled and expired are both `canceled`. pending and failed (creation
 * failed) are not a subscription yet: those events are ignored.
 */
export const DODO_STATUS_MAP: Readonly<Record<string, SubscriptionStatus>> = {
  active: "active",
  past_due: "past_due",
  on_hold: "paused",
  paused: "paused",
  cancelled: "canceled",
  expired: "canceled",
};

export type DodoDecision =
  | { kind: "ignore"; detail: string }
  | { kind: "reject"; detail: string; orgId: string | null; transactionId: string | null; currency: string | null; amountMinor: number | null }
  | { kind: "purchase"; orgId: string; userId: string | null; transactionId: string; credits: number; currency: string; amountMinor: number; note: string }
  | {
      kind: "subscription_payment";
      orgId: string | null;
      userId: string | null;
      subscriptionId: string;
      transactionId: string;
      periodStart: string;
      periodEnd: string;
      currency: string;
      amountMinor: number;
      /** Tax Dodo reports for this payment (null when it reports none): the amount check happens once the plan is known. */
      taxMinor: number | null;
      /** The products the payment names, when it names any (the docs promise product_cart only for one-time payments). */
      cartProducts: string[];
      chargeType: string;
    }
  | {
      kind: "subscription_state";
      orgId: string | null;
      subscriptionId: string;
      customerId: string | null;
      planId: string | null;
      productId: string | null;
      status: SubscriptionStatus;
      periodStart: string | null;
      periodEnd: string | null;
      cancelAtPeriodEnd: boolean;
      canceledAt: string | null;
      occurredAt: string | null;
    }
  | {
      kind: "refund";
      reason: "refund" | "chargeback";
      transactionId: string;
      /** The ledger's refund id: provider- and kind-namespaced (dodo_refund:… / dodo_dispute:…). */
      refundKey: string;
      full: boolean;
      currency: string | null;
      amountMinor: number | null;
    };

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Dodo sends money as an integer of the currency's smallest unit ("total_amount": 2999). */
function minorInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function currencyCode(v: unknown): string | null {
  const s = str(v);
  return s && /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : null;
}

/** An ISO timestamp Dodo sent, or null. Never a date we made up. */
function isoTime(v: unknown): string | null {
  const s = str(v);
  if (!s || s.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(Date.parse(s))) return null;
  return s;
}

function uuidOf(v: unknown): string | null {
  const s = str(v);
  return s && UUID_RE.test(s) ? s.toLowerCase() : null;
}

/** The body: { business_id, type, timestamp, data }. Null when it is not one. */
export function parseDodoEvent(rawBody: string, webhookId: string): DodoEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const o = obj(json);
  const eventType = str(o.type);
  if (!WEBHOOK_ID_RE.test(webhookId) || !eventType || eventType.length > 100 || !o.data || typeof o.data !== "object") return null;
  return { eventId: webhookId, eventType, occurredAt: isoTime(o.timestamp), data: obj(o.data) };
}

/**
 * Does what Dodo charged pay exactly the catalog price? `total_amount` is
 * "including tax"; `tax` is the tax collected (nullable). Two shapes are
 * accepted, nothing else:
 *   tax-inclusive price: total_amount = the price (the tax is inside it);
 *   tax-exclusive price: total_amount − tax = the price.
 * Either way the amount paid net of tax is never less than the price the
 * credits stand for. A rounding surprise, a price changed in Dodo without a
 * code change, a localized or PPP price, an overridden amount: all rejected.
 */
export function amountMatches(totalMinor: number, taxMinor: number | null, expectedCents: number): boolean {
  if (!Number.isSafeInteger(expectedCents) || expectedCents <= 0 || totalMinor <= 0) return false;
  if (totalMinor === expectedCents) return true;
  return taxMinor !== null && taxMinor >= 0 && totalMinor - taxMinor === expectedCents;
}

/** A payment that carries any discount. The checkout turns discount codes off (allow_discount_code: false). */
function discounted(data: Record<string, unknown>): boolean {
  if (str(data.discount_id)) return true;
  return Array.isArray(data.discounts) && data.discounts.length > 0;
}

/** payment.succeeded -> a pack's credits, or a plan period to be checked against the subscription's plan. */
export function decideDodoPayment(data: Record<string, unknown>, packs: DodoPackTable, plans: DodoPlanTable): DodoDecision {
  const paymentRaw = str(data.payment_id);
  const transactionId = paymentRaw && PAYMENT_ID_RE.test(paymentRaw) ? paymentRaw : null;
  const meta = obj(data.metadata);
  const orgId = uuidOf(meta.org_id);
  const userId = uuidOf(meta.user_id);
  const currency = currencyCode(data.currency);
  const total = minorInt(data.total_amount);
  const tax = data.tax === null || data.tax === undefined ? null : minorInt(data.tax);
  const reject = (detail: string): DodoDecision => ({ kind: "reject", detail, orgId, transactionId, currency, amountMinor: total });

  if (!transactionId) return reject("payment without a valid payment_id");
  if (str(data.status) !== "succeeded") return { kind: "ignore", detail: `payment status ${String(data.status)}` };
  if (data.is_update_payment_method === true) return { kind: "ignore", detail: "a payment-method update, not a purchase" };
  if (currency !== "USD") return reject("paid, but not in USD — not credited (adaptive or localized pricing must stay off)");
  if (total === null || total <= 0) return reject("paid, but total_amount is zero or cannot be read — not credited");
  if (data.tax !== null && data.tax !== undefined && tax === null) return reject("paid, but tax cannot be read — not credited");
  if (discounted(data)) return reject("paid with a discount — discounted Dodo payments are not credited automatically; grant by hand");
  if (data.is_multi_subscription === true) return reject("one payment for several subscriptions — not credited");

  const cart = Array.isArray(data.product_cart) ? data.product_cart.map(obj) : [];
  const ids = Array.isArray(data.subscription_ids) ? data.subscription_ids.map(str).filter((s): s is string => Boolean(s)) : [];
  const subRaw = str(data.subscription_id) ?? (ids.length === 1 ? ids[0] : null);
  if (ids.length > 1) return reject("one payment for several subscriptions — not credited");

  if (subRaw) {
    if (!SUBSCRIPTION_ID_RE.test(subRaw)) return reject("paid plan with a malformed subscription id — not credited");
    const chargeType = str(data.charge_type);
    if (chargeType !== "new" && chargeType !== "renewal") {
      return reject(
        chargeType === "plan_change"
          ? "plan-change charge — the pro-rata top-up is not automated for Dodo; grant it by hand"
          : `subscription charge of type ${chargeType ?? "(none)"} — not credited`,
      );
    }
    const cartProducts: string[] = [];
    for (const item of cart) {
      const pid = str(item.product_id);
      if (!pid || packs.has(pid) || !plans.has(pid)) return reject("a plan payment whose cart names something other than a plan — not credited");
      cartProducts.push(pid);
    }
    const periods = Array.isArray(data.service_periods) ? data.service_periods.map(obj) : [];
    const period = periods.find((p) => str(p.subscription_id) === subRaw) ?? null;
    const periodStart = period ? isoTime(period.starts_at) : null;
    const periodEnd = period ? isoTime(period.ends_at) : null;
    if (!periodStart || !periodEnd || Date.parse(periodEnd) <= Date.parse(periodStart))
      return reject("paid plan without a service period — not credited");
    return {
      kind: "subscription_payment",
      orgId,
      userId,
      subscriptionId: subRaw,
      transactionId,
      periodStart,
      periodEnd,
      currency,
      amountMinor: total,
      taxMinor: tax,
      cartProducts,
      chargeType,
    };
  }

  if (!orgId) return reject("paid, but the metadata carries no organization id — not credited");
  if (cart.length === 0) return reject("paid, but the payment names no product — not credited");
  let credits = 0;
  let expected = 0;
  const lines: string[] = [];
  for (const item of cart) {
    const pid = str(item.product_id);
    const pack = pid ? packs.get(pid) : undefined;
    if (!pack) return reject(`paid, but product ${pid ?? "(none)"} is not a credit pack on this deployment — not credited`);
    const qty = item.quantity;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 1000)
      return reject("paid, but a line has an invalid quantity — not credited");
    credits += pack.credits * qty;
    expected += pack.usdCents * qty;
    lines.push(`${qty}× ${pack.id}`);
  }
  if (!amountMatches(total, tax, expected))
    return reject(`paid ${total} (tax ${tax ?? "none"}) USD cents, but the catalog price is ${expected} — not credited`);
  const note = [`Dodo ${transactionId}: ${lines.join(", ")}`, userId ? `bought by user ${userId}` : null].filter(Boolean).join(" · ");
  return { kind: "purchase", orgId, userId, transactionId, credits, currency, amountMinor: total, note };
}

/** subscription.* -> the subscription's state as Dodo now reports it. */
export function decideDodoSubscription(event: DodoEvent, plans: DodoPlanTable): DodoDecision {
  const data = event.data;
  const subRaw = str(data.subscription_id);
  const orgId = uuidOf(obj(data.metadata).org_id);
  if (!subRaw || !SUBSCRIPTION_ID_RE.test(subRaw))
    return { kind: "reject", detail: "subscription without a valid id", orgId, transactionId: null, currency: null, amountMinor: null };
  const raw = str(data.status);
  const status = raw ? DODO_STATUS_MAP[raw] : undefined;
  if (!status) return { kind: "ignore", detail: `subscription status ${String(data.status)} is not handled` };
  const productRaw = str(data.product_id);
  const productId = productRaw && DODO_PRODUCT_ID_RE.test(productRaw) ? productRaw : null;
  const plan = productId ? plans.get(productId) : undefined;
  const customerRaw = str(obj(data.customer).customer_id);
  return {
    kind: "subscription_state",
    orgId,
    subscriptionId: subRaw,
    customerId: customerRaw && CUSTOMER_ID_RE.test(customerRaw) ? customerRaw : null,
    // A product this deployment no longer maps must not stop a cancellation from landing: the plan is left as it
    // was (upsert_subscription_for keeps it), and a NEW subscription without a known plan is refused there.
    planId: plan ? plan.planId : null,
    productId: plan ? productId : null,
    status,
    periodStart: isoTime(data.previous_billing_date),
    periodEnd: isoTime(data.next_billing_date),
    // "Cancel at next billing date" keeps the plan to the end of the period that was paid for — the same rule as a
    // Paddle scheduled cancellation (cancel_at_period_end), shown as "ends on" on the Credits page.
    cancelAtPeriodEnd: data.cancel_at_next_billing_date === true,
    canceledAt: isoTime(data.cancelled_at),
    occurredAt: event.occurredAt,
  };
}

/** refund.succeeded -> take credits back in proportion (a full refund: everything not already refunded). */
export function decideDodoRefund(data: Record<string, unknown>): DodoDecision {
  const status = str(data.status);
  if (status !== "succeeded") return { kind: "ignore", detail: `refund is ${status ?? "(no status)"}, not succeeded` };
  const refundId = str(data.refund_id);
  const paymentId = str(data.payment_id);
  if (!refundId || !OTHER_ID_RE.test(refundId) || !paymentId || !PAYMENT_ID_RE.test(paymentId))
    return { kind: "reject", detail: "refund without a valid refund or payment id", orgId: null, transactionId: null, currency: null, amountMinor: null };
  return {
    kind: "refund",
    reason: "refund",
    transactionId: paymentId,
    refundKey: `dodo_refund:${refundId}`,
    // Only an explicit is_partial: false is a full refund; anything else is sized by its amount.
    full: data.is_partial === false,
    currency: currencyCode(data.currency),
    amountMinor: minorInt(data.amount),
  };
}

/**
 * dispute.accepted / dispute.lost -> a chargeback: the money went back to the
 * cardholder, so the credits go too, sized by the disputed amount. The docs
 * describe `amount` as "a string to accommodate precision" without saying in
 * which unit, so only a string of digits (read as the smallest unit, like every
 * other Dodo amount) is sized; anything else is `rejected` for a person. A
 * dispute that expired "typically resolves against you" — not certainly — so
 * it is `rejected` too: a person checks the outcome in Dodo and takes the
 * credits back by hand if it was lost. Opened, challenged, won and cancelled
 * disputes move nothing (ignored by the allow-list).
 */
export function decideDodoDispute(eventType: string, data: Record<string, unknown>): DodoDecision {
  const disputeId = str(data.dispute_id);
  const paymentId = str(data.payment_id);
  if (!disputeId || !OTHER_ID_RE.test(disputeId) || !paymentId || !PAYMENT_ID_RE.test(paymentId))
    return { kind: "reject", detail: "dispute without a valid dispute or payment id", orgId: null, transactionId: null, currency: null, amountMinor: null };
  if (eventType === "dispute.expired")
    return {
      kind: "reject",
      detail: `dispute ${disputeId} expired unresolved — check its outcome in Dodo; take the credits back by hand if it was lost`,
      orgId: null,
      transactionId: paymentId,
      currency: currencyCode(data.currency),
      amountMinor: null,
    };
  const status = str(data.dispute_status);
  if (status !== null && status !== "dispute_lost" && status !== "dispute_accepted")
    return { kind: "ignore", detail: `${eventType} whose dispute_status is ${status}` };
  const amount = str(data.amount);
  return {
    kind: "refund",
    reason: "chargeback",
    transactionId: paymentId,
    refundKey: `dodo_dispute:${disputeId}`,
    full: false,
    currency: currencyCode(data.currency),
    amountMinor: amount && /^\d{1,15}$/.test(amount) ? Number(amount) : null,
  };
}

export function decideDodoEvent(event: DodoEvent, packs: DodoPackTable, plans: DodoPlanTable): DodoDecision {
  if ((DODO_SUBSCRIPTION_EVENTS as readonly string[]).includes(event.eventType)) return decideDodoSubscription(event, plans);
  switch (event.eventType) {
    case "payment.succeeded":
      return decideDodoPayment(event.data, packs, plans);
    case "refund.succeeded":
      return decideDodoRefund(event.data);
    case "dispute.accepted":
    case "dispute.lost":
    case "dispute.expired":
      return decideDodoDispute(event.eventType, event.data);
    default:
      return { kind: "ignore", detail: `event type ${event.eventType} is not handled` };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The handler
// ───────────────────────────────────────────────────────────────────────────

export interface DodoSubscriptionRow {
  orgId: string;
  planId: string;
  productId: string | null;
}

/** What the handler needs from the database — the service-role side. */
export interface DodoStore {
  eventStatus(eventId: string): Promise<EventStatus | null>;
  recordEvent(record: EventRecord): Promise<void>;
  orgExists(orgId: string): Promise<boolean>;
  addPurchasedCredits(orgId: string, credits: number, externalId: string, note: string): Promise<{ duplicate: boolean }>;
  findPurchase(paymentId: string): Promise<PurchaseRecord | null>;
  refundPurchasedCredits(
    externalId: string,
    refundId: string,
    amount: number | null,
    note: string,
    reason: "refund" | "chargeback",
  ): Promise<{ duplicate: boolean; requested: number; taken: number; shortfall: number }>;
  findSubscription(subscriptionId: string): Promise<DodoSubscriptionRow | null>;
  upsertSubscription(s: {
    orgId: string;
    subscriptionId: string;
    customerId: string | null;
    planId: string | null;
    productId: string | null;
    status: SubscriptionStatus;
    periodStart: string | null;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    canceledAt: string | null;
    occurredAt: string | null;
  }): Promise<{ stale: boolean }>;
  grantSubscriptionCredits(g: {
    orgId: string;
    subscriptionId: string;
    planId: string;
    periodStart: string;
    periodEnd: string;
    paymentId: string;
    note: string;
    productId: string | null;
  }): Promise<{ duplicate: boolean; granted: number }>;
}

/** SQLSTATEs that retrying cannot fix (the same set as Paddle's): the event is recorded as rejected. */
const PERMANENT_CODES = new Set(["23505", "22023", "P0002"]);

export interface DodoWebhookRequest {
  method: string;
  rawBody: string;
  headers: DodoSignatureHeaders;
}

export async function handleDodoWebhook(
  req: DodoWebhookRequest,
  deps: {
    /** The endpoint's signing secret (whsec_…), DODO_WEBHOOK_SECRET. */
    secret: string;
    packs: DodoPackTable;
    plans: DodoPlanTable;
    store: DodoStore;
    now?: () => number;
    log?: Logger;
  },
): Promise<WebhookResponse> {
  const log: Logger = deps.log ?? console;
  if (req.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
  const key = dodoSigningKey(deps.secret);
  if (!key) {
    log.error("dodo-webhook: DODO_WEBHOOK_SECRET is not set to a whsec_ signing secret — every delivery is refused");
    return { status: 500, body: { error: "webhook not configured" } };
  }
  if (req.rawBody.length > MAX_BODY_BYTES) return { status: 413, body: { error: "payload too large" } };

  const nowS = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
  const check = await verifyDodoSignature(req.rawBody, req.headers, key, nowS);
  if (check !== "ok") {
    // The reason only — never a header, the body or the secret.
    log.warn(`dodo-webhook: signature ${check}; delivery refused`);
    return { status: 401, body: { error: "invalid signature" } };
  }

  const event = parseDodoEvent(req.rawBody, (req.headers.id ?? "").trim());
  if (!event) return { status: 400, body: { error: "not a Dodo event" } };

  const base = { eventId: event.eventId, eventType: event.eventType, occurredAt: event.occurredAt };
  try {
    const prior = await deps.store.eventStatus(event.eventId);
    if (prior && prior !== "failed") return { status: 200, body: { ok: true, duplicate: true, status: prior } };

    const decision = decideDodoEvent(event, deps.packs, deps.plans);
    const record = await execute(decision, deps.store, deps.plans, log, event.eventId);
    await deps.store.recordEvent({ ...base, ...record.row });
    if (record.row.status === "rejected" || record.httpStatus >= 500) {
      log.warn(`dodo-webhook: ${event.eventId} ${record.row.status} — ${record.row.detail}`);
    }
    return { status: record.httpStatus, body: { ok: record.httpStatus < 300, status: record.row.status } };
  } catch (err) {
    const code = err instanceof StoreError ? err.code : null;
    log.error(`dodo-webhook: ${event.eventId} failed (${code ?? (err instanceof Error ? err.name : "error")}); Dodo will retry`);
    try {
      await deps.store.recordEvent({
        ...base,
        status: "failed",
        detail: `temporary failure${code ? ` (${code})` : ""}; waiting for Dodo's retry`,
      });
    } catch {
      // The audit row is best effort here; the 500 below is what matters.
    }
    return { status: 500, body: { error: "temporary failure" } };
  }
}

type RecordFields = Omit<EventRecord, "eventId" | "eventType" | "occurredAt">;

function permanent(err: unknown): string | null {
  return err instanceof StoreError && err.code && PERMANENT_CODES.has(err.code) ? err.code : null;
}

async function execute(
  decision: DodoDecision,
  store: DodoStore,
  plans: DodoPlanTable,
  log: Logger,
  eventId: string,
): Promise<{ httpStatus: number; row: RecordFields }> {
  switch (decision.kind) {
    case "ignore":
      return { httpStatus: 200, row: { status: "ignored", detail: decision.detail } };

    case "reject":
      return {
        httpStatus: 200,
        row: {
          status: "rejected",
          detail: decision.detail,
          orgId: decision.orgId,
          transactionId: decision.transactionId,
          currency: decision.currency,
          amountMinor: decision.amountMinor,
        },
      };

    case "purchase": {
      const money = { orgId: decision.orgId, transactionId: decision.transactionId, currency: decision.currency, amountMinor: decision.amountMinor };
      if (!(await store.orgExists(decision.orgId)))
        return { httpStatus: 200, row: { status: "rejected", detail: "paid, but the organization does not exist — not credited", ...money } };
      try {
        const res = await store.addPurchasedCredits(decision.orgId, decision.credits, decision.transactionId, decision.note);
        log.info(`dodo-webhook: ${eventId} ${res.duplicate ? "already credited" : `credited ${decision.credits}`}`);
        return {
          httpStatus: 200,
          row: {
            status: res.duplicate ? "duplicate" : "processed",
            detail: res.duplicate ? "payment already credited" : `credited ${decision.credits} credits`,
            credits: decision.credits,
            ...money,
          },
        };
      } catch (err) {
        const code = permanent(err);
        if (code) return { httpStatus: 200, row: { status: "rejected", detail: `not credited: ${code}`, ...money } };
        throw err;
      }
    }

    case "subscription_state": {
      const row = decision.orgId ? null : await store.findSubscription(decision.subscriptionId);
      const orgId = decision.orgId ?? row?.orgId ?? null;
      if (!orgId || !(await store.orgExists(orgId))) {
        return {
          httpStatus: 200,
          row: { status: "rejected", detail: `subscription ${decision.subscriptionId} names no known organization`, orgId: null },
        };
      }
      try {
        const res = await store.upsertSubscription({
          orgId,
          subscriptionId: decision.subscriptionId,
          customerId: decision.customerId,
          planId: decision.planId,
          productId: decision.productId,
          status: decision.status,
          periodStart: decision.periodStart,
          periodEnd: decision.periodEnd,
          cancelAtPeriodEnd: decision.cancelAtPeriodEnd,
          canceledAt: decision.canceledAt,
          occurredAt: decision.occurredAt,
        });
        return {
          httpStatus: 200,
          row: res.stale
            ? { status: "ignored", detail: `older than the subscription's last event; ${decision.subscriptionId} unchanged`, orgId }
            : {
                status: "processed",
                detail:
                  `subscription ${decision.subscriptionId}: ${decision.planId ?? "plan unchanged (product not mapped)"}, ${decision.status}` +
                  (decision.cancelAtPeriodEnd ? ", cancels at period end" : ""),
                orgId,
              },
        };
      } catch (err) {
        const code = permanent(err);
        if (code) return { httpStatus: 200, row: { status: "rejected", detail: `subscription not recorded: ${code}`, orgId } };
        throw err;
      }
    }

    case "subscription_payment": {
      const money = { transactionId: decision.transactionId, currency: decision.currency, amountMinor: decision.amountMinor };
      const sub = await store.findSubscription(decision.subscriptionId);
      if (!sub) {
        // Dodo documents payment.succeeded BEFORE subscription.active for a new subscription, and promises no order
        // in general: the plan this payment pays for is not known until that event lands, so ask for a retry.
        return {
          httpStatus: 503,
          row: { status: "failed", detail: "subscription not recorded yet; waiting for Dodo's retry", orgId: decision.orgId, ...money },
        };
      }
      const orgId = decision.orgId ?? sub.orgId;
      if (orgId !== sub.orgId)
        return { httpStatus: 200, row: { status: "rejected", detail: "paid plan for a subscription of another organization — not credited", orgId: null, ...money } };
      if (!(await store.orgExists(orgId)))
        return { httpStatus: 200, row: { status: "rejected", detail: "paid plan, but no known organization — not credited", orgId: null, ...money } };
      // The plan's price on this deployment, from the product the subscription row names (the row's plan is what
      // upsert_subscription_for recorded from Dodo's product_id).
      const planEntry = sub.productId ? plans.get(sub.productId) : undefined;
      if (!planEntry || planEntry.planId !== sub.planId)
        return { httpStatus: 200, row: { status: "rejected", detail: `paid plan, but its product is not plan ${sub.planId} on this deployment — not credited`, orgId, ...money } };
      if (decision.cartProducts.some((p) => p !== sub.productId))
        return { httpStatus: 200, row: { status: "rejected", detail: "paid plan whose cart names another product than the subscription — not credited", orgId, ...money } };
      if (!amountMatches(decision.amountMinor, decision.taxMinor, planEntry.usdCents))
        return {
          httpStatus: 200,
          row: {
            status: "rejected",
            detail: `paid ${decision.amountMinor} (tax ${decision.taxMinor ?? "none"}) USD cents for ${sub.planId}, but its price is ${planEntry.usdCents} — not credited`,
            orgId,
            ...money,
          },
        };
      const note = [
        `Dodo ${decision.transactionId}: ${sub.planId} plan (${decision.chargeType})`,
        decision.userId ? `by user ${decision.userId}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      try {
        const res = await store.grantSubscriptionCredits({
          orgId,
          subscriptionId: decision.subscriptionId,
          planId: sub.planId,
          periodStart: decision.periodStart,
          periodEnd: decision.periodEnd,
          paymentId: decision.transactionId,
          note,
          productId: sub.productId,
        });
        log.info(`dodo-webhook: ${eventId} ${res.duplicate ? "plan period already credited" : `plan credits ${res.granted}`}`);
        return {
          httpStatus: 200,
          row: {
            status: res.duplicate ? "duplicate" : "processed",
            detail: res.duplicate
              ? "plan payment already credited"
              : `${sub.planId} plan: credited ${res.granted} credits for the period ending ${decision.periodEnd}`,
            credits: res.duplicate ? null : res.granted,
            orgId,
            ...money,
          },
        };
      } catch (err) {
        const code = permanent(err);
        if (code) return { httpStatus: 200, row: { status: "rejected", detail: `plan not credited: ${code}`, orgId, ...money } };
        throw err;
      }
    }

    case "refund": {
      const ids = { transactionId: decision.transactionId, adjustmentId: decision.refundKey };
      const purchase = await store.findPurchase(decision.transactionId);
      if (!purchase || purchase.status === "failed") {
        // Dodo does not promise delivery order: the payment may not have arrived (or succeeded) yet. Ask for a retry
        // instead of dropping the refund and leaving the credits with the customer.
        return { httpStatus: 503, row: { status: "failed", detail: "payment not recorded yet; waiting for Dodo's retry", ...ids } };
      }
      if (purchase.status !== "processed" && purchase.status !== "duplicate") {
        return {
          httpStatus: 200,
          row: { status: "ignored", detail: `the payment was never credited (${purchase.status})`, orgId: purchase.orgId, ...ids },
        };
      }
      const size = refundCredits(decision, {
        credits: purchase.credits ?? 0,
        currency: purchase.currency,
        amountMinor: purchase.amountMinor,
      });
      if (size.unsized) {
        return {
          httpStatus: 200,
          row: {
            status: "rejected",
            detail: `partial ${decision.reason} cannot be sized (amount or currency missing) — take credits back by hand`,
            orgId: purchase.orgId,
            currency: decision.currency,
            amountMinor: decision.amountMinor,
            ...ids,
          },
        };
      }
      if (size.amount !== null && size.amount <= 0)
        return { httpStatus: 200, row: { status: "ignored", detail: "refund worth less than 0.01 credits", orgId: purchase.orgId, ...ids } };
      try {
        const res = await store.refundPurchasedCredits(decision.transactionId, decision.refundKey, size.amount, `Dodo ${decision.refundKey}`, decision.reason);
        if (res.shortfall > 0)
          log.warn(`dodo-webhook: ${decision.reason} ${decision.refundKey}: ${res.shortfall} credits were already spent and could not be taken back`);
        return {
          httpStatus: 200,
          row: {
            status: res.duplicate ? "duplicate" : "processed",
            detail: res.duplicate
              ? `${decision.reason} already recorded`
              : `${decision.reason}: took back ${res.taken} of ${res.requested} credits` + (res.shortfall > 0 ? `; shortfall ${res.shortfall}` : ""),
            orgId: purchase.orgId,
            credits: res.taken,
            currency: decision.currency,
            amountMinor: decision.amountMinor,
            ...ids,
          },
        };
      } catch (err) {
        const code = permanent(err);
        if (code)
          return { httpStatus: 200, row: { status: "rejected", detail: `${decision.reason} not applied: ${code}`, orgId: purchase.orgId, ...ids } };
        throw err;
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The database, over Supabase's REST API with the service role
// ───────────────────────────────────────────────────────────────────────────

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A DodoStore over PostgREST, the same way as Paddle's createRestStore: plain
 * fetch, errors carrying the HTTP status and Postgres code only — never a
 * header, so never the key. Every row it reads or writes is provider 'dodo'.
 */
export function createDodoRestStore(opts: { url: string; serviceKey: string; fetch?: FetchLike }): DodoStore {
  const base = opts.url.replace(/\/+$/, "") + "/rest/v1";
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const headers = {
    apikey: opts.serviceKey,
    Authorization: `Bearer ${opts.serviceKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  async function call(what: string, path: string, init: RequestInit): Promise<unknown> {
    const res = await doFetch(base + path, { ...init, headers });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const code = str(obj(json).code);
      throw new StoreError(`${what}: HTTP ${res.status}${code ? ` ${code}` : ""}`, code);
    }
    return json;
  }

  const rpc = (fn: string, args: Record<string, unknown>) => call(fn, `/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  const select = (what: string, table: string, query: string) => call(what, `/${table}?${query}`, { method: "GET" });
  const q = encodeURIComponent;
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : null);

  return {
    async eventStatus(eventId) {
      const rows = await select("payment_events", "payment_events", `provider=eq.dodo&event_id=eq.${q(eventId)}&select=status`);
      const first = Array.isArray(rows) ? obj(rows[0]) : {};
      return (str(first.status) as EventStatus | null) ?? null;
    },
    async recordEvent(r) {
      await rpc("record_payment_event", {
        p_provider: "dodo",
        p_event_id: r.eventId,
        p_event_type: r.eventType,
        p_occurred_at: r.occurredAt,
        p_status: r.status,
        p_detail: r.detail,
        p_org: r.orgId ?? null,
        p_transaction_id: r.transactionId ?? null,
        p_adjustment_id: r.adjustmentId ?? null,
        p_credits: r.credits ?? null,
        p_currency: r.currency ?? null,
        p_amount_minor: r.amountMinor ?? null,
      });
    },
    async orgExists(orgId) {
      const rows = await select("organizations", "organizations", `id=eq.${q(orgId)}&select=id`);
      return Array.isArray(rows) && rows.length > 0;
    },
    async addPurchasedCredits(orgId, credits, externalId, note) {
      const res = obj(await rpc("add_purchased_credits", { p_org: orgId, p_amount: credits, p_external_id: externalId, p_note: note }));
      return { duplicate: res.duplicate === true };
    },
    async findPurchase(paymentId) {
      const rows = await select(
        "payment_events",
        "payment_events",
        `provider=eq.dodo&event_type=eq.payment.succeeded&transaction_id=eq.${q(paymentId)}` +
          `&select=status,org_id,credits,currency,amount_minor&order=received_at.asc`,
      );
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const all = rows.map(obj);
      const credited = all.find((r) => r.status === "processed" || r.status === "duplicate") ?? all[0];
      return {
        status: (str(credited.status) as EventStatus) ?? "failed",
        orgId: str(credited.org_id),
        credits: num(credited.credits),
        currency: str(credited.currency),
        amountMinor: num(credited.amount_minor),
      };
    },
    async refundPurchasedCredits(externalId, refundId, amount, note, reason) {
      const res = obj(
        await rpc("refund_purchased_credits", { p_external_id: externalId, p_refund_id: refundId, p_amount: amount, p_note: note, p_reason: reason }),
      );
      const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
      return { duplicate: res.duplicate === true, requested: n(res.requested), taken: n(res.taken), shortfall: n(res.shortfall) };
    },
    async findSubscription(subscriptionId) {
      const rows = await select(
        "subscriptions",
        "subscriptions",
        `provider=eq.dodo&provider_subscription_id=eq.${q(subscriptionId)}&select=org_id,plan_id,price_id`,
      );
      const first = Array.isArray(rows) && rows.length ? obj(rows[0]) : null;
      const orgId = first ? str(first.org_id) : null;
      const planId = first ? str(first.plan_id) : null;
      return orgId && planId ? { orgId, planId, productId: str(first?.price_id) } : null;
    },
    async upsertSubscription(s) {
      const res = obj(
        await rpc("upsert_subscription_for", {
          p_provider: "dodo",
          p_org: s.orgId,
          p_subscription_id: s.subscriptionId,
          p_customer_id: s.customerId,
          p_plan: s.planId,
          p_price_id: s.productId,
          p_status: s.status,
          p_period_start: s.periodStart,
          p_period_end: s.periodEnd,
          p_cancel_at_period_end: s.cancelAtPeriodEnd,
          p_canceled_at: s.canceledAt,
          p_occurred_at: s.occurredAt,
        }),
      );
      return { stale: res.stale === true };
    },
    async grantSubscriptionCredits(g) {
      const res = obj(
        await rpc("grant_subscription_credits_for", {
          p_provider: "dodo",
          p_org: g.orgId,
          p_subscription_id: g.subscriptionId,
          p_plan: g.planId,
          p_period_start: g.periodStart,
          p_period_end: g.periodEnd,
          p_external_id: g.paymentId,
          p_note: g.note,
          p_customer_id: null,
          p_price_id: g.productId,
          // The amount was checked to be the plan's full price above; a discounted payment never gets here.
          p_paid_share: 1,
        }),
      );
      const granted = typeof res.granted === "number" ? res.granted : Number(res.granted ?? 0);
      return { duplicate: res.duplicate === true, granted: Number.isFinite(granted) ? granted : 0 };
    },
  };
}
