import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRestStore,
  creditsForShare,
  decideApiTopup,
  decideEvent,
  decideSubscription,
  decideSubscriptionPayment,
  decideTransaction,
  handlePaddleWebhook,
  paidShare,
  planTableFromEnv,
  priceTableFromEnv,
  promoAllowlistFromEnv,
  type EventRecord,
  type PaddleEvent,
  type PaddleStore,
  type PurchaseRecord,
  type SubscriptionStatus,
} from "../../supabase/functions/_shared/paddle";

// Subscriptions in the Paddle webhook (migration 0034): which events move
// what, idempotency on replays, and that nothing the payload says sets a
// number of credits (the database's plans table does).

const SECRET = "pdl_ntfset_test_secret";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRICE_PACK = "pri_01starter0000000000000000";
const PRICE_CREATOR = "pri_01plancreator000000000000";
const PRICE_PRO = "pri_01planpro00000000000000000";
const SUB = "sub_01h000000000000000000000cc";
const CTM = "ctm_01h000000000000000000000dd";
const TXN = "txn_01h000000000000000000000ee";
const NOW_MS = 1_760_000_000_000;
const NOW_S = NOW_MS / 1000;

const packs = priceTableFromEnv((n) => ({ PADDLE_PRICE_STARTER: PRICE_PACK })[n]);
const plans = planTableFromEnv(
  [
    ["PADDLE_PLAN_CREATOR", PRICE_CREATOR],
    ["PADDLE_PLAN_PRO", ` ${PRICE_PRO} `],
    ["PADDLE_PLAN_BROKEN", "not-a-price"],
    ["PADDLE_PLAN_STARTER_TOO", PRICE_PACK],
    ["PADDLE_PRICE_STARTER", PRICE_PACK],
    ["SOMETHING_ELSE", PRICE_CREATOR],
  ],
  packs,
);

function sign(body: string, ts = NOW_S): string {
  return `ts=${ts};h1=${createHmac("sha256", SECRET).update(`${ts}:${body}`).digest("hex")}`;
}

function subEvent(type: string, data: Record<string, unknown> = {}, eventId = "evt_sub1", occurredAt = "2026-10-01T10:00:00Z") {
  return JSON.stringify({
    event_id: eventId,
    event_type: type,
    occurred_at: occurredAt,
    data: {
      id: SUB,
      status: "active",
      customer_id: CTM,
      custom_data: { org_id: ORG },
      items: [{ price: { id: PRICE_CREATOR }, quantity: 1 }],
      current_billing_period: { starts_at: "2026-10-01T10:00:00Z", ends_at: "2026-11-01T10:00:00Z" },
      scheduled_change: null,
      ...data,
    },
  });
}

function planPaid(data: Record<string, unknown> = {}, eventId = "evt_txn1") {
  return JSON.stringify({
    event_id: eventId,
    event_type: "transaction.completed",
    occurred_at: "2026-10-01T10:00:05Z",
    data: {
      id: TXN,
      status: "completed",
      origin: "web",
      subscription_id: SUB,
      customer_id: CTM,
      currency_code: "USD",
      custom_data: { org_id: ORG },
      items: [{ price: { id: PRICE_CREATOR }, quantity: 1 }],
      billing_period: { starts_at: "2026-10-01T10:00:00Z", ends_at: "2026-11-01T10:00:00Z" },
      details: { totals: { grand_total: "1900" } },
      ...data,
    },
  });
}

class FakeStore implements PaddleStore {
  events = new Map<string, EventRecord>();
  orgs = new Set([ORG]);
  subs = new Map<string, { org: string; plan: string; status: SubscriptionStatus; last: string | null; cancel: boolean }>();
  periods = new Map<string, { granted: number; txns: Set<string> }>();
  allowance: Record<string, number> = { creator: 2000, pro: 6000 };
  grants: string[] = [];
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
  async addPurchasedCredits(): Promise<{ duplicate: boolean }> {
    throw new Error("a plan must never be credited as a pack");
  }
  async findPurchase(): Promise<PurchaseRecord | null> {
    return null;
  }
  async refundPurchasedCredits() {
    return { duplicate: false, requested: 0, taken: 0, shortfall: 0 };
  }
  async findSubscriptionOrg(id: string) {
    return this.subs.get(id)?.org ?? null;
  }
  async upsertSubscription(s: Parameters<NonNullable<PaddleStore["upsertSubscription"]>>[0]) {
    const cur = this.subs.get(s.subscriptionId);
    if (cur?.last && s.occurredAt && s.occurredAt < cur.last) return { stale: true };
    const plan = s.planId ?? cur?.plan;
    if (!plan) throw new Error("a new subscription needs a known plan");
    this.subs.set(s.subscriptionId, { org: s.orgId, plan, status: s.status, last: s.occurredAt, cancel: s.cancelAtPeriodEnd });
    return { stale: false };
  }
  // Mirrors grant_subscription_credits: idempotent per transaction and per period.
  async grantSubscriptionCredits(g: Parameters<NonNullable<PaddleStore["grantSubscriptionCredits"]>>[0]) {
    const key = `${g.subscriptionId}:${g.periodEnd}`;
    const p = this.periods.get(key) ?? { granted: 0, txns: new Set<string>() };
    if (p.txns.has(g.transactionId)) return { duplicate: true, granted: 0 };
    p.txns.add(g.transactionId);
    const add = Math.max(this.allowance[g.planId] - p.granted, 0);
    p.granted += add;
    this.periods.set(key, p);
    if (!this.subs.has(g.subscriptionId))
      this.subs.set(g.subscriptionId, { org: g.orgId, plan: g.planId, status: "active", last: null, cancel: false });
    this.grants.push(`${g.planId}:${add}`);
    return { duplicate: false, granted: add };
  }
}

async function deliver(store: FakeStore, body: string) {
  return handlePaddleWebhook(
    { method: "POST", rawBody: body, signature: sign(body) },
    { secret: SECRET, prices: packs, plans, store, now: () => NOW_MS, log: { info() {}, warn() {}, error() {} } },
  );
}

const ev = (type: string, data: Record<string, unknown>): PaddleEvent => ({
  eventId: "evt_x",
  eventType: type,
  occurredAt: "2026-10-01T10:00:00Z",
  data,
});

describe("plan price table", () => {
  it("maps PADDLE_PLAN_<ID> to a lowercase plan id and skips bad, duplicate or pack prices", () => {
    expect([...plans.entries()]).toEqual([
      [PRICE_CREATOR, "creator"],
      [PRICE_PRO, "pro"],
    ]);
  });
});

describe("decisions", () => {
  it("a plan's completed transaction is a subscription payment, never a pack purchase", () => {
    const d = decideSubscriptionPayment(JSON.parse(planPaid()).data, plans);
    expect(d).toMatchObject({
      kind: "subscription_payment",
      orgId: ORG,
      subscriptionId: SUB,
      customerId: CTM,
      planId: "creator",
      periodStart: "2026-10-01T10:00:00Z",
      periodEnd: "2026-11-01T10:00:00Z",
    });
    expect(decideEvent({ ...ev("transaction.completed", JSON.parse(planPaid()).data) }, packs, null, plans).kind).toBe(
      "subscription_payment",
    );
  });

  it("the payload never sets the credits", () => {
    const d = decideSubscriptionPayment(JSON.parse(planPaid({ credits: 999999, custom_data: { org_id: ORG, credits: 5 } })).data, plans);
    expect(JSON.stringify(d)).not.toMatch(/999999/);
    expect(d).not.toHaveProperty("credits");
  });

  it.each([
    [{ subscription_id: null }, /subscription id/],
    [{ billing_period: null }, /billing period/],
    [{ billing_period: { starts_at: "2026-11-01T10:00:00Z", ends_at: "2026-10-01T10:00:00Z" } }, /billing period/],
    [{ items: [{ price: { id: PRICE_CREATOR }, quantity: 2 }] }, /quantity/],
    [{ items: [{ price: { id: PRICE_CREATOR }, quantity: 1 }, { price: { id: PRICE_PACK }, quantity: 1 }] }, /not a plan/],
    [{ items: [{ price: { id: PRICE_CREATOR }, quantity: 1 }, { price: { id: PRICE_PRO }, quantity: 1 }] }, /several plans/],
  ])("rejects an unusable plan payment %#", (over, why) => {
    const d = decideSubscriptionPayment(JSON.parse(planPaid(over)).data, plans);
    expect(d.kind).toBe("reject");
    expect(d.kind === "reject" && d.detail).toMatch(why);
  });

  it("a transaction with a subscription id but no plan price is rejected, not credited as a pack", () => {
    const d = decideEvent(
      ev("transaction.completed", JSON.parse(planPaid({ items: [{ price: { id: PRICE_PACK }, quantity: 1 }] })).data),
      packs,
      null,
      plans,
    );
    expect(d.kind).toBe("reject");
  });

  it("reads a subscription's state, including a scheduled cancellation", () => {
    const d = decideSubscription(
      { ...ev("subscription.updated", JSON.parse(subEvent("subscription.updated", { scheduled_change: { action: "cancel" } })).data) },
      plans,
    );
    expect(d).toMatchObject({ kind: "subscription_state", status: "active", cancelAtPeriodEnd: true, planId: "creator" });
  });

  it("ignores an unknown status; an unmapped price still records the state with the plan left unchanged", () => {
    expect(decideSubscription(ev("subscription.updated", JSON.parse(subEvent("x", { status: "weird" })).data), plans).kind).toBe(
      "ignore",
    );
    expect(
      decideSubscription(
        ev(
          "subscription.canceled",
          JSON.parse(subEvent("x", { status: "canceled", items: [{ price: { id: "pri_01unknown00000000000000000" } }] })).data,
        ),
        plans,
      ),
    ).toMatchObject({ kind: "subscription_state", status: "canceled", planId: null, priceId: null });
  });

  it("a cancellation for a rotated price still lands", async () => {
    const store = new FakeStore();
    await deliver(store, subEvent("subscription.created"));
    await deliver(
      store,
      subEvent(
        "subscription.canceled",
        { status: "canceled", items: [{ price: { id: "pri_01rotated00000000000000000" } }] },
        "evt_cancel",
        "2026-10-20T00:00:00Z",
      ),
    );
    expect(store.subs.get(SUB)).toMatchObject({ status: "canceled", plan: "creator" });
  });
});

describe("the handler", () => {
  it("records state and grants the period once, whatever the delivery order and replays", async () => {
    const store = new FakeStore();
    // The payment can arrive before subscription.created.
    expect((await deliver(store, planPaid())).status).toBe(200);
    expect((await deliver(store, subEvent("subscription.created"))).status).toBe(200);
    // Replays of both: nothing new.
    await deliver(store, planPaid());
    await deliver(store, subEvent("subscription.created"));
    // A second event id for the same transaction (Paddle re-sent it): the database says duplicate.
    await deliver(store, planPaid({}, "evt_txn1_again"));
    expect(store.grants).toEqual(["creator:2000"]);
    expect(store.events.get("evt_txn1")).toMatchObject({ status: "processed", credits: 2000, transactionId: TXN, orgId: ORG });
    expect(store.events.get("evt_txn1_again")).toMatchObject({ status: "duplicate" });
  });

  it("a renewal without custom_data finds the organization from the subscription", async () => {
    const store = new FakeStore();
    await deliver(store, subEvent("subscription.created"));
    const renewal = planPaid(
      {
        id: "txn_01h000000000000000000000ff",
        origin: "subscription_recurring",
        custom_data: null,
        billing_period: { starts_at: "2026-11-01T10:00:00Z", ends_at: "2026-12-01T10:00:00Z" },
      },
      "evt_renew",
    );
    expect((await deliver(store, renewal)).status).toBe(200);
    expect(store.grants).toEqual(["creator:2000"]);
    expect(store.events.get("evt_renew")).toMatchObject({ status: "processed", orgId: ORG });
  });

  it("an older subscription event does not undo a newer one", async () => {
    const store = new FakeStore();
    await deliver(store, subEvent("subscription.canceled", { status: "canceled" }, "evt_new", "2026-10-05T00:00:00Z"));
    await deliver(store, subEvent("subscription.updated", { status: "active" }, "evt_old", "2026-10-02T00:00:00Z"));
    expect(store.subs.get(SUB)?.status).toBe("canceled");
    expect(store.events.get("evt_old")).toMatchObject({ status: "ignored" });
  });

  it("no organization anywhere: rejected (a person must look), not retried forever", async () => {
    const store = new FakeStore();
    const res = await deliver(store, planPaid({ custom_data: null }));
    expect(res.status).toBe(200);
    expect(store.events.get("evt_txn1")).toMatchObject({ status: "rejected" });
    expect(store.grants).toEqual([]);
  });

  it("a store without plan support fails temporarily so Paddle retries", async () => {
    const store = new FakeStore();
    const bare: PaddleStore = {
      eventStatus: store.eventStatus.bind(store),
      recordEvent: store.recordEvent.bind(store),
      orgExists: store.orgExists.bind(store),
      addPurchasedCredits: store.addPurchasedCredits.bind(store),
      findPurchase: store.findPurchase.bind(store),
      refundPurchasedCredits: store.refundPurchasedCredits.bind(store),
    };
    const body = planPaid();
    const res = await handlePaddleWebhook(
      { method: "POST", rawBody: body, signature: sign(body) },
      { secret: SECRET, prices: packs, plans, store: bare, now: () => NOW_MS, log: { info() {}, warn() {}, error() {} } },
    );
    expect(res.status).toBe(500);
  });

  it("a forged signature moves nothing", async () => {
    const store = new FakeStore();
    const body = planPaid();
    const res = await handlePaddleWebhook(
      { method: "POST", rawBody: body, signature: sign(body).replace(/h1=./, "h1=0") },
      { secret: SECRET, prices: packs, plans, store, now: () => NOW_MS, log: { info() {}, warn() {}, error() {} } },
    );
    expect(res.status).toBe(401);
    expect(store.grants).toEqual([]);
  });
});

describe("REST store", () => {
  it("calls the 0034 functions with the service key and exact argument names", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const store = createRestStore({
      url: "https://x.supabase.co/",
      serviceKey: "service-key",
      fetch: async (url, init) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        const payload = url.includes("grant_subscription_credits")
          ? { duplicate: false, granted: 2000 }
          : url.includes("upsert_subscription")
            ? { stale: false }
            : [{ org_id: ORG }];
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    });
    expect(await store.findSubscriptionOrg!(SUB)).toBe(ORG);
    expect(
      await store.grantSubscriptionCredits!({
        orgId: ORG,
        subscriptionId: SUB,
        planId: "creator",
        periodStart: "2026-10-01T10:00:00Z",
        periodEnd: "2026-11-01T10:00:00Z",
        transactionId: TXN,
        note: "n",
        customerId: CTM,
        priceId: PRICE_CREATOR,
        paidShare: 1,
      }),
    ).toEqual({ duplicate: false, granted: 2000 });
    expect(
      await store.upsertSubscription!({
        orgId: ORG,
        subscriptionId: SUB,
        customerId: CTM,
        planId: "creator",
        priceId: PRICE_CREATOR,
        status: "active",
        periodStart: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        occurredAt: null,
      }),
    ).toEqual({ stale: false });
    expect(calls[0].url).toContain("/rest/v1/subscriptions?provider=eq.paddle&provider_subscription_id=eq.");
    expect(calls[1].url).toMatch(/\/rest\/v1\/rpc\/grant_subscription_credits$/);
    expect(Object.keys(calls[1].body as object).sort()).toEqual(
      [
        "p_customer_id",
        "p_external_id",
        "p_note",
        "p_org",
        "p_paid_share",
        "p_period_end",
        "p_period_start",
        "p_plan",
        "p_price_id",
        "p_subscription_id",
      ].sort(),
    );
    expect(calls[2].url).toMatch(/\/rest\/v1\/rpc\/upsert_subscription$/);
    expect(Object.keys(calls[2].body as object)).toHaveLength(11);
  });
});

// ── Discounts (security audit P3): credits follow what was PAID ──────────────

const DSC = "dsc_01h000000000000000000000aa";
const PROMO = "dsc_01h000000000000000000000pp";
const promos = promoAllowlistFromEnv(` ${PROMO}, not-a-discount ,dsc_short`);

function packTxn(over: Record<string, unknown> = {}) {
  return {
    id: TXN,
    status: "completed",
    currency_code: "USD",
    custom_data: { org_id: ORG },
    items: [{ price: { id: PRICE_PACK }, quantity: 1 }],
    details: { totals: { subtotal: "1000", discount: "0", grand_total: "1000" } },
    ...over,
  };
}

describe("discounts", () => {
  it("reads the allowlist strictly", () => {
    expect([...promos]).toEqual([PROMO]);
  });

  it("paid share from Paddle's totals", () => {
    expect(paidShare(packTxn())).toEqual({ share: 1, discountId: null, promo: false });
    expect(paidShare(packTxn({ details: { totals: { grand_total: "1000" } } }))).toMatchObject({ share: 1 });
    expect(paidShare(packTxn({ discount_id: DSC, details: { totals: { subtotal: "1000", discount: "250" } } }))).toMatchObject({
      share: 0.75,
      discountId: DSC,
    });
    expect(paidShare(packTxn({ discount_id: DSC, details: { totals: { subtotal: "1000", discount: "1000" } } }))).toMatchObject({
      share: 0,
    });
    expect(paidShare(packTxn({ discount_id: PROMO, details: { totals: { subtotal: "1000", discount: "1000" } } }), promos)).toEqual({
      share: 1,
      discountId: PROMO,
      promo: true,
    });
    // A discount with no readable subtotal, a garbled discount total, a malformed id: never guessed.
    expect(paidShare(packTxn({ discount_id: DSC, details: { totals: { discount: "100" } } }))).toHaveProperty("error");
    expect(paidShare(packTxn({ details: { totals: { subtotal: "1000", discount: "ten" } } }))).toHaveProperty("error");
    expect(paidShare(packTxn({ discount_id: "DSC-free" }))).toHaveProperty("error");
    // A discount amount without an id still counts.
    expect(paidShare(packTxn({ details: { totals: { subtotal: "1000", discount: "500" } } }))).toMatchObject({ share: 0.5 });
  });

  it("rounds credits down to the cent, never up", () => {
    expect(creditsForShare(1000, 1 / 3)).toBe(333.33);
    expect(creditsForShare(5000, 0.5)).toBe(2500);
    expect(creditsForShare(100, 0.29)).toBe(29); // 28.999999999999996 in floating point
    expect(creditsForShare(1000, 0.999999999)).toBe(999.99);
  });

  it("a discounted pack mints credits for what was paid", () => {
    const d = decideTransaction(
      packTxn({ discount_id: DSC, details: { totals: { subtotal: "1000", discount: "400", grand_total: "600" } } }),
      packs,
    );
    expect(d).toMatchObject({ kind: "purchase", credits: 600 });
    expect(d.kind === "purchase" && d.note).toMatch(/60\.00% paid → 600 of 1000 credits/);
  });

  it("a 100%-discounted pack mints nothing unless the discount is an allowed promo", () => {
    const free = packTxn({ discount_id: DSC, details: { totals: { subtotal: "1000", discount: "1000", grand_total: "0" } } });
    expect(decideTransaction(free, packs).kind).toBe("reject");
    const promo = packTxn({ discount_id: PROMO, details: { totals: { subtotal: "1000", discount: "1000", grand_total: "0" } } });
    expect(decideTransaction(promo, packs, null, new Map(), promos)).toMatchObject({ kind: "purchase", credits: 1000 });
  });

  it("the same rule for a plan period: the database scales the allowance by the paid share", () => {
    const half = JSON.parse(planPaid({ discount_id: DSC, details: { totals: { subtotal: "1900", discount: "950", grand_total: "950" } } })).data;
    expect(decideSubscriptionPayment(half, plans)).toMatchObject({ kind: "subscription_payment", paidShare: 0.5 });
    const free = JSON.parse(planPaid({ discount_id: DSC, details: { totals: { subtotal: "1900", discount: "1900", grand_total: "0" } } })).data;
    expect(decideSubscriptionPayment(free, plans).kind).toBe("reject");
    const promo = JSON.parse(planPaid({ discount_id: PROMO, details: { totals: { subtotal: "1900", discount: "1900" } } })).data;
    expect(decideSubscriptionPayment(promo, plans, promos)).toMatchObject({ kind: "subscription_payment", paidShare: 1 });
    // A renewal at full price.
    expect(decideSubscriptionPayment(JSON.parse(planPaid()).data, plans)).toMatchObject({ paidShare: 1 });
  });

  it("the handler passes the share through and records a fully discounted renewal as rejected", async () => {
    const store = new FakeStore();
    const seen: number[] = [];
    const orig = store.grantSubscriptionCredits.bind(store);
    store.grantSubscriptionCredits = async (g) => {
      seen.push(g.paidShare);
      return orig(g);
    };
    await deliver(store, planPaid({ discount_id: DSC, details: { totals: { subtotal: "1900", discount: "475" } } }, "evt_d1"));
    expect(seen).toEqual([0.75]);
    await deliver(
      store,
      planPaid(
        {
          id: "txn_01h000000000000000000000f0",
          discount_id: DSC,
          billing_period: { starts_at: "2026-11-01T10:00:00Z", ends_at: "2026-12-01T10:00:00Z" },
          details: { totals: { subtotal: "1900", discount: "1900" } },
        },
        "evt_d2",
      ),
    );
    expect(seen).toEqual([0.75]);
    expect(store.events.get("evt_d2")).toMatchObject({ status: "rejected" });
  });

  it("an API top-up is scaled the same way", () => {
    const API_PRODUCT = "pro_01apitopup00000000000000000";
    const topup = (totals: Record<string, string>, discountId: string | null = DSC) => ({
      id: TXN,
      status: "completed",
      currency_code: "USD",
      discount_id: discountId,
      custom_data: { org_id: ORG, purpose: "api_topup" },
      items: [{ price: { product_id: API_PRODUCT, unit_price: { amount: "2000", currency_code: "USD" } }, quantity: 1 }],
      details: { totals },
    });
    expect(decideApiTopup(topup({ subtotal: "2000", discount: "0" }, null), API_PRODUCT)).toMatchObject({ cents: 2000 });
    expect(decideApiTopup(topup({ subtotal: "2000", discount: "1000" }), API_PRODUCT)).toMatchObject({ cents: 1000 });
    expect(decideApiTopup(topup({ subtotal: "2000", discount: "2000" }), API_PRODUCT).kind).toBe("reject");
  });
});
