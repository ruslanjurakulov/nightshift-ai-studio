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

// A realistic tax-exclusive payment: Paddle adds a flat 500 cents of tax to the
// line price. details.totals is what Paddle computes (see decideApiTopup).
function exclusiveTotals(cents: string, tax = 500): Record<string, string> {
  const n = Number(cents);
  return { subtotal: cents, discount: "0", tax: String(tax), total: String(n + tax), credit: "0", grand_total: String(n + tax) };
}

function txn(overrides: Record<string, unknown> = {}, cents = "2500") {
  return {
    id: TXN,
    status: "completed",
    currency_code: "USD",
    custom_data: { org_id: ORG, user_id: USER, purpose: "api_topup" },
    items: [{ quantity: 1, price: { id: "pri_01nc000000000000000000000", product_id: PRODUCT, unit_price: { amount: cents, currency_code: "USD" } } }],
    details: { totals: exclusiveTotals(cents) },
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
function deliver(store: Store, event: Record<string, unknown>, apiProductId: string | null = PRODUCT, promos?: ReadonlySet<string>) {
  const body = JSON.stringify(event);
  return handlePaddleWebhook(
    { method: "POST", rawBody: body, signature: sign(body) },
    { secret: SECRET, prices, store, now: () => NOW_MS, log: quiet, apiProductId, promos },
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

// Owner policy: there is NO discount on API top-ups. Credit = what was paid
// (the line's price, tax on top), and a discount of any kind, even an
// allowlisted promo, or a zero payment credits nothing.
describe("API top-ups never accept discounts", () => {
  const DSC = "dsc_01h000000000000000000000aa";
  const promos = new Set([DSC]);
  const paidTxn = (extra: Record<string, unknown>, totals: Record<string, string>, cents = "2500") =>
    txn({ ...extra, details: { totals } }, cents);

  it("rejects the reported exploit: allowlisted discount, 500000-cent line, fully discounted", () => {
    const data = paidTxn({ discount_id: DSC }, { subtotal: "500000", discount: "500000", total: "0", grand_total: "0" }, "500000");
    // The allowlist is not even a parameter any more; a stale caller passing one changes nothing.
    const d = (decideApiTopup as (...a: unknown[]) => ReturnType<typeof decideApiTopup>)(data, PRODUCT, promos);
    expect(d.kind).toBe("reject");
    expect(decideTransaction(data, prices, PRODUCT, new Map(), promos).kind).toBe("reject");
  });

  it("rejects a partially discounted top-up, with or without an allowlisted id", () => {
    const totals = { subtotal: "2500", discount: "1250", total: "1250", grand_total: "1250" };
    expect(decideApiTopup(paidTxn({ discount_id: DSC }, totals), PRODUCT).kind).toBe("reject");
    expect(decideApiTopup(paidTxn({}, totals), PRODUCT).kind).toBe("reject");
  });

  it("rejects a discount id even when Paddle reports no discount amount", () => {
    expect(decideApiTopup(paidTxn({ discount_id: DSC }, { subtotal: "2500", discount: "0", grand_total: "2500" }), PRODUCT).kind).toBe("reject");
  });

  it("rejects a discount amount that cannot be read", () => {
    expect(decideApiTopup(paidTxn({}, { subtotal: "2500", discount: "n/a", grand_total: "2500" }), PRODUCT).kind).toBe("reject");
  });

  it("rejects a zero total, and a total that cannot be read", () => {
    expect(decideApiTopup(paidTxn({}, { subtotal: "2500", discount: "0", grand_total: "0" }), PRODUCT).kind).toBe("reject");
    expect(decideApiTopup(paidTxn({}, { subtotal: "2500", discount: "0" }), PRODUCT).kind).toBe("reject");
  });

  it("still credits exactly the paid line for an undiscounted top-up; tax stays on top", () => {
    const d = decideApiTopup(paidTxn({ discount_id: null }, { subtotal: "2500", discount: "0", tax: "500", total: "3000", grand_total: "3000" }), PRODUCT);
    expect(d).toMatchObject({ kind: "api_topup", cents: 2500, amountMinor: 3000 });
    expect(decideApiTopup(paidTxn({}, { subtotal: "2500", discount: "0", tax: "0", total: "2500", grand_total: "2500" }), PRODUCT)).toMatchObject({ kind: "api_topup", cents: 2500 });
  });

  it("through the handler: a fully discounted top-up is recorded rejected and credits nothing", async () => {
    const store = new Store();
    const data = paidTxn({ discount_id: DSC }, { subtotal: "500000", discount: "500000", grand_total: "0" }, "500000");
    const res = await deliver(store, { event_id: "evt_01exploit", event_type: "transaction.completed", data }, PRODUCT, promos);
    expect(res.status).toBe(200);
    expect(store.api.size).toBe(0);
    expect(store.credits).toEqual([]);
    expect(store.events.get("evt_01exploit")).toMatchObject({ status: "rejected" });
  });
});

// What the webhook checks against Paddle's own totals before crediting cents.
// Paddle docs: total = subtotal - discount + tax; grand_total = total - credit;
// a tax-inclusive price keeps total = price and backs the tax out of subtotal.
describe("API top-ups: totals must agree with the line price", () => {
  const DSC = "dsc_01h000000000000000000000aa";
  const paid = (totals: Record<string, string>, extra: Record<string, unknown> = {}, cents = "2500") =>
    txn({ ...extra, details: { totals } }, cents);
  const rejected = (d: ReturnType<typeof decideApiTopup>, re?: RegExp) => {
    expect(d.kind).toBe("reject");
    if (re && d.kind === "reject") expect(d.detail).toMatch(re);
    if (d.kind === "reject") expect(d.detail).toMatch(/not credited$/);
  };

  describe("legitimate payments are credited", () => {
    it("plain USD $10 top-up, no tax", () => {
      expect(decideApiTopup(paid({ subtotal: "1000", discount: "0", tax: "0", total: "1000", credit: "0", grand_total: "1000" }, {}, "1000"), PRODUCT)).toMatchObject({ kind: "api_topup", cents: 1000, amountMinor: 1000 });
    });

    it("tax-exclusive: tax on top of the price, credit is the price", () => {
      expect(decideApiTopup(paid({ subtotal: "1000", discount: "0", tax: "200", total: "1200", credit: "0", grand_total: "1200" }, {}, "1000"), PRODUCT)).toMatchObject({ kind: "api_topup", cents: 1000, amountMinor: 1200 });
    });

    it("tax-inclusive: Paddle backs the tax out of the subtotal, the price is what was paid", () => {
      // $10.00 price, 10% VAT inside it: subtotal 909, tax 91, total 1000.
      expect(decideApiTopup(paid({ subtotal: "909", discount: "0", tax: "91", total: "1000", credit: "0", grand_total: "1000" }, {}, "1000"), PRODUCT)).toMatchObject({ kind: "api_topup", cents: 1000, amountMinor: 1000 });
    });

    it("tax-inclusive with a one-cent rounding drift in the tax split is still credited", () => {
      // $18.99 at 21% VAT: Paddle splits 1569 + 331 = 1900, one cent off the 1899 total.
      const d = decideApiTopup(paid({ subtotal: "1569", discount: "0", tax: "331", total: "1899", credit: "0", grand_total: "1899" }, {}, "1899"), PRODUCT);
      expect(d).toMatchObject({ kind: "api_topup", cents: 1899, amountMinor: 1899 });
    });

    it("a drift never helps an exclusive price: its identity must hold exactly", () => {
      rejected(decideApiTopup(paid({ subtotal: "1899", discount: "0", tax: "331", total: "2229", grand_total: "2229" }, {}, "1899"), PRODUCT), /inconsistent/);
    });

    it("quantity > 1: the summed lines match the subtotal", () => {
      const data = txn({
        items: [{ quantity: 3, price: { product_id: PRODUCT, unit_price: { amount: "1000", currency_code: "USD" } } }],
        details: { totals: { subtotal: "3000", discount: "0", tax: "300", total: "3300", credit: "0", grand_total: "3300" } },
      });
      expect(decideApiTopup(data, PRODUCT)).toMatchObject({ kind: "api_topup", cents: 3000, amountMinor: 3300 });
    });

    it("totals.credit and credit_to_balance may be absent, null or \"0\"", () => {
      const base = { subtotal: "2500", discount: "0", tax: "0", total: "2500", grand_total: "2500" };
      expect(decideApiTopup(paid(base), PRODUCT).kind).toBe("api_topup");
      expect(decideApiTopup(paid({ ...base, credit: "0", credit_to_balance: "0" }), PRODUCT).kind).toBe("api_topup");
      expect(decideApiTopup(txn({ details: { totals: { ...base, credit: null } } }), PRODUCT).kind).toBe("api_topup");
    });

    it("totals.currency_code USD is accepted", () => {
      expect(decideApiTopup(paid({ ...exclusiveTotals("2500"), currency_code: "USD" }), PRODUCT).kind).toBe("api_topup");
    });
  });

  describe("everything that could credit more than was paid is rejected", () => {
    it("a transaction currency other than USD, even when the line says USD", () => {
      rejected(decideApiTopup(paid(exclusiveTotals("2500"), { currency_code: "EUR" }), PRODUCT), /not USD/);
      rejected(decideApiTopup(paid(exclusiveTotals("2500"), { currency_code: undefined }), PRODUCT), /not USD/);
    });

    it("totals in another currency", () => {
      rejected(decideApiTopup(paid({ ...exclusiveTotals("2500"), currency_code: "JPY" }), PRODUCT), /totals are not in USD/);
    });

    it("customer credit applied (totals.credit), whether or not grand_total was reduced", () => {
      // 25.00 line, 5.00 tax, 10.00 paid from the credit balance: 20.00 due.
      rejected(decideApiTopup(paid({ subtotal: "2500", discount: "0", tax: "500", total: "3000", credit: "1000", grand_total: "2000" }), PRODUCT), /credit/);
      rejected(decideApiTopup(paid({ ...exclusiveTotals("2500"), credit: "1000" }), PRODUCT), /credit/);
      rejected(decideApiTopup(paid({ ...exclusiveTotals("2500"), credit: "n/a" }), PRODUCT), /credit/);
      rejected(decideApiTopup(paid({ ...exclusiveTotals("2500"), credit_to_balance: "500" }), PRODUCT), /credit/);
    });

    it("a grand total below the total (credit hidden or not reported)", () => {
      rejected(decideApiTopup(paid({ subtotal: "2500", discount: "0", tax: "500", total: "3000", grand_total: "2000" }), PRODUCT), /grand total differs/);
    });

    it("a grand total below the credited cents", () => {
      rejected(decideApiTopup(paid({ subtotal: "2500", discount: "0", tax: "0", total: "2500", grand_total: "100" }), PRODUCT));
      rejected(decideApiTopup(paid({ subtotal: "100", discount: "0", tax: "0", total: "100", grand_total: "100" }), PRODUCT), /do not match its line price/);
    });

    it("a subtotal that is not the line price (price override / smaller charge)", () => {
      rejected(decideApiTopup(paid({ subtotal: "1000", discount: "0", tax: "0", total: "1000", grand_total: "1000" }), PRODUCT), /do not match its line price/);
      // quantity 3 x $10 billed as one $10 line
      const data = txn({
        items: [{ quantity: 3, price: { product_id: PRODUCT, unit_price: { amount: "1000", currency_code: "USD" } } }],
        details: { totals: { subtotal: "1000", discount: "0", tax: "0", total: "1000", grand_total: "1000" } },
      });
      rejected(decideApiTopup(data, PRODUCT));
    });

    it("totals that do not add up (total != subtotal + tax)", () => {
      rejected(decideApiTopup(paid({ subtotal: "2500", discount: "0", tax: "500", total: "2900", grand_total: "2900" }), PRODUCT), /inconsistent/);
    });

    it.each(["subtotal", "tax", "total"])("a missing or unreadable %s", (field) => {
      const t: Record<string, string> = exclusiveTotals("2500");
      delete t[field];
      rejected(decideApiTopup(paid(t), PRODUCT), /cannot be read/);
      rejected(decideApiTopup(paid({ ...t, [field]: "-5" }), PRODUCT), /cannot be read/);
      rejected(decideApiTopup(paid({ ...t, [field]: "12.5" }), PRODUCT), /cannot be read/);
    });

    it("keeps the earlier rules: a discount of any kind, however consistent the totals look", () => {
      rejected(decideApiTopup(paid({ subtotal: "2500", discount: "1250", tax: "0", total: "1250", grand_total: "1250" }, { discount_id: DSC }), PRODUCT));
    });
  });

  it("through the handler: a credit-balance payment is recorded rejected and credits nothing", async () => {
    const store = new Store();
    const data = paid({ subtotal: "2500", discount: "0", tax: "500", total: "3000", credit: "3000", grand_total: "0" });
    const res = await deliver(store, { event_id: "evt_01credit", event_type: "transaction.completed", data });
    expect(res.status).toBe(200);
    expect(store.api.size).toBe(0);
    expect(store.events.get("evt_01credit")).toMatchObject({ status: "rejected", transactionId: TXN });
  });

  it("through the handler: a tax-inclusive top-up is credited once at the price", async () => {
    const store = new Store();
    const data = paid({ subtotal: "909", discount: "0", tax: "91", total: "1000", credit: "0", grand_total: "1000" }, {}, "1000");
    expect((await deliver(store, { event_id: "evt_01incl", event_type: "transaction.completed", data })).status).toBe(200);
    expect([...store.api.values()]).toEqual([{ org: ORG, cents: 1000 }]);
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
