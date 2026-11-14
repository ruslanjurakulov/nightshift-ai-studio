import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DODO_AMOUNT,
  DODO_PACKS,
  DODO_PLAN_PRICES,
  dodoAmountFromItem,
  dodoAmountProductFromEnv,
  MAX_BODY_BYTES,
  StoreError,
  amountMatches,
  createDodoRestStore,
  dodoMetadataKey,
  dodoMetadataMessage,
  dodoTaxModeFromEnv,
  dodoTestOrgsFromEnv,
  dodoWebhookModeFromEnv,
  verifyDodoMetadata,
  dodoPackTableFromEnv,
  dodoPlanTableFromEnv,
  dodoSigningKey,
  handleDodoWebhook,
  parseDodoSignatures,
  verifyDodoSignature,
  type DodoStore,
  type DodoTaxMode,
  type DodoWebhookMode,
  type DodoSubscriptionRow,
  type EventRecord,
  type EventStatus,
  type PurchaseRecord,
} from "../../supabase/functions/_shared/dodo";
import { CREDIT_PACKS as PADDLE_WEBHOOK_PACKS } from "../../supabase/functions/_shared/paddle";
import { DODO_AMOUNT as APP_AMOUNT, DODO_CATALOG_PACKS as APP_PACKS, DODO_CATALOG_PLAN_PRICES as APP_PLAN_PRICES, dodoItemKey } from "@/lib/dodo";

// The Dodo webhook's logic (supabase/functions/_shared/dodo.ts) is runtime-neutral, so it is tested here with the
// Command Center's tooling, the same way as Paddle's. The payloads below are built from the field lists and the
// "Example" blocks of Dodo's webhook payload pages (docs.dodopayments.com/developer-resources/webhooks/intents/
// payment, refund, dispute, subscription; read 2026-11-12): only fields the docs list are used, and every value
// that is "<string>" in the docs is replaced with an id of the documented shape (pay_…, sub_…, cus_…, pdt_…).

const KEY = Buffer.from("nightshift-dodo-lab-signing-key-32bytes!");
const SECRET = "whsec_" + KEY.toString("base64");
const OTHER_SECRET = "whsec_" + Buffer.from("another-endpoint-signing-key-0000000").toString("base64");
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER = "11111111-1111-4111-8111-111111111111";
const PDT_STARTER = "pdt_0NVbdIG3JNg9Yc8ey5JHW";
const PDT_STUDIO = "pdt_STUDIOpack00000000000";
const PDT_PRO = "pdt_PROplan00000000000000";
/** The Pay What You Want product typed amounts are charged under (DODO_PRODUCT_AMOUNT). */
const PDT_AMOUNT = "pdt_PWYWamount0000000000";
const PAY = "pay_gr4RizvMOXFJ6xca3y2tU";
const PAY2 = "pay_secondPAYMENT000000000";
const SUB = "sub_Iuaq622bbmmfOGrVTqdXv";
const CUS = "cus_TV52uJWWXt2yIoBBxpjaa";
const META_SECRET = "lab-metadata-secret-0123456789abcdef-xyz";
const NOW_MS = 1_760_000_000_000;
const NOW_S = NOW_MS / 1000;

const packs = dodoPackTableFromEnv((n) => ({ DODO_PRODUCT_STARTER: PDT_STARTER, DODO_PRODUCT_STUDIO: PDT_STUDIO })[n]);
const plans = dodoPlanTableFromEnv([["DODO_PLAN_PRO", PDT_PRO]], packs);

function sign(id: string, ts: number, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

/** Metadata as the Command Center's checkout signs it (lib/server/dodo-api.ts signedCheckoutMetadata). */
function signedMeta(
  org: string,
  user: string | null,
  item: string,
  secret = META_SECRET,
  // One checkout per (org, user, item) by default; a test that needs another checkout passes its own nonce.
  nonce = createHash("md5").update(`${org}|${user ?? ""}|${item}`).digest("hex"),
) {
  const sig = createHmac("sha256", secret).update(dodoMetadataMessage({ orgId: org, userId: user, item, nonce })).digest("hex");
  return { org_id: org, ...(user ? { user_id: user } : {}), nightshift_item: item, ns_nonce: nonce, ns_sig: sig };
}

function envelope(type: string, data: Record<string, unknown>, timestamp = "2026-11-12T10:00:00Z") {
  return JSON.stringify({ business_id: "bus_H4ekzPSlcg", type, timestamp, data });
}

/** payment.succeeded for one Starter pack, tax-exclusive: $10.00 + $0.80 tax. */
function payment(overrides: Record<string, unknown> = {}) {
  return envelope("payment.succeeded", {
    payload_type: "Payment",
    business_id: "bus_H4ekzPSlcg",
    brand_id: "bus_H4ekzPSlcg",
    payment_id: PAY,
    status: "succeeded",
    currency: "USD",
    total_amount: 1080,
    tax: 80,
    settlement_amount: 1000,
    settlement_currency: "USD",
    created_at: "2026-11-12T09:59:00Z",
    customer: { customer_id: CUS, email: "buyer@example.com", name: "Buyer", metadata: {} },
    metadata: signedMeta(ORG, USER, "pack:starter"),
    product_cart: [{ product_id: PDT_STARTER, quantity: 1 }],
    subscription_id: null,
    subscription_ids: [],
    service_periods: [],
    discounts: null,
    discount_id: null,
    disputes: [],
    refunds: [],
    is_multi_subscription: false,
    is_update_payment_method: false,
    charge_type: null,
    ...overrides,
  });
}

/** payment.succeeded for the first month of Pro ($49.00 + $3.92 tax). */
function planPayment(overrides: Record<string, unknown> = {}) {
  return payment({
    payment_id: PAY2,
    total_amount: 5292,
    tax: 392,
    metadata: signedMeta(ORG, USER, "plan:pro"),
    product_cart: null,
    subscription_id: SUB,
    subscription_ids: [SUB],
    charge_type: "new",
    service_periods: [{ subscription_id: SUB, starts_at: "2026-11-12T10:00:00Z", ends_at: "2026-12-12T10:00:00Z", proration_factor: "1" }],
    ...overrides,
  });
}

function subscription(type: string, overrides: Record<string, unknown> = {}, timestamp?: string) {
  return envelope(
    type,
    {
      payload_type: "Subscription",
      subscription_id: SUB,
      status: "active",
      product_id: PDT_PRO,
      quantity: 1,
      currency: "USD",
      recurring_pre_tax_amount: 4900,
      tax_inclusive: true,
      customer: { customer_id: CUS, email: "buyer@example.com", name: "Buyer", metadata: {} },
      metadata: signedMeta(ORG, USER, "plan:pro"),
      previous_billing_date: "2026-11-12T10:00:00Z",
      next_billing_date: "2026-12-12T10:00:00Z",
      cancel_at_next_billing_date: false,
      cancelled_at: null,
      payment_frequency_interval: "Month",
      payment_frequency_count: 1,
      subscription_period_interval: "Year",
      subscription_period_count: 10,
      trial_period_days: 0,
      payment_id: null,
      ...overrides,
    },
    timestamp,
  );
}

function refund(overrides: Record<string, unknown> = {}) {
  return envelope("refund.succeeded", {
    payload_type: "Refund",
    refund_id: "ref_0001",
    payment_id: PAY,
    status: "succeeded",
    is_partial: false,
    amount: 1080,
    currency: "USD",
    metadata: {},
    customer: { customer_id: CUS, email: "buyer@example.com", name: "Buyer", metadata: {} },
    ...overrides,
  });
}

function dispute(type: string, overrides: Record<string, unknown> = {}) {
  return envelope(type, {
    payload_type: "Dispute",
    dispute_id: "dis_0001",
    payment_id: PAY,
    amount: "1080",
    currency: "USD",
    dispute_stage: "dispute",
    dispute_status: type === "dispute.lost" ? "dispute_lost" : type === "dispute.accepted" ? "dispute_accepted" : "dispute_opened",
    payment_provider: "dodo",
    ...overrides,
  });
}

/** An in-memory stand-in for the database with 0020/0021/0034's idempotency (external id, refund id, period). */
class FakeStore implements DodoStore {
  events = new Map<string, EventRecord>();
  orgs = new Set([ORG, OTHER_ORG]);
  credited = new Map<string, { org: string; credits: number }>();
  refunds = new Map<string, { ext: string; amount: number | null; reason: string }>();
  subs = new Map<string, DodoSubscriptionRow & { status: string; cancelAtPeriodEnd: boolean; customerId: string | null }>();
  grants: { paymentId: string; planId: string; periodEnd: string }[] = [];
  failNext: StoreError | Error | null = null;
  /** What the next refund answers past `requested` (0167: part of a shortfall can be on hold). Null = everything taken. */
  refundResult: { taken: number; shortfall: number; onHold?: number | null } | null = null;
  /** dodo_checkout_nonces as 0146 keeps it: who the nonce was issued for, and what spent it. */
  nonces = new Map<string, { key: string; consumer: string | null; expired?: boolean }>();
  /** Nonces this deployment never issued (a blob signed with the right key but not by our checkout). */
  unknownNonces = new Set<string>();

  private maybeFail() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }
  async eventStatus(id: string) {
    return this.events.get(id)?.status ?? null;
  }
  async recordEvent(r: EventRecord) {
    const cur = this.events.get(r.eventId);
    if (cur && cur.status !== "failed") return;
    this.events.set(r.eventId, r);
  }
  async orgExists(id: string) {
    return this.orgs.has(id);
  }
  async addPurchasedCredits(org: string, credits: number, ext: string) {
    this.maybeFail();
    const prior = this.credited.get(ext);
    if (prior) {
      if (prior.org !== org || prior.credits !== credits) throw new StoreError("conflict", "23505");
      return { duplicate: true };
    }
    this.credited.set(ext, { org, credits });
    return { duplicate: false };
  }
  async findPurchase(pay: string): Promise<PurchaseRecord | null> {
    const rows = [...this.events.values()].filter((e) => e.transactionId === pay && e.eventType === "payment.succeeded");
    const r = rows.find((e) => e.status === "processed" || e.status === "duplicate") ?? rows[0];
    return r
      ? { status: r.status as EventStatus, orgId: r.orgId ?? null, credits: r.credits ?? null, currency: r.currency ?? null, amountMinor: r.amountMinor ?? null }
      : null;
  }
  async refundPurchasedCredits(ext: string, id: string, amount: number | null, _note: string, reason: "refund" | "chargeback") {
    this.maybeFail();
    if (this.refunds.has(id)) return { duplicate: true, requested: 0, taken: 0, shortfall: 0 };
    const bought = this.credited.get(ext)?.credits ?? 0;
    const already = [...this.refunds.values()].filter((r) => r.ext === ext).reduce((s, r) => s + (r.amount ?? bought), 0);
    const requested = Math.min(amount ?? bought - already, bought - already);
    this.refunds.set(id, { ext, amount: requested, reason });
    if (this.refundResult) return { duplicate: false, requested, ...this.refundResult };
    return { duplicate: false, requested, taken: requested, shortfall: 0 };
  }
  async consumeNonce(n: { nonce: string; orgId: string; userId: string | null; item: string; consumer: string }) {
    if (this.unknownNonces.has(n.nonce)) return "unknown" as const;
    const key = `${n.orgId}|${n.userId ?? ""}|${n.item}`;
    const cur = this.nonces.get(n.nonce) ?? { key, consumer: null };
    this.nonces.set(n.nonce, cur);
    if (cur.key !== key) return "mismatch" as const;
    if (cur.consumer) return cur.consumer === n.consumer ? ("ok" as const) : ("consumed" as const);
    if (cur.expired) return "expired" as const;
    cur.consumer = n.consumer;
    return "ok" as const;
  }
  async findSubscription(id: string) {
    const s = this.subs.get(id);
    return s ? { orgId: s.orgId, planId: s.planId, productId: s.productId } : null;
  }
  async upsertSubscription(s: Parameters<DodoStore["upsertSubscription"]>[0]) {
    this.maybeFail();
    const cur = this.subs.get(s.subscriptionId);
    if (cur && cur.orgId !== s.orgId) throw new StoreError("other org", "23505");
    if (!cur && !s.planId) throw new StoreError("a new subscription needs a known plan", "22023");
    this.subs.set(s.subscriptionId, {
      orgId: s.orgId,
      planId: s.planId ?? cur!.planId,
      productId: s.productId ?? cur?.productId ?? null,
      status: s.status,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      customerId: s.customerId,
    });
    return { stale: false };
  }
  async grantSubscriptionCredits(g: Parameters<DodoStore["grantSubscriptionCredits"]>[0]) {
    this.maybeFail();
    if (this.credited.has(g.paymentId)) return { duplicate: true, granted: 0 };
    const granted = g.planId === "pro" ? 6000 : 2000;
    this.credited.set(g.paymentId, { org: g.orgId, credits: granted });
    this.grants.push({ paymentId: g.paymentId, planId: g.planId, periodEnd: g.periodEnd });
    return { duplicate: false, granted };
  }
}

const quiet = { info() {}, warn() {}, error() {} };

function deliver(
  store: FakeStore,
  body: string,
  opts: {
    id?: string;
    ts?: number;
    signature?: string | null;
    secret?: string;
    method?: string;
    now?: number;
    headerId?: string | null;
    metadataSecret?: string;
    taxMode?: DodoTaxMode | null;
    mode?: DodoWebhookMode;
    testOrgs?: string[];
    amountProduct?: string | null;
    log?: { info(m: string): void; warn(m: string): void; error(m: string): void };
  } = {},
) {
  const id = opts.id ?? "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W";
  const ts = opts.ts ?? NOW_S;
  const signature = opts.signature === undefined ? sign(id, ts, body) : opts.signature;
  return handleDodoWebhook(
    {
      method: opts.method ?? "POST",
      rawBody: body,
      headers: { id: opts.headerId === undefined ? id : opts.headerId, timestamp: String(ts), signature },
    },
    {
      secret: opts.secret ?? SECRET,
      metadataSecret: opts.metadataSecret ?? META_SECRET,
      taxMode: opts.taxMode === undefined ? "exclusive" : opts.taxMode,
      mode: opts.mode ?? "live",
      testOrgs: new Set(opts.testOrgs ?? []),
      packs,
      plans,
      amountProduct: opts.amountProduct === undefined ? PDT_AMOUNT : opts.amountProduct,
      store,
      now: () => opts.now ?? NOW_MS,
      log: opts.log ?? quiet,
    },
  );
}

const total = (s: FakeStore) => [...s.credited.values()].reduce((n, c) => n + c.credits, 0);

describe("the catalog", () => {
  it("sells the same three packs, with the same credits, as Paddle and as the Command Center", () => {
    expect(DODO_PACKS.map((p) => [p.id, p.credits])).toEqual(PADDLE_WEBHOOK_PACKS.map((p) => [p.id, p.credits]));
    expect(APP_PACKS).toEqual(DODO_PACKS);
    expect(APP_PLAN_PRICES).toEqual(DODO_PLAN_PRICES);
  });

  it("is the owner's catalog: $10 / $45 / $160 packs and $19 / $49 / $129 plans", () => {
    expect(DODO_PACKS.map((p) => p.usdCents)).toEqual([1000, 4500, 16000]);
    expect(DODO_PLAN_PRICES).toEqual({ creator: 1900, pro: 4900, studio: 12900 });
  });

  it("reads product ids from the environment and leaves a missing or malformed one unsellable", () => {
    const t = dodoPackTableFromEnv((n) => ({ DODO_PRODUCT_STARTER: PDT_STARTER, DODO_PRODUCT_CREATOR: "pri_paddle0000000000" })[n]);
    expect([...t.keys()]).toEqual([PDT_STARTER]);
  });

  it("refuses a plan without a price here, and a product that is already a pack", () => {
    const t = dodoPlanTableFromEnv([
      ["DODO_PLAN_PRO", PDT_PRO],
      ["DODO_PLAN_ENTERPRISE", "pdt_ENTERPRISE0000000000"],
      ["DODO_PLAN_CREATOR", PDT_STARTER],
    ], packs);
    expect([...t.entries()]).toEqual([[PDT_PRO, { planId: "pro", usdCents: 4900 }]]);
  });

  it("checks exactly the ONE tax shape the deployment pins (DODO_TAX_MODE)", () => {
    expect(amountMatches(1000, 167, 1000, "inclusive")).toBe(true);
    expect(amountMatches(1000, null, 1000, "inclusive")).toBe(true);
    expect(amountMatches(1080, 80, 1000, "inclusive")).toBe(false); // the exclusive shape is not accepted inclusive
    expect(amountMatches(1000, 1001, 1000, "inclusive")).toBe(false); // tax larger than the total
    expect(amountMatches(1080, 80, 1000, "exclusive")).toBe(true);
    expect(amountMatches(1000, null, 1000, "exclusive")).toBe(true); // no tax collected
    expect(amountMatches(1000, 167, 1000, "exclusive")).toBe(false); // the inclusive shape is not accepted exclusive
    expect(amountMatches(1080, null, 1000, "exclusive")).toBe(false);
    expect(amountMatches(999, 0, 1000, "exclusive")).toBe(false);
    expect(amountMatches(1080, 79, 1000, "exclusive")).toBe(false);
    expect(amountMatches(0, 0, 0, "exclusive")).toBe(false);
    expect([dodoTaxModeFromEnv("inclusive"), dodoTaxModeFromEnv("exclusive"), dodoTaxModeFromEnv(""), dodoTaxModeFromEnv("Inclusive"), dodoTaxModeFromEnv(undefined)]).toEqual([
      "inclusive",
      "exclusive",
      null,
      null,
      null,
    ]);
  });
});

describe("signature (Standard Webhooks)", () => {
  it("credits a correctly signed delivery", async () => {
    const store = new FakeStore();
    const res = await deliver(store, payment());
    expect(res.status).toBe(200);
    expect(store.credited.get(PAY)).toEqual({ org: ORG, credits: 1000 });
  });

  it("accepts the secret with or without its whsec_ prefix, and refuses one that is not a key", async () => {
    expect(dodoSigningKey(SECRET)).not.toBeNull();
    expect(dodoSigningKey(KEY.toString("base64"))).toEqual(dodoSigningKey(SECRET));
    expect(dodoSigningKey("whsec_not base64!")).toBeNull();
    expect(dodoSigningKey("whsec_c2hvcnQ=")).toBeNull(); // 5 bytes
    const store = new FakeStore();
    expect((await deliver(store, payment(), { secret: "" })).status).toBe(500);
    expect((await deliver(store, payment(), { secret: "whsec_c2hvcnQ=" })).status).toBe(500);
    expect(store.credited.size).toBe(0);
  });

  it("refuses a delivery signed with another secret", async () => {
    const store = new FakeStore();
    const body = payment();
    const res = await deliver(store, body, { signature: sign("msg_2KWPBgLlAfxdpx2AI54pPJ85f4W", NOW_S, body, OTHER_SECRET) });
    expect(res.status).toBe(401);
    expect(store.credited.size).toBe(0);
    expect(store.events.size).toBe(0);
  });

  it("refuses a tampered body (an amount changed after signing)", async () => {
    const store = new FakeStore();
    const signed = payment();
    const res = await deliver(store, signed.replace(`"quantity":1`, `"quantity":9`), { signature: sign("msg_2KWPBgLlAfxdpx2AI54pPJ85f4W", NOW_S, signed) });
    expect(res.status).toBe(401);
    expect(store.credited.size).toBe(0);
  });

  it("binds the webhook id: a signature for one id does not pass under another (no replay under a fresh id)", async () => {
    const store = new FakeStore();
    const body = payment();
    const res = await deliver(store, body, { id: "msg_other", signature: sign("msg_2KWPBgLlAfxdpx2AI54pPJ85f4W", NOW_S, body) });
    expect(res.status).toBe(401);
  });

  it.each([
    ["stale", NOW_S - 301],
    ["from the future", NOW_S + 301],
  ])("refuses a %s timestamp, even correctly signed", async (_what, ts) => {
    const store = new FakeStore();
    const body = payment();
    expect((await deliver(store, body, { ts, signature: sign("msg_2KWPBgLlAfxdpx2AI54pPJ85f4W", ts, body) })).status).toBe(401);
    expect(store.credited.size).toBe(0);
  });

  it("accepts a timestamp exactly at the tolerance", async () => {
    const store = new FakeStore();
    const body = payment();
    const ts = NOW_S - 300;
    expect((await deliver(store, body, { ts, signature: sign("msg_2KWPBgLlAfxdpx2AI54pPJ85f4W", ts, body) })).status).toBe(200);
  });

  it.each(["webhook-id", "webhook-timestamp", "webhook-signature"])("refuses a delivery without %s", async (h) => {
    const store = new FakeStore();
    const body = payment();
    const key = dodoSigningKey(SECRET)!;
    const full = { id: "msg_x", timestamp: String(NOW_S), signature: sign("msg_x", NOW_S, body) };
    const headers = {
      id: h === "webhook-id" ? null : full.id,
      timestamp: h === "webhook-timestamp" ? null : full.timestamp,
      signature: h === "webhook-signature" ? null : full.signature,
    };
    expect(await verifyDodoSignature(body, headers, key, NOW_S)).toBe("missing");
    const res = await handleDodoWebhook(
      { method: "POST", rawBody: body, headers },
      { secret: SECRET, metadataSecret: META_SECRET, taxMode: "exclusive", mode: "live", testOrgs: new Set(), packs, plans, store, now: () => NOW_MS, log: quiet },
    );
    expect(res.status).toBe(401);
    expect(store.credited.size).toBe(0);
  });

  it("accepts any one valid v1 signature among several (secret rotation), and ignores other versions", async () => {
    const body = payment();
    const good = sign("msg_x", NOW_S, body);
    const bad = sign("msg_x", NOW_S, body, OTHER_SECRET);
    const key = dodoSigningKey(SECRET)!;
    const h = (signature: string) => ({ id: "msg_x", timestamp: String(NOW_S), signature });
    expect(await verifyDodoSignature(body, h(`${bad} ${good}`), key, NOW_S)).toBe("ok");
    expect(await verifyDodoSignature(body, h(`v2,${good.slice(3)} ${good}`), key, NOW_S)).toBe("ok");
    expect(await verifyDodoSignature(body, h(`${bad} ${bad}`), key, NOW_S)).toBe("mismatch");
    expect(await verifyDodoSignature(body, h(`v2,${good.slice(3)}`), key, NOW_S)).toBe("malformed");
    expect(await verifyDodoSignature(body, h("v1,not-base64!"), key, NOW_S)).toBe("malformed");
    expect(parseDodoSignatures(`${good}   ${bad}`)).toHaveLength(2);
  });

  it("refuses a non-POST and an oversized body before verifying anything", async () => {
    const store = new FakeStore();
    expect((await deliver(store, payment(), { method: "GET" })).status).toBe(405);
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    expect((await deliver(store, big)).status).toBe(413);
  });

  it("answers 400 for a signed body that is not a Dodo event", async () => {
    const store = new FakeStore();
    expect((await deliver(store, JSON.stringify({ hello: "world" }))).status).toBe(400);
  });
});

describe("idempotency", () => {
  it("credits a delivery replayed under the same webhook id once", async () => {
    const store = new FakeStore();
    const body = payment();
    await deliver(store, body);
    const again = await deliver(store, body);
    expect(again.body).toMatchObject({ duplicate: true, status: "processed" });
    expect(total(store)).toBe(1000);
  });

  it("credits one payment delivered under two webhook ids once (the payment id is the ledger key)", async () => {
    const store = new FakeStore();
    await deliver(store, payment(), { id: "msg_first" });
    const second = await deliver(store, payment(), { id: "msg_second" });
    expect(second.body).toMatchObject({ status: "duplicate" });
    expect(total(store)).toBe(1000);
  });

  it("answers 500 on a temporary failure and credits on Dodo's retry", async () => {
    const store = new FakeStore();
    store.failNext = new StoreError("db down", null);
    const first = await deliver(store, payment());
    expect(first.status).toBe(500);
    expect(store.events.get("msg_2KWPBgLlAfxdpx2AI54pPJ85f4W")?.status).toBe("failed");
    const retry = await deliver(store, payment());
    expect(retry.status).toBe(200);
    expect(total(store)).toBe(1000);
  });
});

describe("payment.succeeded -> a credit pack", () => {
  it.each([
    ["tax-exclusive ($10 + tax) on an exclusive deployment", { total_amount: 1080, tax: 80 }, 1000, "exclusive"],
    ["tax-inclusive ($10 with tax inside) on an inclusive deployment", { total_amount: 1000, tax: 167 }, 1000, "inclusive"],
    [
      "a Studio pack, no tax",
      { product_cart: [{ product_id: PDT_STUDIO, quantity: 1 }], total_amount: 16000, tax: 0, metadata: signedMeta(ORG, USER, "pack:studio") },
      20000,
      "exclusive",
    ],
  ] as const)("credits %s", async (_what, over, credits, taxMode) => {
    const store = new FakeStore();
    const res = await deliver(store, payment(over), { taxMode });
    expect(res.body).toMatchObject({ status: "processed" });
    expect(store.credited.get(PAY)?.credits).toBe(credits);
    expect(store.events.get("msg_2KWPBgLlAfxdpx2AI54pPJ85f4W")).toMatchObject({ orgId: ORG, transactionId: PAY, currency: "USD", credits });
  });

  it.each([
    ["a product that is not one of ours", { product_cart: [{ product_id: "pdt_SOMEONEelse000000000", quantity: 1 }] }],
    ["an amount below the catalog price", { total_amount: 999, tax: 0 }],
    ["an amount above the catalog price that is not tax", { total_amount: 1100, tax: 80 }],
    ["another currency", { currency: "EUR" }],
    ["a discount", { discounts: [{ discount_id: "dsc_1", amount: 500 }] }],
    ["a deprecated discount id", { discount_id: "dsc_1" }],
    ["no organization in the metadata", { metadata: {} }],
    ["a quantity of zero", { product_cart: [{ product_id: PDT_STARTER, quantity: 0 }] }],
    ["a pack beside a stranger's product", { product_cart: [{ product_id: PDT_STARTER, quantity: 1 }, { product_id: "pdt_x000", quantity: 1 }] }],
    ["no product at all", { product_cart: null }],
    ["a zero total", { total_amount: 0, tax: 0 }],
    ["the inclusive shape on an exclusive deployment", { total_amount: 1000, tax: 167 }],
    ["two packs on one line", { product_cart: [{ product_id: PDT_STARTER, quantity: 2 }], total_amount: 2000, tax: 0 }],
    ["an unreadable tax", { tax: "80" }],
    ["a malformed payment id", { payment_id: "txn_01paddle00000000000000" }],
  ])("refuses %s (recorded rejected, nothing credited)", async (_what, over) => {
    const store = new FakeStore();
    const res = await deliver(store, payment(over));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "rejected" });
    expect(store.credited.size).toBe(0);
  });

  it("refuses an organization that does not exist", async () => {
    const store = new FakeStore();
    store.orgs.clear();
    expect((await deliver(store, payment())).body).toMatchObject({ status: "rejected" });
    expect(store.credited.size).toBe(0);
  });

  it.each([
    ["still processing", { status: "processing" }],
    ["a payment-method update", { is_update_payment_method: true }],
  ])("ignores a payment %s", async (_what, over) => {
    const store = new FakeStore();
    expect((await deliver(store, payment(over))).body).toMatchObject({ status: "ignored" });
    expect(store.credited.size).toBe(0);
  });

  it("ignores events outside the allow-list without touching credits", async () => {
    const store = new FakeStore();
    for (const type of ["payment.failed", "payment.processing", "license_key.created", "credit.added", "refund.failed", "dispute.opened", "dispute.won"]) {
      const res = await deliver(store, envelope(type, { payment_id: PAY, status: "succeeded", total_amount: 1080, metadata: { org_id: ORG } }), { id: `msg_${type}` });
      expect(res.body).toMatchObject({ status: "ignored" });
    }
    expect(store.credited.size).toBe(0);
    expect(store.refunds.size).toBe(0);
  });
});

describe("subscriptions", () => {
  it("records subscription.active with its plan, customer and period", async () => {
    const store = new FakeStore();
    const res = await deliver(store, subscription("subscription.active"));
    expect(res.body).toMatchObject({ status: "processed" });
    expect(store.subs.get(SUB)).toMatchObject({ orgId: ORG, planId: "pro", productId: PDT_PRO, status: "active", customerId: CUS });
  });

  it("asks for a retry when the first payment arrives before subscription.active, then grants the period", async () => {
    const store = new FakeStore();
    const early = await deliver(store, planPayment(), { id: "msg_pay" });
    expect(early.status).toBe(503);
    expect(store.credited.size).toBe(0);
    await deliver(store, subscription("subscription.active"), { id: "msg_sub" });
    const retry = await deliver(store, planPayment(), { id: "msg_pay" });
    expect(retry.body).toMatchObject({ status: "processed" });
    expect(store.grants).toEqual([{ paymentId: PAY2, planId: "pro", periodEnd: "2026-12-12T10:00:00Z" }]);
  });

  it("grants each renewal's period once", async () => {
    const store = new FakeStore();
    await deliver(store, subscription("subscription.active"), { id: "msg_sub" });
    const renewal = planPayment({
      payment_id: "pay_renewal000000000000",
      charge_type: "renewal",
      service_periods: [{ subscription_id: SUB, starts_at: "2026-12-12T10:00:00Z", ends_at: "2027-01-12T10:00:00Z" }],
    });
    await deliver(store, renewal, { id: "msg_r1" });
    await deliver(store, renewal, { id: "msg_r2" });
    expect(store.grants.map((g) => g.periodEnd)).toEqual(["2027-01-12T10:00:00Z"]);
  });

  it.each([
    ["an amount that is not the plan's price", { total_amount: 1900, tax: 0 }],
    ["a plan-change charge (not automated)", { charge_type: "plan_change" }],
    ["an on-demand charge", { charge_type: "on_demand" }],
    ["no service period", { service_periods: [] }],
    ["a cart naming a pack", { product_cart: [{ product_id: PDT_STARTER, quantity: 1 }] }],
    ["another currency", { currency: "GBP" }],
    ["a discount", { discounts: [{ discount_id: "dsc_x", amount: 100 }] }],
    ["several subscriptions", { is_multi_subscription: true }],
  ])("refuses a plan payment with %s", async (_what, over) => {
    const store = new FakeStore();
    await deliver(store, subscription("subscription.active"), { id: "msg_sub" });
    const res = await deliver(store, planPayment(over), { id: "msg_pay" });
    expect(res.body).toMatchObject({ status: "rejected" });
    expect(store.grants).toEqual([]);
  });

  it("refuses a plan payment whose metadata names another organization than the subscription", async () => {
    const store = new FakeStore();
    await deliver(store, subscription("subscription.active"), { id: "msg_sub" });
    const res = await deliver(store, planPayment({ metadata: signedMeta(OTHER_ORG, USER, "plan:pro") }), { id: "msg_pay" });
    expect(res.body).toMatchObject({ status: "rejected" });
    expect(store.grants).toEqual([]);
  });

  it("keeps a cancellation at the next billing date as 'active, ends at period end'", async () => {
    const store = new FakeStore();
    await deliver(store, subscription("subscription.active"), { id: "msg_1" });
    await deliver(store, subscription("subscription.updated", { cancel_at_next_billing_date: true }), { id: "msg_2" });
    expect(store.subs.get(SUB)).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
  });

  it.each([
    ["on_hold", "paused"],
    ["paused", "paused"],
    ["past_due", "past_due"],
    ["cancelled", "canceled"],
    ["expired", "canceled"],
  ])("maps Dodo's %s to %s", async (dodo, ours) => {
    const store = new FakeStore();
    await deliver(store, subscription("subscription.active"), { id: "msg_1" });
    await deliver(store, subscription("subscription.updated", { status: dodo }), { id: "msg_2" });
    expect(store.subs.get(SUB)?.status).toBe(ours);
  });

  it("ignores pending and failed subscriptions (not a subscription yet)", async () => {
    const store = new FakeStore();
    for (const status of ["pending", "failed"]) {
      expect((await deliver(store, subscription("subscription.updated", { status }), { id: `msg_${status}` })).body).toMatchObject({ status: "ignored" });
    }
    expect(store.subs.size).toBe(0);
  });

  it("still lands a cancellation whose product is no longer mapped, but refuses a NEW subscription without a plan", async () => {
    const store = new FakeStore();
    expect((await deliver(store, subscription("subscription.active", { product_id: "pdt_UNMAPPED00000000000" }), { id: "msg_0" })).body).toMatchObject({ status: "rejected" });
    await deliver(store, subscription("subscription.active"), { id: "msg_1" });
    await deliver(store, subscription("subscription.cancelled", { status: "cancelled", product_id: "pdt_UNMAPPED00000000000" }), { id: "msg_2" });
    expect(store.subs.get(SUB)).toMatchObject({ status: "canceled", planId: "pro" });
  });
});

describe("refunds and disputes", () => {
  async function bought() {
    const store = new FakeStore();
    await deliver(store, payment(), { id: "msg_buy" });
    return store;
  }

  it("a full refund takes everything not already refunded back", async () => {
    const store = await bought();
    const res = await deliver(store, refund(), { id: "msg_ref" });
    expect(res.body).toMatchObject({ status: "processed" });
    expect(store.refunds.get("dodo_refund:ref_0001")).toEqual({ ext: PAY, amount: 1000, reason: "refund" });
  });

  it("a partial refund takes credits back in proportion to the money returned", async () => {
    const store = await bought();
    await deliver(store, refund({ is_partial: true, amount: 270 }), { id: "msg_ref" });
    expect(store.refunds.get("dodo_refund:ref_0001")?.amount).toBe(250); // 1000 × 270 / 1080
  });

  it("a shortfall that sat on a hold is reported as on hold, not as spent (0167, rule 5)", async () => {
    const store = await bought();
    store.refundResult = { taken: 0, shortfall: 1000, onHold: 800 };
    const warns: string[] = [];
    await deliver(store, refund(), { id: "msg_ref", log: { info() {}, warn: (m) => warns.push(m), error() {} } });
    const row = [...store.events.values()].find((e) => e.eventType === "refund.succeeded");
    expect(row?.detail).toBe("refund: took back 0 of 1000 credits; shortfall 1000 (800 on hold, collected if the hold is released)");
    expect(warns).toEqual([
      "dodo-webhook: refund dodo_refund:ref_0001: 800 credits are on hold, collected if the hold is released; 200 credits were already spent and could not be taken back",
    ]);
    expect(warns.join(" ")).not.toContain("1000 credits were already spent");
  });

  it("a shortfall from a database without 0167 is not called spent", async () => {
    const store = await bought();
    store.refundResult = { taken: 400, shortfall: 600, onHold: null };
    const warns: string[] = [];
    await deliver(store, refund(), { id: "msg_ref", log: { info() {}, warn: (m) => warns.push(m), error() {} } });
    const row = [...store.events.values()].find((e) => e.eventType === "refund.succeeded");
    expect(row?.detail).toBe("refund: took back 400 of 1000 credits; shortfall 600");
    expect(warns).toEqual(["dodo-webhook: refund dodo_refund:ref_0001: 600 credits could not be taken back now"]);
  });

  it("a replayed refund takes nothing twice", async () => {
    const store = await bought();
    await deliver(store, refund(), { id: "msg_ref1" });
    const again = await deliver(store, refund(), { id: "msg_ref2" });
    expect(again.body).toMatchObject({ status: "duplicate" });
    expect(store.refunds.size).toBe(1);
  });

  it("a refund that arrives before its payment is retried, not dropped", async () => {
    const store = new FakeStore();
    expect((await deliver(store, refund(), { id: "msg_ref" })).status).toBe(503);
    await deliver(store, payment(), { id: "msg_buy" });
    expect((await deliver(store, refund(), { id: "msg_ref" })).body).toMatchObject({ status: "processed" });
  });

  it("a refund of a payment that was never credited takes nothing", async () => {
    const store = new FakeStore();
    await deliver(store, payment({ total_amount: 999, tax: 0 }), { id: "msg_buy" });
    expect((await deliver(store, refund(), { id: "msg_ref" })).body).toMatchObject({ status: "ignored" });
    expect(store.refunds.size).toBe(0);
  });

  it("a refund that is not succeeded moves nothing", async () => {
    const store = await bought();
    for (const status of ["pending", "review", "failed"]) {
      expect((await deliver(store, refund({ status }), { id: `msg_${status}` })).body).toMatchObject({ status: "ignored" });
    }
    expect(store.refunds.size).toBe(0);
  });

  it("a partial refund in another currency is left to a person", async () => {
    const store = await bought();
    expect((await deliver(store, refund({ is_partial: true, currency: "EUR", amount: 100 }), { id: "msg_ref" })).body).toMatchObject({ status: "rejected" });
    expect(store.refunds.size).toBe(0);
  });

  it.each(["dispute.lost", "dispute.accepted"])("%s is a chargeback of the disputed amount", async (type) => {
    const store = await bought();
    const res = await deliver(store, dispute(type), { id: "msg_dis" });
    expect(res.body).toMatchObject({ status: "processed" });
    expect(store.refunds.get("dodo_dispute:dis_0001")).toEqual({ ext: PAY, amount: 1000, reason: "chargeback" });
  });

  it("a lost dispute whose amount is not a whole number of cents is left to a person", async () => {
    const store = await bought();
    expect((await deliver(store, dispute("dispute.lost", { amount: "5.40" }), { id: "msg_dis" })).body).toMatchObject({ status: "rejected" });
    expect(store.refunds.size).toBe(0);
  });

  it("an expired dispute is surfaced for a person, and takes nothing by itself", async () => {
    const store = await bought();
    expect((await deliver(store, dispute("dispute.expired", { dispute_status: "dispute_expired" }), { id: "msg_dis" })).body).toMatchObject({ status: "rejected" });
    expect(store.refunds.size).toBe(0);
  });

  it("a refund and a lost dispute of the same payment never take back more than it credited", async () => {
    const store = await bought();
    await deliver(store, refund({ is_partial: true, amount: 540 }), { id: "msg_ref" });
    await deliver(store, dispute("dispute.lost"), { id: "msg_dis" });
    const taken = [...store.refunds.values()].reduce((n, r) => n + (r.amount ?? 0), 0);
    expect(taken).toBe(1000);
  });
});

describe("signed metadata (Dodo's static links let anyone write metadata)", () => {
  const forged = [
    ["unsigned (as a metadata_org_id= link would write it)", { org_id: ORG, user_id: USER }],
    ["signed with another secret", signedMeta(ORG, USER, "pack:starter", "another-secret-that-is-long-enough-000")],
    ["signed for one organization, naming another", { ...signedMeta(ORG, USER, "pack:starter"), org_id: OTHER_ORG }],
    ["signed for one user, naming another", { ...signedMeta(ORG, USER, "pack:starter"), user_id: "22222222-2222-4222-8222-222222222222" }],
    ["with a fresh nonce under the old signature", { ...signedMeta(ORG, USER, "pack:starter"), ns_nonce: "f".repeat(32) }],
    ["without its signature", { ...signedMeta(ORG, USER, "pack:starter"), ns_sig: undefined }],
    ["with a malformed signature", { ...signedMeta(ORG, USER, "pack:starter"), ns_sig: "zz" }],
    ["in upper case", signedMeta(ORG.toUpperCase(), USER, "pack:starter")],
  ] as const;

  it.each(forged)("a pack payment with metadata %s credits nothing and names no organization", async (_what, metadata) => {
    const store = new FakeStore();
    const res = await deliver(store, payment({ metadata }));
    expect(res.body).toMatchObject({ status: "rejected" });
    expect(store.credited.size).toBe(0);
    expect(store.events.get("msg_2KWPBgLlAfxdpx2AI54pPJ85f4W")?.orgId ?? null).toBeNull();
  });

  it("a pack payment whose signed item is another pack credits nothing", async () => {
    const store = new FakeStore();
    expect((await deliver(store, payment({ metadata: signedMeta(ORG, USER, "pack:studio") }))).body).toMatchObject({ status: "rejected" });
    expect(store.credited.size).toBe(0);
  });

  it("a correctly signed payment is credited to the organization it names", async () => {
    const store = new FakeStore();
    expect((await deliver(store, payment({ metadata: signedMeta(OTHER_ORG, null, "pack:starter") }))).body).toMatchObject({ status: "processed" });
    expect(store.credited.get(PAY)).toEqual({ org: OTHER_ORG, credits: 1000 });
  });

  it.each(forged)("a subscription with metadata %s is not recorded: no plan, no customer, no portal for anyone", async (_what, metadata) => {
    const store = new FakeStore();
    const res = await deliver(store, subscription("subscription.active", { metadata }));
    expect(res.body).toMatchObject({ status: "rejected" });
    expect(store.subs.size).toBe(0);
  });

  it("a later event of a recorded subscription without metadata is applied to the recorded organization only", async () => {
    const store = new FakeStore();
    await deliver(store, subscription("subscription.active"), { id: "msg_1" });
    await deliver(store, subscription("subscription.updated", { metadata: {}, cancel_at_next_billing_date: true }), { id: "msg_2" });
    expect(store.subs.get(SUB)).toMatchObject({ orgId: ORG, cancelAtPeriodEnd: true });
    // The same subscription, signed for another organization: refused, the row stays ORG's.
    const other = await deliver(store, subscription("subscription.updated", { metadata: signedMeta(OTHER_ORG, null, "plan:pro") }), { id: "msg_3" });
    expect(other.body).toMatchObject({ status: "rejected" });
    expect(store.subs.get(SUB)?.orgId).toBe(ORG);
  });

  it("a forged first payment of a forged subscription waits for a subscription that never lands", async () => {
    const store = new FakeStore();
    await deliver(store, subscription("subscription.active", { metadata: { org_id: OTHER_ORG } }), { id: "msg_sub" });
    expect((await deliver(store, planPayment({ metadata: { org_id: OTHER_ORG } }), { id: "msg_pay" })).body).toMatchObject({ status: "rejected" });
    expect(store.grants).toEqual([]);
  });

  it("verifies in constant time with the deployment's key, and says why it refuses", async () => {
    const key = dodoMetadataKey(META_SECRET)!;
    const m = signedMeta(ORG, USER, "plan:pro");
    expect(await verifyDodoMetadata(m, key)).toEqual({ status: "valid", orgId: ORG, userId: USER, item: "plan:pro", nonce: m.ns_nonce });
    expect(await verifyDodoMetadata({}, key)).toEqual({ status: "absent" });
    expect(await verifyDodoMetadata(null, key)).toEqual({ status: "absent" });
    expect(await verifyDodoMetadata({ org_id: ORG }, key)).toMatchObject({ status: "invalid" });
    expect(dodoMetadataKey("short")).toBeNull();
    expect(dodoMetadataKey("x".repeat(31))).toBeNull();
    expect(dodoMetadataKey("with space " + "x".repeat(32))).toBeNull();
  });

  it("without DODO_METADATA_SECRET or DODO_TAX_MODE grants nothing (Dodo retries), but refunds, disputes and cancellations still land", async () => {
    const store = new FakeStore();
    await deliver(store, payment(), { id: "msg_buy" });
    await deliver(store, subscription("subscription.active"), { id: "msg_sub" });
    // A new purchase, a new subscription and a plan payment wait.
    expect((await deliver(store, payment({ payment_id: "pay_waiting000000000000" }), { id: "msg_a", metadataSecret: "" })).status).toBe(503);
    expect((await deliver(store, payment({ payment_id: "pay_waiting000000000001" }), { id: "msg_b", taxMode: null })).status).toBe(503);
    expect((await deliver(store, subscription("subscription.active", { subscription_id: "sub_NewWhileUnset0001" }), { id: "msg_c", metadataSecret: "" })).status).toBe(503);
    expect((await deliver(store, planPayment(), { id: "msg_d", taxMode: null })).status).toBe(503);
    expect(store.credited.size).toBe(1);
    // Taking back and ending go through.
    expect((await deliver(store, refund({ is_partial: true, amount: 270 }), { id: "msg_e", metadataSecret: "", taxMode: null })).body).toMatchObject({ status: "processed" });
    expect((await deliver(store, dispute("dispute.lost", { amount: "540" }), { id: "msg_f", metadataSecret: "", taxMode: null })).body).toMatchObject({ status: "processed" });
    const cancel = await deliver(store, subscription("subscription.cancelled", { status: "cancelled" }), { id: "msg_g", metadataSecret: "", taxMode: null });
    expect(cancel.body).toMatchObject({ status: "processed" });
    expect(store.subs.get(SUB)?.status).toBe("canceled");
  });
});

describe("a signed blob is good for one purchase (security review M1)", () => {
  it("the reviewer's attack: org A's pack:starter blob on a static-link Business subscription with the victim's customer is refused", async () => {
    const store = new FakeStore();
    const attack = subscription("subscription.active", {
      metadata: signedMeta(ORG, USER, "pack:starter"),
      product_id: PDT_PRO,
      customer: { customer_id: "cus_VICTIM0000000000000", email: "victim@example.com", name: "Victim", metadata: {} },
    });
    expect((await deliver(store, attack)).body).toMatchObject({ status: "rejected" });
    expect(store.subs.size).toBe(0);
  });

  it("a plan blob already spent by one subscription is refused on another (replayed on a static link)", async () => {
    const store = new FakeStore();
    await deliver(store, subscription("subscription.active"), { id: "msg_1" });
    const replay = subscription("subscription.active", { subscription_id: "sub_ReplayedOnLink000001", customer: { customer_id: "cus_VICTIM0000000000000" } });
    const res = await deliver(store, replay, { id: "msg_2" });
    expect(res.body).toMatchObject({ status: "rejected" });
    expect(store.events.get("msg_2")?.detail).toMatch(/nonce consumed/);
    expect(store.subs.has("sub_ReplayedOnLink000001")).toBe(false);
  });

  it("a plan blob for another plan than the product is refused", async () => {
    const store = new FakeStore();
    expect((await deliver(store, subscription("subscription.active", { metadata: signedMeta(ORG, USER, "plan:creator") }))).body).toMatchObject({ status: "rejected" });
    expect(store.subs.size).toBe(0);
  });

  it("a pack blob spent by one payment is refused on a second payment", async () => {
    const store = new FakeStore();
    await deliver(store, payment(), { id: "msg_1" });
    const again = await deliver(store, payment({ payment_id: "pay_secondUSEofBLOB00000" }), { id: "msg_2" });
    expect(again.body).toMatchObject({ status: "rejected" });
    expect(store.events.get("msg_2")?.detail).toMatch(/nonce consumed/);
    expect(total(store)).toBe(1000);
  });

  it("a nonce this deployment never issued, or one that expired, credits nothing", async () => {
    for (const setup of ["unknown", "expired"] as const) {
      const store = new FakeStore();
      const meta = signedMeta(ORG, USER, "pack:starter");
      if (setup === "unknown") store.unknownNonces.add(meta.ns_nonce);
      else store.nonces.set(meta.ns_nonce, { key: `${ORG}|${USER}|pack:starter`, consumer: null, expired: true });
      expect((await deliver(store, payment({ metadata: meta }))).body).toMatchObject({ status: "rejected" });
      expect(store.credited.size).toBe(0);
    }
  });

  it("a pack blob on a subscription payment credits nothing", async () => {
    const store = new FakeStore();
    await deliver(store, subscription("subscription.active"), { id: "msg_sub" });
    expect((await deliver(store, planPayment({ metadata: signedMeta(ORG, USER, "pack:starter") }), { id: "msg_pay" })).body).toMatchObject({ status: "rejected" });
    expect(store.grants).toEqual([]);
  });

  it("Dodo's retry of the same payment or subscription spends the same nonce again", async () => {
    const store = new FakeStore();
    store.failNext = new StoreError("db down", null);
    expect((await deliver(store, payment(), { id: "msg_1" })).status).toBe(500);
    expect((await deliver(store, payment(), { id: "msg_1" })).body).toMatchObject({ status: "processed" });
    expect(total(store)).toBe(1000);
  });
});

describe("test mode on a production database", () => {
  it("is the default: only `live` exactly is live", () => {
    expect(["live", "Live", "", "test", "production", undefined].map((v) => dodoWebhookModeFromEnv(v))).toEqual(["live", "test", "test", "test", "test", "test"]);
    expect([...dodoTestOrgsFromEnv(`${ORG.toUpperCase()}, nope ${OTHER_ORG}`)]).toEqual([ORG, OTHER_ORG]);
  });

  it("credits nothing to an organization that is not allow-listed: a public test card buys no real credits", async () => {
    const store = new FakeStore();
    const res = await deliver(store, payment(), { mode: "test", testOrgs: [] });
    expect(res.body).toMatchObject({ status: "rejected" });
    expect(store.events.get("msg_2KWPBgLlAfxdpx2AI54pPJ85f4W")?.detail).toMatch(/DODO_TEST_ORG_IDS/);
    expect(store.credited.size).toBe(0);
  });

  it("records no plan for an organization that is not allow-listed", async () => {
    const store = new FakeStore();
    expect((await deliver(store, subscription("subscription.active"), { mode: "test", testOrgs: [OTHER_ORG] })).body).toMatchObject({ status: "rejected" });
    expect(store.subs.size).toBe(0);
  });

  it("works end to end for an allow-listed test workspace, refunds included", async () => {
    const store = new FakeStore();
    const t = { mode: "test" as const, testOrgs: [ORG] };
    expect((await deliver(store, payment(), { ...t, id: "msg_buy" })).body).toMatchObject({ status: "processed" });
    await deliver(store, subscription("subscription.active"), { ...t, id: "msg_sub" });
    expect((await deliver(store, planPayment(), { ...t, id: "msg_pay" })).body).toMatchObject({ status: "processed" });
    expect((await deliver(store, refund(), { ...t, id: "msg_ref" })).body).toMatchObject({ status: "processed" });
    expect(store.refunds.get("dodo_refund:ref_0001")?.amount).toBe(1000);
  });
});

describe("refunds and disputes never count the same money twice", () => {
  it("a dispute resolved by Visa RDR (a refund) takes nothing by itself and is left for a person", async () => {
    const store = new FakeStore();
    await deliver(store, payment(), { id: "msg_buy" });
    const res = await deliver(store, dispute("dispute.lost", { is_resolved_by_rdr: true }), { id: "msg_dis" });
    expect(res.body).toMatchObject({ status: "rejected" });
    expect(store.refunds.size).toBe(0);
  });

  it("a partial refund, then a lost dispute of the whole payment, takes back only the remainder", async () => {
    const store = new FakeStore();
    await deliver(store, payment(), { id: "msg_buy" });
    await deliver(store, refund({ is_partial: true, amount: 540 }), { id: "msg_ref" });
    await deliver(store, dispute("dispute.lost", { amount: "1080" }), { id: "msg_dis" });
    expect(store.refunds.get("dodo_refund:ref_0001")?.amount).toBe(500);
    expect(store.refunds.get("dodo_dispute:dis_0001")?.amount).toBe(500);
    expect([...store.refunds.values()].reduce((n, r) => n + (r.amount ?? 0), 0)).toBe(1000);
  });
});

describe("the REST store", () => {
  function recorder() {
    const calls: { url: string; body: unknown }[] = [];
    const fetchFake = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/rpc/grant_subscription_credits_for")) return new Response(JSON.stringify({ duplicate: false, granted: 6000 }));
      if (url.includes("/rpc/")) return new Response(JSON.stringify({ duplicate: false }));
      return new Response("[]");
    };
    return { calls, store: createDodoRestStore({ url: "https://x.supabase.co/", serviceKey: "service-key-secret", fetch: fetchFake }) };
  }

  it("writes every row as provider 'dodo' through the same database functions as Paddle", async () => {
    const { calls, store } = recorder();
    await store.recordEvent({ eventId: "msg_1", eventType: "payment.succeeded", occurredAt: null, status: "processed", detail: "x" });
    await store.addPurchasedCredits(ORG, 1000, PAY, "n");
    await store.refundPurchasedCredits(PAY, "dodo_refund:r", null, "n", "refund");
    await store.upsertSubscription({ orgId: ORG, subscriptionId: SUB, customerId: CUS, planId: "pro", productId: PDT_PRO, status: "active", periodStart: null, periodEnd: null, cancelAtPeriodEnd: false, canceledAt: null, occurredAt: null });
    await store.grantSubscriptionCredits({ orgId: ORG, subscriptionId: SUB, planId: "pro", periodStart: "a", periodEnd: "b", paymentId: PAY2, note: "n", productId: PDT_PRO });
    await store.eventStatus("msg_1");
    await store.findPurchase(PAY);
    await store.findSubscription(SUB);
    const rpc = calls.filter((c) => c.url.includes("/rpc/")).map((c) => c.url.split("/rpc/")[1]);
    expect(rpc).toEqual(["record_payment_event", "add_purchased_credits", "refund_purchased_credits", "upsert_subscription_for", "grant_subscription_credits_for"]);
    expect((calls[0].body as Record<string, unknown>).p_provider).toBe("dodo");
    expect((calls[3].body as Record<string, unknown>).p_provider).toBe("dodo");
    expect(calls[4].body).toMatchObject({ p_provider: "dodo", p_external_id: PAY2, p_paid_share: 1 });
    for (const c of calls.filter((c) => !c.url.includes("/rpc/"))) expect(c.url).toContain("provider=eq.dodo");
  });

  it("never puts the service key into an error", async () => {
    const store = createDodoRestStore({
      url: "https://x.supabase.co",
      serviceKey: "service-key-secret",
      fetch: async () => new Response(JSON.stringify({ code: "22023", message: "bad" }), { status: 400 }),
    });
    const err = await store.addPurchasedCredits(ORG, 1, PAY, "n").catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe("22023");
    expect(String(err)).not.toContain("service-key-secret");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A typed amount (the "Add credits" sheet): what would break without these is the one case where the BUYER picks the price.
// A static Pay What You Want link (paymentAmount=…) lets anyone choose what to pay; the credits must still come only from the
// cents our server signed, and only when Dodo reports exactly those cents paid.
// ───────────────────────────────────────────────────────────────────────────

const PAY_AMT = "pay_TypedAMOUNT00000000001";

/** payment.succeeded for a typed $25.00, tax-exclusive by default: $25.00 + $2.00 tax. */
function amountPayment(cents = 2500, overrides: Record<string, unknown> = {}, signedCents: number | string = cents) {
  return payment({
    payment_id: PAY_AMT,
    total_amount: cents + 200,
    tax: 200,
    metadata: signedMeta(ORG, USER, `pack:amount_${signedCents}`),
    product_cart: [{ product_id: PDT_AMOUNT, quantity: 1 }],
    ...overrides,
  });
}

describe("a typed amount", () => {
  it("is the same offer on both sides: 1 credit per US cent, $5 to $300, presets $10 / $20 / $50 / $100", () => {
    expect(APP_AMOUNT).toEqual(DODO_AMOUNT);
    expect(DODO_AMOUNT).toEqual({ creditsPerCent: 1, minCents: 500, maxCents: 30000, presetsCents: [1000, 2000, 5000, 10000] });
    // The base rate is the Starter pack's own: a typed $10 buys exactly what the Starter pack buys.
    const starter = DODO_PACKS.find((p) => p.id === "starter")!;
    expect(starter.usdCents * DODO_AMOUNT.creditsPerCent).toBe(starter.credits);
    // No pack can be read as a typed amount, or the other way round.
    expect(DODO_PACKS.some((p) => p.id.startsWith("amount_"))).toBe(false);
  });

  it("signs exactly the item the webhook reads, and only its one canonical spelling inside the bounds", () => {
    expect(dodoItemKey({ kind: "amount", usdCents: 2500 })).toBe("pack:amount_2500");
    expect(dodoAmountFromItem("pack:amount_2500")).toBe(2500);
    expect(dodoAmountFromItem("pack:amount_500")).toBe(500);
    expect(dodoAmountFromItem("pack:amount_30000")).toBe(30000);
    for (const bad of ["pack:amount_499", "pack:amount_30001", "pack:amount_02500", "pack:amount_2500.5", "pack:amount_-2500", "pack:amount_", "plan:amount_2500", "amount:2500", "pack:starter", null])
      expect(dodoAmountFromItem(bad)).toBeNull();
  });

  it("credits the signed cents, tax-exclusive: $25.00 + $2.00 tax = 2,500 credits", async () => {
    const store = new FakeStore();
    const res = await deliver(store, amountPayment(2500), { taxMode: "exclusive" });
    expect(res.status).toBe(200);
    expect(store.credited.get(PAY_AMT)).toEqual({ org: ORG, credits: 2500 });
    expect([...store.events.values()][0]).toMatchObject({ status: "processed", credits: 2500, amountMinor: 2700, currency: "USD" });
    // The nonce spent is the one the checkout issued for THIS item, so the database binds the amount too.
    expect([...store.nonces.values()][0].key).toBe(`${ORG}|${USER}|pack:amount_2500`);
  });

  it("credits the signed cents, tax-inclusive: $25.00 with $1.85 tax inside = 2,500 credits", async () => {
    const store = new FakeStore();
    const res = await deliver(store, amountPayment(2500, { total_amount: 2500, tax: 185 }), { taxMode: "inclusive" });
    expect(res.status).toBe(200);
    expect(store.credited.get(PAY_AMT)?.credits).toBe(2500);
  });

  it("applies the tax mode strictly: the other shape of the same money is not credited", async () => {
    const inclusive = new FakeStore();
    await deliver(inclusive, amountPayment(2500), { taxMode: "inclusive" }); // total 2700 is not 2500
    expect(inclusive.credited.size).toBe(0);
    const exclusive = new FakeStore();
    await deliver(exclusive, amountPayment(2500, { total_amount: 2500, tax: 185 }), { taxMode: "exclusive" }); // 2315 is not 2500
    expect(exclusive.credited.size).toBe(0);
  });

  it("the buyer's own price on a static PWYW link is never what is credited: paid ≠ signed is rejected and recorded", async () => {
    for (const paid of [500, 2499, 2501, 30000]) {
      const store = new FakeStore();
      const res = await deliver(store, amountPayment(2500, { total_amount: paid + 200, tax: 200 }));
      expect(res.status).toBe(200);
      expect(store.credited.size).toBe(0);
      const row = [...store.events.values()][0];
      expect(row.status).toBe("rejected");
      expect(row.detail).toContain("signed amount is 2500");
      expect(row.amountMinor).toBe(paid + 200);
      // Rejected before the nonce is touched: the real checkout's payment can still arrive and be credited.
      expect(store.nonces.size).toBe(0);
    }
  });

  it("a signed amount edited in the metadata (a bigger number under our signature) names no organization", async () => {
    const store = new FakeStore();
    const meta = { ...signedMeta(ORG, USER, "pack:amount_500"), nightshift_item: "pack:amount_30000" };
    await deliver(store, amountPayment(30000, { metadata: meta }));
    expect(store.credited.size).toBe(0);
    const row = [...store.events.values()][0];
    expect(row).toMatchObject({ status: "rejected", orgId: null });
    expect(row.detail).toContain("signature mismatch");
  });

  it("an amount outside the bounds is not credited even under a valid signature", async () => {
    for (const signed of [100, 499, 30001, "02500"]) {
      const store = new FakeStore();
      const cents = typeof signed === "number" ? signed : 2500;
      await deliver(store, amountPayment(cents, {}, signed));
      expect(store.credited.size).toBe(0);
      expect([...store.events.values()][0].status).toBe("rejected");
    }
  });

  it("a typed amount's blob on a pack product, or a pack's blob on the PWYW product, is not credited", async () => {
    const onPack = new FakeStore();
    await deliver(onPack, amountPayment(1000, { product_cart: [{ product_id: PDT_STARTER, quantity: 1 }], total_amount: 1080, tax: 80 }));
    expect(onPack.credited.size).toBe(0);
    expect([...onPack.events.values()][0].detail).toContain("signed item is pack:amount_1000");
    const packOnPwyw = new FakeStore();
    await deliver(packOnPwyw, payment({ product_cart: [{ product_id: PDT_AMOUNT, quantity: 1 }] }));
    expect(packOnPwyw.credited.size).toBe(0);
    expect([...packOnPwyw.events.values()][0].detail).toContain("custom-amount product, but the signed item is pack:starter");
  });

  it("quantity 2 (twice the signed amount) or a second line is not credited", async () => {
    const two = new FakeStore();
    await deliver(two, amountPayment(2500, { product_cart: [{ product_id: PDT_AMOUNT, quantity: 2 }], total_amount: 5200, tax: 200 }));
    expect(two.credited.size).toBe(0);
    const lines = new FakeStore();
    await deliver(lines, amountPayment(2500, { product_cart: [{ product_id: PDT_AMOUNT, quantity: 1 }, { product_id: PDT_STARTER, quantity: 1 }] }));
    expect(lines.credited.size).toBe(0);
  });

  it("without DODO_PRODUCT_AMOUNT on the webhook, a typed amount is not credited (never read as some pack)", async () => {
    const store = new FakeStore();
    await deliver(store, amountPayment(2500), { amountProduct: null });
    expect(store.credited.size).toBe(0);
    expect([...store.events.values()][0].detail).toContain("is not a credit pack on this deployment");
  });

  it("a duplicate delivery credits once: the same webhook id replayed, and the same payment under a second webhook id", async () => {
    const store = new FakeStore();
    await deliver(store, amountPayment(2500), { id: "msg_amt_1" });
    const replay = await deliver(store, amountPayment(2500), { id: "msg_amt_1" });
    const again = await deliver(store, amountPayment(2500), { id: "msg_amt_2" });
    expect(replay.body).toMatchObject({ duplicate: true });
    expect(again.status).toBe(200);
    expect(store.events.get("msg_amt_2")?.status).toBe("duplicate");
    expect(total(store)).toBe(2500);
  });

  it("the same signed blob paid twice (a second payment on a static link) is refused: the nonce is spent once", async () => {
    const store = new FakeStore();
    await deliver(store, amountPayment(2500), { id: "msg_amt_a" });
    await deliver(store, amountPayment(2500, { payment_id: "pay_SecondPAYMENTonLINK0001" }), { id: "msg_amt_b" });
    expect(total(store)).toBe(2500);
    expect(store.events.get("msg_amt_b")).toMatchObject({ status: "rejected" });
    expect(store.events.get("msg_amt_b")?.detail).toContain("nonce consumed");
  });

  it("test mode credits a typed amount only for an allow-listed workspace", async () => {
    const off = new FakeStore();
    await deliver(off, amountPayment(2500), { mode: "test", testOrgs: [OTHER_ORG] });
    expect(off.credited.size).toBe(0);
    const on = new FakeStore();
    await deliver(on, amountPayment(2500), { mode: "test", testOrgs: [ORG] });
    expect(on.credited.get(PAY_AMT)?.credits).toBe(2500);
  });

  it("a partial refund of a typed amount takes back credits in proportion to the money", async () => {
    const store = new FakeStore();
    await deliver(store, amountPayment(2500), { id: "msg_amt_pay" });
    await deliver(store, refund({ payment_id: PAY_AMT, is_partial: true, amount: 1350 }), { id: "msg_amt_ref" });
    // 1350 of 2700 charged = half: 1250 of the 2500 credits.
    expect(store.refunds.get("dodo_refund:ref_0001")?.amount).toBe(1250);
  });

  it("reads DODO_PRODUCT_AMOUNT only when it is a product id of its own", () => {
    expect(dodoAmountProductFromEnv((n) => ({ DODO_PRODUCT_AMOUNT: PDT_AMOUNT })[n], packs, plans)).toBe(PDT_AMOUNT);
    expect(dodoAmountProductFromEnv((n) => ({ DODO_PRODUCT_AMOUNT: PDT_STARTER })[n], packs, plans)).toBeNull();
    expect(dodoAmountProductFromEnv((n) => ({ DODO_PRODUCT_AMOUNT: PDT_PRO })[n], packs, plans)).toBeNull();
    expect(dodoAmountProductFromEnv((n) => ({ DODO_PRODUCT_AMOUNT: "pri_paddle0000000000" })[n], packs, plans)).toBeNull();
    expect(dodoAmountProductFromEnv(() => undefined, packs, plans)).toBeNull();
  });
});
