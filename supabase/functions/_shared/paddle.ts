/**
 * Paddle webhook — the pure half: credit packs, signature verification, and
 * what each event means for an organization's credits.
 *
 * Runtime-neutral on purpose. It uses only Web Crypto, fetch and JSON, so the
 * Supabase Edge Function (Deno, supabase/functions/paddle-webhook/index.ts)
 * runs it as-is and the Command Center's vitest suite tests it directly
 * (command-center/tests/paddle-webhook.test.ts). Keep it free of Deno.* and of
 * Node-only imports, and free of relative imports (Deno needs file extensions
 * that the Command Center's TypeScript config refuses).
 *
 * The rules this file exists to keep:
 *
 *   - Nothing the browser sent decides an amount. The checkout passes
 *     custom_data { org_id, user_id }, which only says WHO is being paid for;
 *     the credits come from CREDIT_PACKS via the Paddle price id, and a price
 *     that is not one of our packs credits nothing.
 *   - Credits follow what was PAID, not the list price: a discounted
 *     transaction mints credits in proportion to its totals after discount
 *     (subtotal − discount), and a 100%-discounted one mints none — unless its
 *     discount id is an explicitly allowed promo (PADDLE_PROMO_DISCOUNT_IDS),
 *     which the owner created on purpose to give credits away. Packs and plan
 *     periods alike.
 *   - Every purchase is credited through add_purchased_credits() with the
 *     Paddle transaction id as its external_id, so a webhook delivered twice,
 *     or retried after a timeout, credits once.
 *   - A paid purchase that cannot be credited (unknown organization, unknown
 *     price) is answered 200 and recorded as `rejected`: retrying cannot fix
 *     it, a person must (refund it in Paddle, or grant by hand). A failure
 *     that retrying CAN fix (the database was unreachable) is answered 5xx so
 *     Paddle delivers the event again.
 *   - No secret, and nothing of the payer beyond ids, is ever logged or stored.
 *   - An API balance top-up (migration 0031) is a transaction the Command
 *     Center created with one custom-priced line under the "API balance
 *     top-up" product and custom_data.purpose = "api_topup". It credits the
 *     organization's API balance (US cents, api_add_topup) with what Paddle
 *     charged for that line — never site credits — and only when every line
 *     is that product, in USD, within $5–$5,000.
 */

// ───────────────────────────────────────────────────────────────────────────
// Credit packs
// ───────────────────────────────────────────────────────────────────────────

/**
 * The packs on sale. `credits` is what a purchase of one pack adds. The price
 * is set in Paddle (one price per pack) and mapped here by env var — see
 * docs/PADDLE_SETUP.md. The Command Center's copy (command-center/lib/paddle.ts)
 * must list the same packs with the same credits; a test compares the two.
 */
export const CREDIT_PACKS = [
  { id: "starter", credits: 1000 },
  { id: "creator", credits: 5000 },
  { id: "studio", credits: 20000 },
] as const;

export type CreditPackId = (typeof CREDIT_PACKS)[number]["id"];

export interface CreditPack {
  id: CreditPackId;
  credits: number;
}

/** Paddle ids are a prefix and 26 lowercase alphanumerics; accept a little slack. */
export const PADDLE_PRICE_ID_RE = /^pri_[a-z0-9]{10,40}$/;
const TRANSACTION_ID_RE = /^txn_[a-z0-9]{10,40}$/;
const ADJUSTMENT_ID_RE = /^adj_[a-z0-9]{10,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The webhook's env var for a pack's Paddle price id, e.g. PADDLE_PRICE_STARTER. */
export function priceEnvName(pack: CreditPackId): string {
  return `PADDLE_PRICE_${pack.toUpperCase()}`;
}

/** price id -> pack, from the webhook's environment. A missing or malformed
 *  value leaves that pack unsellable rather than guessing. */
export type PriceTable = ReadonlyMap<string, CreditPack>;

export function priceTableFromEnv(get: (name: string) => string | undefined): PriceTable {
  const table = new Map<string, CreditPack>();
  for (const pack of CREDIT_PACKS) {
    const id = (get(priceEnvName(pack.id)) ?? "").trim();
    if (PADDLE_PRICE_ID_RE.test(id) && !table.has(id)) table.set(id, { id: pack.id, credits: pack.credits });
  }
  return table;
}

// ───────────────────────────────────────────────────────────────────────────
// Subscription plans (migration 0034)
// ───────────────────────────────────────────────────────────────────────────

/** PADDLE_PLAN_CREATOR=pri_… -> plan "creator". The plan ids themselves live
 *  in the database (plans); an env var naming a plan the database does not
 *  know is refused there (upsert_subscription / grant_subscription_credits). */
export const PLAN_ENV_RE = /^PADDLE_PLAN_([A-Z][A-Z0-9_]{1,30})$/;
const SUBSCRIPTION_ID_RE = /^sub_[a-z0-9]{10,40}$/;
const CUSTOMER_ID_RE = /^ctm_[a-z0-9]{10,40}$/;

/** price id -> plan id. */
export type PlanTable = ReadonlyMap<string, string>;

/**
 * The plan prices from the webhook's environment (all of it: the plan ids are
 * not known here). A malformed price id is skipped; a price id that is also a
 * credit pack is skipped too — one price cannot be both a one-time pack and a
 * subscription, and guessing which was meant would be wrong half the time.
 */
export function planTableFromEnv(
  entries: Iterable<readonly [string, string | undefined]>,
  packs: PriceTable = new Map(),
): PlanTable {
  const table = new Map<string, string>();
  for (const [name, raw] of entries) {
    const m = PLAN_ENV_RE.exec(name);
    if (!m) continue;
    const id = (raw ?? "").trim();
    if (!PADDLE_PRICE_ID_RE.test(id) || packs.has(id) || table.has(id)) continue;
    table.set(id, m[1].toLowerCase());
  }
  return table;
}

// ───────────────────────────────────────────────────────────────────────────
// Discounts
// ───────────────────────────────────────────────────────────────────────────

export const DISCOUNT_ID_RE = /^dsc_[a-z0-9]{10,40}$/;

/** Discount ids the owner explicitly allows to give credits at full value
 *  (PADDLE_PROMO_DISCOUNT_IDS="dsc_…,dsc_…"). Anything malformed is dropped. */
export type PromoAllowlist = ReadonlySet<string>;

export function promoAllowlistFromEnv(raw: string | undefined): PromoAllowlist {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((v) => v.trim())
      .filter((v) => DISCOUNT_ID_RE.test(v)),
  );
}

export type PaidShare = { share: number; discountId: string | null; promo: boolean } | { error: string };

/**
 * The share of the list price this transaction actually charged, from
 * Paddle's own totals: 1 without a discount, (subtotal − discount) / subtotal
 * with one, 1 for an allowed promo. A discount whose totals cannot be read is
 * an error — the credits are not guessed.
 */
export function paidShare(data: Record<string, unknown>, promos: PromoAllowlist = new Set()): PaidShare {
  const discountRaw = str(data.discount_id);
  const discountId = discountRaw && DISCOUNT_ID_RE.test(discountRaw) ? discountRaw : null;
  const totals = obj(obj(data.details).totals);
  const hasDiscountField = totals.discount !== undefined && totals.discount !== null;
  const discount = hasDiscountField ? minorUnits(totals.discount) : 0;
  const subtotal = minorUnits(totals.subtotal);
  if (discountId && promos.has(discountId)) return { share: 1, discountId, promo: true };
  if (discountRaw && !discountId) return { error: "discount id is malformed" };
  if (discount === null) return { error: "discount total cannot be read" };
  if (!discountId && discount === 0) return { share: 1, discountId: null, promo: false };
  if (subtotal === null) return { error: "discounted, but the subtotal cannot be read" };
  if (subtotal <= 0 || discount >= subtotal) return { share: 0, discountId, promo: false };
  return { share: (subtotal - discount) / subtotal, discountId, promo: false };
}

/** Credits for what was paid, rounded DOWN to the cent. */
export function creditsForShare(listCredits: number, share: number): number {
  return Math.floor(Math.round(listCredits * share * 1e6) / 1e4) / 100;
}

function shareNote(p: { share: number; discountId: string | null; promo: boolean }): string | null {
  if (p.promo) return `promo ${p.discountId} (full credits)`;
  if (p.share >= 1) return null;
  return `discount ${p.discountId ?? "(no id)"}: ${(p.share * 100).toFixed(2)}% paid`;
}

export const SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "paused", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_EVENTS = [
  "subscription.created",
  "subscription.updated",
  "subscription.activated",
  "subscription.canceled",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.trialing",
] as const;

/** An ISO timestamp Paddle sent, or null. Never a date we made up. */
function isoTime(v: unknown): string | null {
  const s = str(v);
  if (!s || s.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(Date.parse(s))) return null;
  return s;
}

/** The single plan the items name, or why not. */
function planOfItems(items: unknown, plans: PlanTable): { planId: string; priceId: string } | { error: string } {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return { error: "no items" };
  let found: { planId: string; priceId: string } | null = null;
  for (const raw of list) {
    const item = obj(raw);
    const priceId = str(obj(item.price).id) ?? str(item.price_id);
    const planId = priceId ? plans.get(priceId) : undefined;
    if (!planId || !priceId) return { error: `price ${priceId ?? "(none)"} is not a plan on this deployment` };
    if (found && found.planId !== planId) return { error: "several plans in one subscription" };
    found = { planId, priceId };
  }
  return found ?? { error: "no items" };
}

/** transaction.completed that pays for a plan -> that billing period's credits. */
export function decideSubscriptionPayment(
  data: Record<string, unknown>,
  plans: PlanTable,
  promos: PromoAllowlist = new Set(),
): Decision {
  const transactionId = str(data.id);
  const custom = obj(data.custom_data);
  const orgRaw = str(custom.org_id);
  const orgId = orgRaw && UUID_RE.test(orgRaw) ? orgRaw.toLowerCase() : null;
  const userRaw = str(custom.user_id);
  const userId = userRaw && UUID_RE.test(userRaw) ? userRaw.toLowerCase() : null;
  const currency = currencyCode(data.currency_code);
  const amountMinor = minorUnits(obj(obj(data.details).totals).grand_total);
  const reject = (detail: string): Decision => ({
    kind: "reject",
    detail,
    orgId,
    transactionId: transactionId && TRANSACTION_ID_RE.test(transactionId) ? transactionId : null,
    currency,
    amountMinor,
  });
  if (!transactionId || !TRANSACTION_ID_RE.test(transactionId)) return reject("transaction without a valid id");
  if (str(data.status) !== "completed") return { kind: "ignore", detail: `transaction status ${String(data.status)}` };
  const subscriptionId = str(data.subscription_id);
  if (!subscriptionId || !SUBSCRIPTION_ID_RE.test(subscriptionId))
    return reject("paid plan without a subscription id — not credited");
  const plan = planOfItems(data.items, plans);
  if ("error" in plan) return reject(`paid subscription, but ${plan.error} — not credited`);
  for (const raw of Array.isArray(data.items) ? data.items : []) {
    const qty = obj(raw).quantity;
    if (qty !== undefined && qty !== 1) return reject("paid plan with a quantity other than 1 — not credited");
  }
  const period = obj(data.billing_period);
  const periodStart = isoTime(period.starts_at);
  const periodEnd = isoTime(period.ends_at);
  if (!periodStart || !periodEnd || Date.parse(periodEnd) <= Date.parse(periodStart))
    return reject("paid plan without a billing period — not credited");
  const paid = paidShare(data, promos);
  if ("error" in paid) return reject(`paid plan, but ${paid.error} — not credited`);
  if (paid.share <= 0)
    return reject(
      `plan fully discounted (${paid.discountId ?? "no discount id"}) — no credits; ` +
        "add the discount to PADDLE_PROMO_DISCOUNT_IDS if it is meant to give credits",
    );
  const customerRaw = str(data.customer_id);
  const origin = str(data.origin);
  const note = [
    `Paddle ${transactionId}: ${plan.planId} plan${origin ? ` (${origin})` : ""}`,
    shareNote(paid),
    userId ? `by user ${userId}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    kind: "subscription_payment",
    orgId,
    subscriptionId,
    customerId: customerRaw && CUSTOMER_ID_RE.test(customerRaw) ? customerRaw : null,
    planId: plan.planId,
    priceId: plan.priceId,
    transactionId,
    periodStart,
    periodEnd,
    paidShare: paid.share,
    currency,
    amountMinor,
    note,
  };
}

/** subscription.* -> the subscription's state as Paddle now reports it. */
export function decideSubscription(event: PaddleEvent, plans: PlanTable): Decision {
  const data = event.data;
  const subscriptionId = str(data.id);
  const custom = obj(data.custom_data);
  const orgRaw = str(custom.org_id);
  const orgId = orgRaw && UUID_RE.test(orgRaw) ? orgRaw.toLowerCase() : null;
  const reject = (detail: string): Decision => ({
    kind: "reject",
    detail,
    orgId,
    transactionId: null,
    currency: null,
    amountMinor: null,
  });
  if (!subscriptionId || !SUBSCRIPTION_ID_RE.test(subscriptionId)) return reject("subscription without a valid id");
  const status = str(data.status);
  if (!status || !(SUBSCRIPTION_STATUSES as readonly string[]).includes(status))
    return { kind: "ignore", detail: `subscription status ${String(data.status)} is not handled` };
  // A price this deployment no longer maps (rotated, removed) must not stop a
  // cancellation from landing: the state is still recorded with the plan left
  // as it was. A NEW subscription without a known plan is refused by the
  // database (upsert_subscription needs a plan to create a row).
  const plan = planOfItems(data.items, plans);
  const period = obj(data.current_billing_period);
  const customerRaw = str(data.customer_id);
  return {
    kind: "subscription_state",
    orgId,
    subscriptionId,
    customerId: customerRaw && CUSTOMER_ID_RE.test(customerRaw) ? customerRaw : null,
    planId: "error" in plan ? null : plan.planId,
    priceId: "error" in plan ? null : plan.priceId,
    status: status as SubscriptionStatus,
    periodStart: isoTime(period.starts_at),
    periodEnd: isoTime(period.ends_at),
    cancelAtPeriodEnd: str(obj(data.scheduled_change).action) === "cancel",
    canceledAt: isoTime(data.canceled_at),
    occurredAt: event.occurredAt,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Signature
// ───────────────────────────────────────────────────────────────────────────

/** Paddle refuses to count a delivery older than this, and so do we: a
 *  captured request replayed later must not be accepted. */
export const SIGNATURE_TOLERANCE_S = 300;

export type SignatureCheck = "ok" | "missing" | "malformed" | "stale" | "mismatch";

/**
 * `Paddle-Signature: ts=1671552777;h1=eb4d…` — h1 may repeat while a secret is
 * being rotated; any one of them matching is enough.
 */
export function parseSignatureHeader(header: string | null | undefined): { ts: number; h1: string[] } | null {
  if (!header) return null;
  let ts: number | null = null;
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "ts" && /^\d{1,12}$/.test(value)) ts = Number(value);
    else if (key === "h1" && /^[0-9a-f]{64}$/i.test(value)) h1.push(value.toLowerCase());
  }
  return ts === null || h1.length === 0 ? null : { ts, h1 };
}

function hexToBytes(hex: string): ArrayBuffer {
  const buf = new ArrayBuffer(hex.length / 2);
  const view = new Uint8Array(buf);
  for (let i = 0; i < view.length; i++) view[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return buf;
}

/**
 * HMAC-SHA256 over `ts:rawBody` with the destination's secret key. The raw
 * body exactly as received — re-serialised JSON would not match. The compare
 * is SubtleCrypto's verify(), which is constant-time, so a forger learns
 * nothing from how long a wrong guess took.
 */
export async function verifyPaddleSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  nowSeconds: number,
  toleranceS: number = SIGNATURE_TOLERANCE_S,
): Promise<SignatureCheck> {
  if (!header) return "missing";
  const parsed = parseSignatureHeader(header);
  if (!parsed) return "malformed";
  if (Math.abs(nowSeconds - parsed.ts) > toleranceS) return "stale";
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const data = enc.encode(`${parsed.ts}:${rawBody}`);
  for (const h of parsed.h1) {
    if (await crypto.subtle.verify("HMAC", key, hexToBytes(h), data)) return "ok";
  }
  return "mismatch";
}

// ───────────────────────────────────────────────────────────────────────────
// What an event means
// ───────────────────────────────────────────────────────────────────────────

export type EventStatus = "processed" | "duplicate" | "ignored" | "rejected" | "failed";

export interface PaddleEvent {
  eventId: string;
  eventType: string;
  occurredAt: string | null;
  data: Record<string, unknown>;
}

export type Decision =
  | { kind: "ignore"; detail: string }
  | {
      kind: "reject";
      detail: string;
      orgId: string | null;
      transactionId: string | null;
      currency: string | null;
      amountMinor: number | null;
    }
  | {
      kind: "purchase";
      orgId: string;
      userId: string | null;
      transactionId: string;
      credits: number;
      currency: string | null;
      amountMinor: number | null;
      note: string;
    }
  | {
      kind: "api_topup";
      orgId: string;
      userId: string | null;
      transactionId: string;
      cents: number;
      currency: string | null;
      amountMinor: number | null;
      note: string;
    }
  | {
      kind: "subscription_payment";
      orgId: string | null;
      subscriptionId: string;
      customerId: string | null;
      planId: string;
      priceId: string;
      transactionId: string;
      periodStart: string;
      periodEnd: string;
      /** Share of the list price paid (0 < share <= 1); the database scales the allowance by it. */
      paidShare: number;
      currency: string | null;
      amountMinor: number | null;
      note: string;
    }
  | {
      kind: "subscription_state";
      orgId: string | null;
      subscriptionId: string;
      customerId: string | null;
      /** Null when the price is not (or no longer) a plan here: status still recorded. */
      planId: string | null;
      priceId: string | null;
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
      adjustmentId: string;
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

/** Paddle sends money as a string of the lowest denomination ("1999" = 19.99). */
function minorUnits(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{1,15}$/.test(v)) return null;
  return Number(v);
}

function currencyCode(v: unknown): string | null {
  const s = str(v);
  return s && /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : null;
}

/** The envelope: { event_id, event_type, occurred_at, data }. Null when it is not one. */
export function parseEvent(rawBody: string): PaddleEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const o = obj(json);
  const eventId = str(o.event_id);
  const eventType = str(o.event_type);
  if (!eventId || !eventType || eventId.length > 200 || eventType.length > 100) return null;
  return { eventId, eventType, occurredAt: str(o.occurred_at), data: obj(o.data) };
}

/**
 * transaction.completed -> how many credits, for which organization. Every
 * line must be one of our packs: a transaction mixing a pack with anything
 * else is rejected whole rather than half-credited, because a person has to
 * look at it either way.
 */
/** Bounds of one API top-up, in US cents (0031's api_add_topup checks them too). */
export const API_TOPUP_MIN_CENTS = 500;
export const API_TOPUP_MAX_CENTS = 500_000;
export const PADDLE_PRODUCT_ID_RE = /^pro_[a-z0-9]{10,40}$/;

/**
 * transaction.completed for an API top-up -> how many cents, for which
 * organization. The amount is Paddle's own record of the line's unit price x
 * quantity (tax is Paddle's, on top), never anything the browser said.
 */
export function decideApiTopup(
  data: Record<string, unknown>,
  apiProductId: string | null | undefined,
  promos: PromoAllowlist = new Set(),
): Decision {
  const transactionId = str(data.id);
  const custom = obj(data.custom_data);
  const orgRaw = str(custom.org_id);
  const orgId = orgRaw && UUID_RE.test(orgRaw) ? orgRaw.toLowerCase() : null;
  const userRaw = str(custom.user_id);
  const userId = userRaw && UUID_RE.test(userRaw) ? userRaw.toLowerCase() : null;
  const currency = currencyCode(data.currency_code);
  const amountMinor = minorUnits(obj(obj(data.details).totals).grand_total);
  const reject = (detail: string): Decision => ({
    kind: "reject",
    detail,
    orgId,
    transactionId: transactionId && TRANSACTION_ID_RE.test(transactionId) ? transactionId : null,
    currency,
    amountMinor,
  });
  if (!transactionId || !TRANSACTION_ID_RE.test(transactionId)) return reject("transaction without a valid id");
  if (str(data.status) !== "completed") return { kind: "ignore", detail: `transaction status ${String(data.status)}` };
  if (!orgId) return reject("paid API top-up without an organization id — not credited");
  if (!apiProductId || !PADDLE_PRODUCT_ID_RE.test(apiProductId))
    return reject("paid API top-up, but PADDLE_API_TOPUP_PRODUCT_ID is not set — not credited");
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return reject("paid API top-up without items — not credited");
  let cents = 0;
  for (const raw of items) {
    const item = obj(raw);
    const price = obj(item.price);
    const unit = obj(price.unit_price);
    const qty = item.quantity;
    if (str(price.product_id) !== apiProductId) return reject("paid API top-up with a line that is not the top-up product — not credited");
    if (currencyCode(unit.currency_code) !== "USD") return reject("paid API top-up not priced in USD — not credited");
    const amount = minorUnits(unit.amount);
    if (amount === null || typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 1000)
      return reject("paid API top-up with an unreadable amount or quantity — not credited");
    cents += amount * qty;
  }
  // A discount scales the balance to what was paid, like credits.
  const paid = paidShare(data, promos);
  if ("error" in paid) return reject(`paid API top-up, but ${paid.error} — not credited`);
  cents = Math.floor(Math.round(cents * paid.share * 1e6) / 1e6);
  if (cents <= 0) return reject("API top-up fully discounted — not credited");
  if (cents < API_TOPUP_MIN_CENTS || cents > API_TOPUP_MAX_CENTS)
    return reject(`paid API top-up of ${cents} cents is outside $5-$5,000 — not credited`);
  const note = [`Paddle ${transactionId}: API top-up ${(cents / 100).toFixed(2)} USD`, userId ? `by user ${userId}` : null]
    .filter(Boolean)
    .join(" · ");
  return { kind: "api_topup", orgId, userId, transactionId, cents, currency, amountMinor, note };
}

export function decideTransaction(
  data: Record<string, unknown>,
  prices: PriceTable,
  apiProductId?: string | null,
  plans: PlanTable = new Map(),
  promos: PromoAllowlist = new Set(),
): Decision {
  if (str(obj(data.custom_data).purpose) === "api_topup") return decideApiTopup(data, apiProductId, promos);
  // A subscription's transaction (first payment, renewal, upgrade) or any line
  // that is a plan price: the period's credits, never pack credits.
  const anyPlan = (Array.isArray(data.items) ? data.items : []).some((raw) => {
    const item = obj(raw);
    const priceId = str(obj(item.price).id) ?? str(item.price_id);
    return priceId ? plans.has(priceId) : false;
  });
  if (anyPlan || str(data.subscription_id)) return decideSubscriptionPayment(data, plans, promos);
  const transactionId = str(data.id);
  const custom = obj(data.custom_data);
  const orgRaw = str(custom.org_id);
  const orgId = orgRaw && UUID_RE.test(orgRaw) ? orgRaw.toLowerCase() : null;
  const userRaw = str(custom.user_id);
  const userId = userRaw && UUID_RE.test(userRaw) ? userRaw.toLowerCase() : null;
  const currency = currencyCode(data.currency_code);
  const amountMinor = minorUnits(obj(obj(data.details).totals).grand_total);
  const reject = (detail: string): Decision => ({
    kind: "reject",
    detail,
    orgId,
    transactionId: transactionId && TRANSACTION_ID_RE.test(transactionId) ? transactionId : null,
    currency,
    amountMinor,
  });

  if (!transactionId || !TRANSACTION_ID_RE.test(transactionId)) return reject("transaction without a valid id");
  if (str(data.status) !== "completed") return { kind: "ignore", detail: `transaction status ${String(data.status)}` };
  if (!orgId) return reject("paid, but custom_data carries no organization id — not credited");

  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) return reject("paid, but the transaction has no items — not credited");
  let credits = 0;
  const lines: string[] = [];
  for (const raw of items) {
    const item = obj(raw);
    const priceId = str(obj(item.price).id) ?? str(item.price_id);
    const qty = item.quantity;
    const pack = priceId ? prices.get(priceId) : undefined;
    if (!pack) {
      return reject(`paid, but price ${priceId ?? "(none)"} is not a credit pack on this deployment — not credited`);
    }
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 1000) {
      return reject(`paid, but a line has an invalid quantity — not credited`);
    }
    credits += pack.credits * qty;
    lines.push(`${qty}× ${pack.id}`);
  }

  // What was actually paid decides the credits (a discount scales them).
  const paid = paidShare(data, promos);
  if ("error" in paid) return reject(`paid, but ${paid.error} — not credited`);
  const listCredits = credits;
  credits = creditsForShare(listCredits, paid.share);
  if (credits <= 0)
    return reject(
      `fully discounted (${paid.discountId ?? "no discount id"}) — no credits; ` +
        "add the discount to PADDLE_PROMO_DISCOUNT_IDS if it is meant to give credits",
    );

  const note = [
    `Paddle ${transactionId}: ${lines.join(", ")}`,
    paid.share < 1 || paid.promo ? `${shareNote(paid)} → ${credits} of ${listCredits} credits` : null,
    userId ? `bought by user ${userId}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { kind: "purchase", orgId, userId, transactionId, credits, currency, amountMinor, note };
}

/**
 * adjustment.created / adjustment.updated -> take credits back. Only an
 * APPROVED refund or chargeback moves credits: a refund request starts as
 * pending_approval and may be rejected, and a chargeback warning is not yet a
 * chargeback. A chargeback that is later reversed (money back to us) is not
 * re-credited automatically — it is rare, and a person should decide.
 */
export function decideAdjustment(data: Record<string, unknown>): Decision {
  const action = str(data.action);
  const status = str(data.status);
  if (action !== "refund" && action !== "chargeback") {
    return { kind: "ignore", detail: `adjustment action ${action ?? "(none)"} does not take credits back` };
  }
  if (status !== "approved") return { kind: "ignore", detail: `${action} is ${status ?? "(no status)"}, not approved` };
  const adjustmentId = str(data.id);
  const transactionId = str(data.transaction_id);
  if (!adjustmentId || !ADJUSTMENT_ID_RE.test(adjustmentId) || !transactionId || !TRANSACTION_ID_RE.test(transactionId)) {
    return {
      kind: "reject",
      detail: `${action} without a valid adjustment or transaction id`,
      orgId: null,
      transactionId: null,
      currency: null,
      amountMinor: null,
    };
  }
  const totals = obj(data.totals);
  return {
    kind: "refund",
    reason: action,
    transactionId,
    adjustmentId,
    full: str(data.type) === "full",
    currency: currencyCode(data.currency_code) ?? currencyCode(totals.currency_code),
    amountMinor: minorUnits(totals.total),
  };
}

export function decideEvent(
  event: PaddleEvent,
  prices: PriceTable,
  apiProductId?: string | null,
  plans: PlanTable = new Map(),
  promos: PromoAllowlist = new Set(),
): Decision {
  if ((SUBSCRIPTION_EVENTS as readonly string[]).includes(event.eventType)) return decideSubscription(event, plans);
  switch (event.eventType) {
    case "transaction.completed":
      return decideTransaction(event.data, prices, apiProductId, plans, promos);
    case "adjustment.created":
    case "adjustment.updated":
      return decideAdjustment(event.data);
    default:
      return { kind: "ignore", detail: `event type ${event.eventType} is not handled` };
  }
}

/**
 * How many credits a refund takes back. Full refund (or one at least as large
 * as what was paid) -> null, meaning "everything not already refunded", which
 * refund_purchased_credits() works out itself. A partial refund takes back
 * credits in proportion to the money returned, to the cent. Null plus
 * `unsized` when the proportion cannot be known honestly (no totals, another
 * currency) — then a person decides rather than the code guessing.
 */
export function refundCredits(
  refund: { full: boolean; currency: string | null; amountMinor: number | null },
  purchase: { credits: number; currency: string | null; amountMinor: number | null },
): { amount: number | null; unsized: boolean } {
  if (refund.full) return { amount: null, unsized: false };
  if (
    refund.amountMinor === null ||
    purchase.amountMinor === null ||
    purchase.amountMinor <= 0 ||
    !refund.currency ||
    refund.currency !== purchase.currency
  ) {
    return { amount: null, unsized: true };
  }
  if (refund.amountMinor >= purchase.amountMinor) return { amount: null, unsized: false };
  const amount = Math.round(((purchase.credits * refund.amountMinor) / purchase.amountMinor) * 100) / 100;
  return { amount, unsized: false };
}

// ───────────────────────────────────────────────────────────────────────────
// The handler
// ───────────────────────────────────────────────────────────────────────────

export class StoreError extends Error {
  /** The Postgres SQLSTATE / PostgREST code, when there was one. */
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export interface EventRecord {
  eventId: string;
  eventType: string;
  occurredAt: string | null;
  status: EventStatus;
  detail: string | null;
  orgId?: string | null;
  transactionId?: string | null;
  adjustmentId?: string | null;
  credits?: number | null;
  currency?: string | null;
  amountMinor?: number | null;
}

export interface PurchaseRecord {
  status: EventStatus;
  orgId: string | null;
  credits: number | null;
  currency: string | null;
  amountMinor: number | null;
}

/** What the handler needs from the database — the service-role side. */
export interface PaddleStore {
  eventStatus(eventId: string): Promise<EventStatus | null>;
  recordEvent(record: EventRecord): Promise<void>;
  orgExists(orgId: string): Promise<boolean>;
  addPurchasedCredits(orgId: string, credits: number, externalId: string, note: string): Promise<{ duplicate: boolean }>;
  findPurchase(transactionId: string): Promise<PurchaseRecord | null>;
  refundPurchasedCredits(
    externalId: string,
    refundId: string,
    amount: number | null,
    note: string,
    reason: "refund" | "chargeback",
  ): Promise<{ duplicate: boolean; requested: number; taken: number; shortfall: number }>;
  /** Plans (0034). Optional so a store without them refuses plan events as a
   *  temporary failure (Paddle retries) instead of dropping them. */
  findSubscriptionOrg?(subscriptionId: string): Promise<string | null>;
  upsertSubscription?(s: {
    orgId: string;
    subscriptionId: string;
    customerId: string | null;
    planId: string | null;
    priceId: string | null;
    status: SubscriptionStatus;
    periodStart: string | null;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    canceledAt: string | null;
    occurredAt: string | null;
  }): Promise<{ stale: boolean }>;
  grantSubscriptionCredits?(g: {
    orgId: string;
    subscriptionId: string;
    planId: string;
    periodStart: string;
    periodEnd: string;
    transactionId: string;
    note: string;
    customerId: string | null;
    priceId: string | null;
    paidShare: number;
  }): Promise<{ duplicate: boolean; granted: number }>;
  /** API balance (0031). Optional so a store without them refuses API top-ups
   *  as a temporary failure instead of mis-crediting them. */
  addApiTopup?(orgId: string, cents: number, externalId: string, note: string): Promise<{ duplicate: boolean }>;
  findApiTopup?(transactionId: string): Promise<{ orgId: string; cents: number } | null>;
  refundApiTopup?(
    externalId: string,
    refundId: string,
    cents: number | null,
    note: string,
    reason: "refund" | "chargeback",
  ): Promise<{ duplicate: boolean; requested: number; taken: number; shortfall: number }>;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Paddle's payloads are a few KB; anything this large is not one. */
export const MAX_BODY_BYTES = 1_000_000;

/** SQLSTATEs that retrying cannot fix: the purchase is recorded as rejected. */
const PERMANENT_CODES = new Set(["23505", "22023", "P0002"]);

export async function handlePaddleWebhook(
  req: { method: string; rawBody: string; signature: string | null },
  deps: {
    secret: string;
    prices: PriceTable;
    store: PaddleStore;
    now?: () => number;
    log?: Logger;
    /** The "API balance top-up" product (PADDLE_API_TOPUP_PRODUCT_ID). */
    apiProductId?: string | null;
    /** Plan prices (PADDLE_PLAN_<ID>), migration 0034. */
    plans?: PlanTable;
    /** Discounts allowed to give credits at full value (PADDLE_PROMO_DISCOUNT_IDS). */
    promos?: PromoAllowlist;
  },
): Promise<WebhookResponse> {
  const log: Logger = deps.log ?? console;
  if (req.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
  if (!deps.secret) {
    log.error("paddle-webhook: PADDLE_WEBHOOK_SECRET is not set — every delivery is refused");
    return { status: 500, body: { error: "webhook not configured" } };
  }
  if (req.rawBody.length > MAX_BODY_BYTES) return { status: 413, body: { error: "payload too large" } };

  const nowS = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
  const check = await verifyPaddleSignature(req.rawBody, req.signature, deps.secret, nowS);
  if (check !== "ok") {
    // The reason only — never the header, the body or the secret.
    log.warn(`paddle-webhook: signature ${check}; delivery refused`);
    return { status: 401, body: { error: "invalid signature" } };
  }

  const event = parseEvent(req.rawBody);
  if (!event) return { status: 400, body: { error: "not a Paddle event" } };

  const base = { eventId: event.eventId, eventType: event.eventType, occurredAt: event.occurredAt };
  try {
    const prior = await deps.store.eventStatus(event.eventId);
    if (prior && prior !== "failed") {
      return { status: 200, body: { ok: true, duplicate: true, status: prior } };
    }

    const decision = decideEvent(event, deps.prices, deps.apiProductId, deps.plans ?? new Map(), deps.promos ?? new Set());
    const record = await execute(decision, deps.store, log, event.eventId);
    await deps.store.recordEvent({ ...base, ...record.row });
    if (record.row.status === "rejected" || record.httpStatus >= 500) {
      log.warn(`paddle-webhook: ${event.eventId} ${record.row.status} — ${record.row.detail}`);
    }
    return { status: record.httpStatus, body: { ok: record.httpStatus < 300, status: record.row.status } };
  } catch (err) {
    const code = err instanceof StoreError ? err.code : null;
    log.error(`paddle-webhook: ${event.eventId} failed (${code ?? (err instanceof Error ? err.name : "error")}); Paddle will retry`);
    try {
      await deps.store.recordEvent({
        ...base,
        status: "failed",
        detail: `temporary failure${code ? ` (${code})` : ""}; waiting for Paddle's retry`,
      });
    } catch {
      // The audit row is best effort here; the 500 below is what matters.
    }
    return { status: 500, body: { error: "temporary failure" } };
  }
}

type RecordFields = Omit<EventRecord, "eventId" | "eventType" | "occurredAt">;

async function execute(
  decision: Decision,
  store: PaddleStore,
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
      const money = {
        orgId: decision.orgId,
        transactionId: decision.transactionId,
        currency: decision.currency,
        amountMinor: decision.amountMinor,
      };
      if (!(await store.orgExists(decision.orgId))) {
        return {
          httpStatus: 200,
          row: { status: "rejected", detail: "paid, but the organization does not exist — not credited", ...money },
        };
      }
      try {
        const res = await store.addPurchasedCredits(
          decision.orgId,
          decision.credits,
          decision.transactionId,
          decision.note,
        );
        log.info(`paddle-webhook: ${eventId} ${res.duplicate ? "already credited" : `credited ${decision.credits}`}`);
        return {
          httpStatus: 200,
          row: {
            status: res.duplicate ? "duplicate" : "processed",
            detail: res.duplicate ? "transaction already credited" : `credited ${decision.credits} credits`,
            credits: decision.credits,
            ...money,
          },
        };
      } catch (err) {
        if (err instanceof StoreError && err.code && PERMANENT_CODES.has(err.code)) {
          return {
            httpStatus: 200,
            row: { status: "rejected", detail: `not credited: ${err.code}`, ...money },
          };
        }
        throw err;
      }
    }

    case "api_topup": {
      const money = {
        orgId: decision.orgId,
        transactionId: decision.transactionId,
        currency: decision.currency,
        amountMinor: decision.amountMinor,
      };
      if (!store.addApiTopup) throw new StoreError("this webhook build cannot credit API top-ups", null);
      if (!(await store.orgExists(decision.orgId))) {
        return {
          httpStatus: 200,
          row: { status: "rejected", detail: "paid API top-up, but the organization does not exist — not credited", ...money },
        };
      }
      try {
        const res = await store.addApiTopup(decision.orgId, decision.cents, decision.transactionId, decision.note);
        log.info(`paddle-webhook: ${eventId} ${res.duplicate ? "API top-up already credited" : `API top-up ${decision.cents} cents`}`);
        return {
          httpStatus: 200,
          row: {
            status: res.duplicate ? "duplicate" : "processed",
            detail: res.duplicate ? "API top-up already credited" : `API top-up: credited ${decision.cents} cents`,
            ...money,
          },
        };
      } catch (err) {
        if (err instanceof StoreError && err.code && PERMANENT_CODES.has(err.code)) {
          return { httpStatus: 200, row: { status: "rejected", detail: `API top-up not credited: ${err.code}`, ...money } };
        }
        throw err;
      }
    }

    case "subscription_state": {
      if (!store.upsertSubscription || !store.findSubscriptionOrg)
        throw new StoreError("this webhook build cannot record subscriptions", null);
      const orgId = decision.orgId ?? (await store.findSubscriptionOrg(decision.subscriptionId));
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
          priceId: decision.priceId,
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
                detail: `subscription ${decision.subscriptionId}: ${decision.planId ?? "plan unchanged (price not mapped)"}, ${decision.status}` +
                  (decision.cancelAtPeriodEnd ? ", cancels at period end" : ""),
                orgId,
              },
        };
      } catch (err) {
        if (err instanceof StoreError && err.code && PERMANENT_CODES.has(err.code)) {
          return { httpStatus: 200, row: { status: "rejected", detail: `subscription not recorded: ${err.code}`, orgId } };
        }
        throw err;
      }
    }

    case "subscription_payment": {
      if (!store.grantSubscriptionCredits || !store.findSubscriptionOrg)
        throw new StoreError("this webhook build cannot credit subscriptions", null);
      const orgId = decision.orgId ?? (await store.findSubscriptionOrg(decision.subscriptionId));
      const money = {
        orgId,
        transactionId: decision.transactionId,
        currency: decision.currency,
        amountMinor: decision.amountMinor,
      };
      if (!orgId || !(await store.orgExists(orgId))) {
        return {
          httpStatus: 200,
          row: { status: "rejected", detail: "paid plan, but no known organization — not credited", ...money, orgId: null },
        };
      }
      try {
        const res = await store.grantSubscriptionCredits({
          orgId,
          subscriptionId: decision.subscriptionId,
          planId: decision.planId,
          periodStart: decision.periodStart,
          periodEnd: decision.periodEnd,
          transactionId: decision.transactionId,
          note: decision.note,
          customerId: decision.customerId,
          priceId: decision.priceId,
          paidShare: decision.paidShare,
        });
        log.info(`paddle-webhook: ${eventId} ${res.duplicate ? "plan period already credited" : `plan credits ${res.granted}`}`);
        return {
          httpStatus: 200,
          row: {
            status: res.duplicate ? "duplicate" : "processed",
            detail: res.duplicate
              ? "plan transaction already credited"
              : `${decision.planId} plan: credited ${res.granted} credits for the period ending ${decision.periodEnd}`,
            credits: res.duplicate ? null : res.granted,
            ...money,
          },
        };
      } catch (err) {
        if (err instanceof StoreError && err.code && PERMANENT_CODES.has(err.code)) {
          return { httpStatus: 200, row: { status: "rejected", detail: `plan not credited: ${err.code}`, ...money } };
        }
        throw err;
      }
    }

    case "refund": {
      const ids = { transactionId: decision.transactionId, adjustmentId: decision.adjustmentId };
      const purchase = await store.findPurchase(decision.transactionId);
      if (!purchase || purchase.status === "failed") {
        // Paddle does not promise delivery order. The purchase may simply not
        // have arrived (or not succeeded) yet, so ask for a retry instead of
        // dropping the refund and leaving the credits with the customer.
        return {
          httpStatus: 503,
          row: { status: "failed", detail: "purchase not recorded yet; waiting for Paddle's retry", ...ids },
        };
      }
      if (purchase.status !== "processed" && purchase.status !== "duplicate") {
        return {
          httpStatus: 200,
          row: { status: "ignored", detail: `the purchase was never credited (${purchase.status})`, orgId: purchase.orgId, ...ids },
        };
      }
      // An API top-up is refunded from the API balance, in cents, by the same
      // proportional rule (refundCredits) as a credit pack.
      const topup = store.findApiTopup ? await store.findApiTopup(decision.transactionId) : null;
      if (topup && store.refundApiTopup) {
        const size = refundCredits(decision, {
          credits: topup.cents,
          currency: purchase.currency,
          amountMinor: purchase.amountMinor,
        });
        if (size.unsized) {
          return {
            httpStatus: 200,
            row: {
              status: "rejected",
              detail: `partial ${decision.reason} of an API top-up cannot be sized — take the balance back by hand`,
              orgId: topup.orgId,
              ...ids,
            },
          };
        }
        const cents = size.amount === null ? null : Math.round(size.amount);
        if (cents !== null && cents <= 0) {
          return { httpStatus: 200, row: { status: "ignored", detail: "refund worth less than one cent", orgId: topup.orgId, ...ids } };
        }
        const res = await store.refundApiTopup(decision.transactionId, decision.adjustmentId, cents, `Paddle ${decision.adjustmentId}`, decision.reason);
        if (res.shortfall > 0)
          log.warn(`paddle-webhook: ${decision.reason} ${decision.adjustmentId}: ${res.shortfall} API cents were already spent`);
        return {
          httpStatus: 200,
          row: {
            status: res.duplicate ? "duplicate" : "processed",
            detail: res.duplicate
              ? `${decision.reason} of API top-up already recorded`
              : `${decision.reason} of API top-up: took back ${res.taken} of ${res.requested} cents` +
                (res.shortfall > 0 ? `; shortfall ${res.shortfall}` : ""),
            orgId: topup.orgId,
            currency: decision.currency,
            amountMinor: decision.amountMinor,
            ...ids,
          },
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
            detail: `partial ${decision.reason} cannot be sized (totals or currency missing) — take credits back by hand`,
            orgId: purchase.orgId,
            currency: decision.currency,
            amountMinor: decision.amountMinor,
            ...ids,
          },
        };
      }
      if (size.amount !== null && size.amount <= 0) {
        return { httpStatus: 200, row: { status: "ignored", detail: "refund worth less than 0.01 credits", orgId: purchase.orgId, ...ids } };
      }
      try {
        const res = await store.refundPurchasedCredits(
          decision.transactionId,
          decision.adjustmentId,
          size.amount,
          `Paddle ${decision.adjustmentId}`,
          decision.reason,
        );
        if (res.shortfall > 0) {
          log.warn(
            `paddle-webhook: ${decision.reason} ${decision.adjustmentId}: ${res.shortfall} credits were already spent and could not be taken back`,
          );
        }
        return {
          httpStatus: 200,
          row: {
            status: res.duplicate ? "duplicate" : "processed",
            detail: res.duplicate
              ? `${decision.reason} already recorded`
              : `${decision.reason}: took back ${res.taken} of ${res.requested} credits` +
                (res.shortfall > 0 ? `; shortfall ${res.shortfall}` : ""),
            orgId: purchase.orgId,
            credits: res.taken,
            currency: decision.currency,
            amountMinor: decision.amountMinor,
            ...ids,
          },
        };
      } catch (err) {
        if (err instanceof StoreError && err.code && PERMANENT_CODES.has(err.code)) {
          return {
            httpStatus: 200,
            row: { status: "rejected", detail: `${decision.reason} not applied: ${err.code}`, orgId: purchase.orgId, ...ids },
          };
        }
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
 * A PaddleStore over PostgREST. Plain fetch, no client library: the Edge
 * Function then has no dependency to download or pin, and a test can hand it
 * a fake fetch. Errors carry the HTTP status and Postgres code only — never a
 * header, so never the key.
 */
export function createRestStore(opts: { url: string; serviceKey: string; fetch?: FetchLike }): PaddleStore {
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

  const rpc = (fn: string, args: Record<string, unknown>) =>
    call(fn, `/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  const select = (what: string, table: string, query: string) =>
    call(what, `/${table}?${query}`, { method: "GET" });
  const q = encodeURIComponent;

  return {
    async eventStatus(eventId) {
      const rows = await select("payment_events", "payment_events", `provider=eq.paddle&event_id=eq.${q(eventId)}&select=status`);
      const first = Array.isArray(rows) ? obj(rows[0]) : {};
      return (str(first.status) as EventStatus | null) ?? null;
    },
    async recordEvent(r) {
      await rpc("record_payment_event", {
        p_provider: "paddle",
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
      const res = obj(
        await rpc("add_purchased_credits", { p_org: orgId, p_amount: credits, p_external_id: externalId, p_note: note }),
      );
      return { duplicate: res.duplicate === true };
    },
    async findPurchase(transactionId) {
      const rows = await select(
        "payment_events",
        "payment_events",
        `provider=eq.paddle&event_type=eq.transaction.completed&transaction_id=eq.${q(transactionId)}` +
          `&select=status,org_id,credits,currency,amount_minor&order=received_at.asc`,
      );
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const all = rows.map(obj);
      const credited = all.find((r) => r.status === "processed" || r.status === "duplicate") ?? all[0];
      const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : null);
      return {
        status: (str(credited.status) as EventStatus) ?? "failed",
        orgId: str(credited.org_id),
        credits: num(credited.credits),
        currency: str(credited.currency),
        amountMinor: num(credited.amount_minor),
      };
    },
    async findSubscriptionOrg(subscriptionId) {
      const rows = await select(
        "subscriptions",
        "subscriptions",
        `provider=eq.paddle&provider_subscription_id=eq.${q(subscriptionId)}&select=org_id`,
      );
      const first = Array.isArray(rows) && rows.length ? obj(rows[0]) : null;
      return first ? str(first.org_id) : null;
    },
    async upsertSubscription(s) {
      const res = obj(
        await rpc("upsert_subscription", {
          p_org: s.orgId,
          p_subscription_id: s.subscriptionId,
          p_customer_id: s.customerId,
          p_plan: s.planId,
          p_price_id: s.priceId,
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
        await rpc("grant_subscription_credits", {
          p_org: g.orgId,
          p_subscription_id: g.subscriptionId,
          p_plan: g.planId,
          p_period_start: g.periodStart,
          p_period_end: g.periodEnd,
          p_external_id: g.transactionId,
          p_note: g.note,
          p_customer_id: g.customerId,
          p_price_id: g.priceId,
          p_paid_share: g.paidShare,
        }),
      );
      const granted = typeof res.granted === "number" ? res.granted : Number(res.granted ?? 0);
      return { duplicate: res.duplicate === true, granted: Number.isFinite(granted) ? granted : 0 };
    },
    async addApiTopup(orgId, cents, externalId, note) {
      const res = obj(await rpc("api_add_topup", { p_org: orgId, p_cents: cents, p_external_id: externalId, p_note: note }));
      return { duplicate: res.duplicate === true };
    },
    async findApiTopup(transactionId) {
      const rows = await select(
        "api_ledger",
        "api_ledger",
        `kind=eq.topup&external_id=eq.${q(transactionId)}&select=org_id,amount_cents`,
      );
      const first = Array.isArray(rows) && rows.length ? obj(rows[0]) : null;
      const orgId = first ? str(first.org_id) : null;
      const cents = first ? Number(first.amount_cents) : NaN;
      return orgId && Number.isFinite(cents) ? { orgId, cents } : null;
    },
    async refundApiTopup(externalId, refundId, cents, note, reason) {
      const res = obj(
        await rpc("api_refund_topup", {
          p_external_id: externalId,
          p_refund_id: refundId,
          p_cents: cents,
          p_note: note,
          p_reason: reason,
        }),
      );
      const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
      return {
        duplicate: res.duplicate === true,
        requested: n(res.requested_cents),
        taken: n(res.taken_cents),
        shortfall: n(res.shortfall_cents),
      };
    },
    async refundPurchasedCredits(externalId, refundId, amount, note, reason) {
      const res = obj(
        await rpc("refund_purchased_credits", {
          p_external_id: externalId,
          p_refund_id: refundId,
          p_amount: amount,
          p_note: note,
          p_reason: reason,
        }),
      );
      const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
      return {
        duplicate: res.duplicate === true,
        requested: n(res.requested),
        taken: n(res.taken),
        shortfall: n(res.shortfall),
      };
    },
  };
}
