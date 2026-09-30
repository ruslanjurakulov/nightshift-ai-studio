import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decideApiTopup,
  decideTransaction,
  handlePaddleWebhook,
  priceTableFromEnv,
  type EventRecord,
  type EventStatus,
  type PaddleStore,
  type PurchaseRecord,
} from "../../supabase/functions/_shared/paddle";
import { topupTransactionBody } from "@/lib/api/pricing";

// Migration 0031: an API balance top-up is a Paddle transaction the Command
// Center created for a custom amount. The webhook must credit the API balance
// (cents), never site credits, and only for what Paddle charged.

const SECRET = "pdl_ntfset_test_secret";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "pro_01apitopup00000000000000";
const TXN = "txn_01h000000000000000000000cc";
const ADJ = "adj_01h000000000000000000000dd";
const NOW_MS = 1_760_000_000_000;
const prices = priceTableFromEnv(() => undefined);

function sign(body: string) {
  const ts = NOW_MS / 1000;
  return `ts=${ts};h1=${createHmac("sha256", SECRET).update(`${ts}:${body}`).digest("hex")}`;
}

function txn(overrides: Record<string, unknown> = {}, cents = "2500") {
  return {
    id: TXN,
    status: "completed",
    currency_code: "USD",
    custom_data: { org_id: ORG, user_id: USER, purpose: "api_topup" },
    items: [{ quantity: 1, price: { id: "pri_01nc000000000000000000000", product_id: PRODUCT, unit_price: { amount: cents, currency_code: "USD" } } }],
    details: { totals: { grand_total: "3000" } },
    ...overrides,
  };
}

class Store implements PaddleStore {
  events = new Map<string, EventRecord>();
  credits: string[] = [];
  api = new Map<string, { org: string; cents: number }>();
  apiRefunds = new Map<string, number | null>();
  async eventStatus(id: string) {
    return this.events.get(id)?.status ?? null;
  }
  async recordEvent(r: EventRecord) {
    const cur = this.events.get(r.eventId);
    if (!cur || cur.status === "failed") this.events.set(r.eventId, r);
  }
  async orgExists(id: string) {
    return id === ORG;
  }
  async addPurchasedCredits(_o: string, _c: number, ext: string) {
    this.credits.push(ext);
    return { duplicate: false };
  }
  async findPurchase(t: string): Promise<PurchaseRecord | null> {
    const r = [...this.events.values()].find((e) => e.transactionId === t && e.eventType === "transaction.completed");
    return r ? { status: r.status as EventStatus, orgId: r.orgId ?? null, credits: r.credits ?? null, currency: r.currency ?? null, amountMinor: r.amountMinor ?? null } : null;
  }
  async refundPurchasedCredits(): Promise<{ duplicate: boolean; requested: number; taken: number; shortfall: number }> {
    throw new Error("an API top-up must never be refunded from credits");
  }
  async addApiTopup(org: string, cents: number, ext: string) {
    if (this.api.has(ext)) return { duplicate: true };
    this.api.set(ext, { org, cents });
    return { duplicate: false };
  }
  async findApiTopup(t: string) {
    const r = this.api.get(t);
    return r ? { orgId: r.org, cents: r.cents } : null;
  }
  async refundApiTopup(_ext: string, id: string, cents: number | null) {
    this.apiRefunds.set(id, cents);
    return { duplicate: false, requested: cents ?? 2500, taken: cents ?? 2500, shortfall: 0 };
  }
}

const quiet = { info() {}, warn() {}, error() {} };
function deliver(store: Store, event: Record<string, unknown>, apiProductId: string | null = PRODUCT) {
  const body = JSON.stringify(event);
  return handlePaddleWebhook(
    { method: "POST", rawBody: body, signature: sign(body) },
    { secret: SECRET, prices, store, now: () => NOW_MS, log: quiet, apiProductId },
  );
}

describe("API top-up decisions", () => {
  it("credits the line's unit price in cents, not the tax-inclusive total", () => {
    expect(decideApiTopup(txn(), PRODUCT)).toMatchObject({ kind: "api_topup", orgId: ORG, cents: 2500, transactionId: TXN });
  });

  it("is chosen by custom_data.purpose, before the credit-pack price table", () => {
    expect(decideTransaction(txn(), prices, PRODUCT).kind).toBe("api_topup");
  });

  it.each([
    ["another product", txn({ items: [{ quantity: 1, price: { product_id: "pro_01other00000000000000000", unit_price: { amount: "2500", currency_code: "USD" } } }] })],
    ["not USD", txn({ items: [{ quantity: 1, price: { product_id: PRODUCT, unit_price: { amount: "2500", currency_code: "EUR" } } }] })],
    ["below $5", txn({}, "499")],
    ["above $5,000", txn({}, "500001")],
    ["no organization", txn({ custom_data: { purpose: "api_topup" } })],
  ])("rejects a top-up with %s", (_why, data) => {
    expect(decideApiTopup(data, PRODUCT).kind).toBe("reject");
  });

  it("rejects when the webhook does not know the top-up product", () => {
    expect(decideApiTopup(txn(), null).kind).toBe("reject");
  });

  it("the transaction the app creates is exactly what the webhook accepts", () => {
    const body = topupTransactionBody({ orgId: ORG, userId: USER, cents: 2500, productId: PRODUCT }) as {
      items: { quantity: number; price: Record<string, unknown> }[];
      custom_data: Record<string, unknown>;
      currency_code: string;
    };
    expect(body.custom_data).toEqual({ org_id: ORG, user_id: USER, purpose: "api_topup" });
    expect(body.currency_code).toBe("USD");
    const echoed = txn({ items: body.items, custom_data: body.custom_data });
    expect(decideApiTopup(echoed, PRODUCT)).toMatchObject({ kind: "api_topup", cents: 2500 });
  });
});

describe("API top-ups through the handler", () => {
  const event = (data: Record<string, unknown>, id = "evt_01topup") => ({
    event_id: id,
    event_type: "transaction.completed",
    occurred_at: "2026-09-27T10:00:00Z",
    data,
  });

  it("credits the API balance once and never site credits", async () => {
    const store = new Store();
    expect((await deliver(store, event(txn()))).status).toBe(200);
    await deliver(store, event(txn(), "evt_01again"));
    expect([...store.api.values()]).toEqual([{ org: ORG, cents: 2500 }]);
    expect(store.credits).toEqual([]);
  });

  it("refunds a partial refund of a top-up from the API balance, in proportion, in cents", async () => {
    const store = new Store();
    await deliver(store, event(txn()));
    const res = await deliver(store, {
      event_id: "evt_01refund",
      event_type: "adjustment.updated",
      data: {
        id: ADJ,
        action: "refund",
        status: "approved",
        type: "partial",
        transaction_id: TXN,
        currency_code: "USD",
        totals: { total: "1500", currency_code: "USD" },
      },
    });
    expect(res.status).toBe(200);
    // 1500 of 3000 paid (tax included) = half of 2500 cents.
    expect(store.apiRefunds.get(ADJ)).toBe(1250);
  });
});
