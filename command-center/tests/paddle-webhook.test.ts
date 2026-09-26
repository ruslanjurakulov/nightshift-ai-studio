import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CREDIT_PACKS as WEBHOOK_PACKS,
  StoreError,
  createRestStore,
  decideAdjustment,
  decideTransaction,
  handlePaddleWebhook,
  parseSignatureHeader,
  priceTableFromEnv,
  refundCredits,
  verifyPaddleSignature,
  type EventRecord,
  type EventStatus,
  type PaddleStore,
  type PurchaseRecord,
} from "../../supabase/functions/_shared/paddle";
import { CREDIT_PACKS as APP_PACKS } from "@/lib/paddle";

// The Edge Function's logic (supabase/functions/_shared/paddle.ts) is
// runtime-neutral, so it is tested here with the Command Center's tooling.

const SECRET = "pdl_ntfset_test_secret";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const PRICE_STARTER = "pri_01starter0000000000000000";
const PRICE_STUDIO = "pri_01studio00000000000000000";
const TXN = "txn_01h000000000000000000000aa";
const ADJ = "adj_01h000000000000000000000bb";
const NOW_MS = 1_760_000_000_000;
const NOW_S = NOW_MS / 1000;

const prices = priceTableFromEnv(
  (name) => ({ PADDLE_PRICE_STARTER: PRICE_STARTER, PADDLE_PRICE_STUDIO: PRICE_STUDIO })[name],
);

function sign(body: string, ts = NOW_S, secret = SECRET): string {
  const h1 = createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
  return `ts=${ts};h1=${h1}`;
}

function completed(overrides: Record<string, unknown> = {}, eventId = "evt_01purchase") {
  return JSON.stringify({
    event_id: eventId,
    event_type: "transaction.completed",
    occurred_at: "2026-09-26T10:00:00Z",
    notification_id: "ntf_01x",
    data: {
      id: TXN,
      status: "completed",
      currency_code: "USD",
      custom_data: { org_id: ORG, user_id: USER },
      items: [{ price: { id: PRICE_STARTER }, quantity: 1 }],
      details: { totals: { grand_total: "1000" } },
      ...overrides,
    },
  });
}

function adjustment(data: Record<string, unknown> = {}, eventId = "evt_01refund", type = "adjustment.updated") {
  return JSON.stringify({
    event_id: eventId,
    event_type: type,
    occurred_at: "2026-09-27T10:00:00Z",
    data: {
      id: ADJ,
      action: "refund",
      status: "approved",
      type: "partial",
      transaction_id: TXN,
      currency_code: "USD",
      totals: { total: "250", currency_code: "USD" },
      ...data,
    },
  });
}

/** An in-memory stand-in for the database, with 0020/0021's idempotency. */
class FakeStore implements PaddleStore {
  events = new Map<string, EventRecord>();
  orgs = new Set([ORG]);
  credited = new Map<string, { org: string; credits: number }>();
  refunds = new Map<string, { amount: number | null; reason: string }>();
  failNext: StoreError | Error | null = null;

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
    if (this.credited.has(ext)) return { duplicate: true };
    this.credited.set(ext, { org, credits });
    return { duplicate: false };
  }
  async findPurchase(txn: string): Promise<PurchaseRecord | null> {
    const rows = [...this.events.values()].filter(
      (e) => e.transactionId === txn && e.eventType === "transaction.completed",
    );
    const r = rows.find((e) => e.status === "processed" || e.status === "duplicate") ?? rows[0];
    return r
      ? {
          status: r.status as EventStatus,
          orgId: r.orgId ?? null,
          credits: r.credits ?? null,
          currency: r.currency ?? null,
          amountMinor: r.amountMinor ?? null,
        }
      : null;
  }
  async refundPurchasedCredits(ext: string, id: string, amount: number | null, _note: string, reason: string) {
    this.maybeFail();
    if (this.refunds.has(id)) return { duplicate: true, requested: 0, taken: 0, shortfall: 0 };
    this.refunds.set(id, { amount, reason });
    const requested = amount ?? this.credited.get(ext)?.credits ?? 0;
    return { duplicate: false, requested, taken: requested, shortfall: 0 };
  }
}

const quiet = { info() {}, warn() {}, error() {} };

function deliver(store: FakeStore, body: string, signature: string | null = sign(body), method = "POST") {
  return handlePaddleWebhook(
    { method, rawBody: body, signature },
    { secret: SECRET, prices, store, now: () => NOW_MS, log: quiet },
  );
}

describe("Paddle signature", () => {
  it("accepts the HMAC of ts:rawBody with the destination secret", async () => {
    const body = completed();
    expect(await verifyPaddleSignature(body, sign(body), SECRET, NOW_S)).toBe("ok");
  });

  it("refuses a body changed by one byte (e.g. a re-serialised JSON)", async () => {
    const body = completed();
    expect(await verifyPaddleSignature(body + " ", sign(body), SECRET, NOW_S)).toBe("mismatch");
  });

  it("refuses a signature made with another secret", async () => {
    const body = completed();
    expect(await verifyPaddleSignature(body, sign(body, NOW_S, "other"), SECRET, NOW_S)).toBe("mismatch");
  });

  it("refuses a replay older than five minutes, and one from the future", async () => {
    const body = completed();
    expect(await verifyPaddleSignature(body, sign(body, NOW_S - 301), SECRET, NOW_S)).toBe("stale");
    expect(await verifyPaddleSignature(body, sign(body, NOW_S + 301), SECRET, NOW_S)).toBe("stale");
    expect(await verifyPaddleSignature(body, sign(body, NOW_S - 299), SECRET, NOW_S)).toBe("ok");
  });

  it("accepts any h1 while a secret is being rotated", async () => {
    const body = completed();
    const good = sign(body).split(";h1=")[1];
    const header = `ts=${NOW_S};h1=${"0".repeat(64)};h1=${good}`;
    expect(await verifyPaddleSignature(body, header, SECRET, NOW_S)).toBe("ok");
  });

  it("says missing / malformed rather than guessing", async () => {
    expect(await verifyPaddleSignature("{}", null, SECRET, NOW_S)).toBe("missing");
    expect(await verifyPaddleSignature("{}", "h1=abc", SECRET, NOW_S)).toBe("malformed");
    expect(parseSignatureHeader(`ts=1;h1=${"a".repeat(63)}`)).toBeNull();
    expect(parseSignatureHeader(`ts=12;h1=${"A".repeat(64)}`)).toEqual({ ts: 12, h1: ["a".repeat(64)] });
  });
});

describe("credit packs", () => {
  it("the Command Center sells exactly the packs the webhook credits", () => {
    expect(APP_PACKS.map((p) => [p.id, p.credits])).toEqual(WEBHOOK_PACKS.map((p) => [p.id, p.credits]));
  });

  it("a pack whose price id is unset or malformed is simply not for sale", () => {
    const t = priceTableFromEnv((n) => ({ PADDLE_PRICE_STARTER: "not-a-price", PADDLE_PRICE_CREATOR: " " })[n]);
    expect(t.size).toBe(0);
  });
});

describe("transaction.completed", () => {
  const data = (o: Record<string, unknown> = {}) => JSON.parse(completed(o)).data;

  it("credits the pack's amount, not anything the client sent", () => {
    const d = decideTransaction(data({ custom_data: { org_id: ORG, user_id: USER, credits: 999999 } }), prices);
    expect(d).toMatchObject({ kind: "purchase", orgId: ORG, credits: 1000, transactionId: TXN, amountMinor: 1000 });
  });

  it("multiplies by quantity and adds lines", () => {
    const d = decideTransaction(
      data({
        items: [
          { price: { id: PRICE_STARTER }, quantity: 2 },
          { price: { id: PRICE_STUDIO }, quantity: 1 },
        ],
      }),
      prices,
    );
    expect(d).toMatchObject({ kind: "purchase", credits: 22000 });
  });

  it("rejects a price that is not one of our packs — the whole transaction", () => {
    const d = decideTransaction(
      data({ items: [{ price: { id: PRICE_STARTER }, quantity: 1 }, { price: { id: "pri_01someoneelse000000000000" }, quantity: 1 }] }),
      prices,
    );
    expect(d.kind).toBe("reject");
  });

  it("rejects a paid transaction with no organization instead of crediting nobody silently", () => {
    expect(decideTransaction(data({ custom_data: {} }), prices).kind).toBe("reject");
    expect(decideTransaction(data({ custom_data: { org_id: "'; drop table x" } }), prices).kind).toBe("reject");
  });

  it("ignores a transaction that is not completed", () => {
    expect(decideTransaction(data({ status: "paid" }), prices).kind).toBe("ignore");
  });
});

describe("adjustments", () => {
  const data = (o: Record<string, unknown> = {}) => JSON.parse(adjustment(o)).data;

  it("only an approved refund or chargeback takes credits back", () => {
    expect(decideAdjustment(data()).kind).toBe("refund");
    expect(decideAdjustment(data({ action: "chargeback" }))).toMatchObject({ kind: "refund", reason: "chargeback" });
    expect(decideAdjustment(data({ status: "pending_approval" })).kind).toBe("ignore");
    expect(decideAdjustment(data({ status: "rejected" })).kind).toBe("ignore");
    expect(decideAdjustment(data({ action: "chargeback_warning" })).kind).toBe("ignore");
    expect(decideAdjustment(data({ action: "credit" })).kind).toBe("ignore");
  });

  it("a partial refund takes back credits in proportion to the money returned", () => {
    const purchase = { credits: 1000, currency: "USD", amountMinor: 1000 };
    expect(refundCredits({ full: false, currency: "USD", amountMinor: 250 }, purchase)).toEqual({ amount: 250, unsized: false });
    expect(refundCredits({ full: false, currency: "USD", amountMinor: 333 }, { ...purchase, amountMinor: 999 })).toEqual({
      amount: 333.33,
      unsized: false,
    });
  });

  it("a full refund, or one at least the price, takes back everything not yet refunded", () => {
    const purchase = { credits: 1000, currency: "USD", amountMinor: 1000 };
    expect(refundCredits({ full: true, currency: null, amountMinor: null }, purchase).amount).toBeNull();
    expect(refundCredits({ full: false, currency: "USD", amountMinor: 1000 }, purchase)).toEqual({ amount: null, unsized: false });
  });

  it("does not guess a partial refund in another currency or without totals", () => {
    const purchase = { credits: 1000, currency: "USD", amountMinor: 1000 };
    expect(refundCredits({ full: false, currency: "EUR", amountMinor: 250 }, purchase).unsized).toBe(true);
    expect(refundCredits({ full: false, currency: "USD", amountMinor: null }, purchase).unsized).toBe(true);
  });
});

describe("handlePaddleWebhook", () => {
  it("refuses an unsigned or forged delivery and touches nothing", async () => {
    const store = new FakeStore();
    const body = completed();
    expect((await deliver(store, body, null)).status).toBe(401);
    expect((await deliver(store, body, sign(body, NOW_S, "guess"))).status).toBe(401);
    expect(store.credited.size).toBe(0);
    expect(store.events.size).toBe(0);
  });

  it("refuses everything when the secret is not configured", async () => {
    const body = completed();
    const res = await handlePaddleWebhook(
      { method: "POST", rawBody: body, signature: sign(body) },
      { secret: "", prices, store: new FakeStore(), now: () => NOW_MS, log: quiet },
    );
    expect(res.status).toBe(500);
  });

  it("credits a purchase once, however many times it is delivered", async () => {
    const store = new FakeStore();
    const first = await deliver(store, completed());
    expect(first).toEqual({ status: 200, body: { ok: true, status: "processed" } });
    const again = await deliver(store, completed());
    expect(again.body).toMatchObject({ duplicate: true });
    // The same transaction under a new event id is still credited once (0020's external_id).
    const other = await deliver(store, completed({}, "evt_01other"));
    expect(other.body).toMatchObject({ status: "duplicate" });
    expect([...store.credited.values()]).toEqual([{ org: ORG, credits: 1000 }]);
    expect(store.events.get("evt_01purchase")).toMatchObject({ status: "processed", credits: 1000, amountMinor: 1000, currency: "USD" });
  });

  it("records a purchase for an unknown organization as rejected, answers 200, credits nothing", async () => {
    const store = new FakeStore();
    store.orgs.clear();
    const res = await deliver(store, completed());
    expect(res.status).toBe(200);
    expect(store.events.get("evt_01purchase")?.status).toBe("rejected");
    expect(store.credited.size).toBe(0);
  });

  it("answers 500 on a transient database failure, so Paddle retries, and the retry credits", async () => {
    const store = new FakeStore();
    store.failNext = new StoreError("add_purchased_credits: HTTP 503", null);
    expect((await deliver(store, completed())).status).toBe(500);
    expect(store.events.get("evt_01purchase")?.status).toBe("failed");
    expect((await deliver(store, completed())).status).toBe(200);
    expect(store.events.get("evt_01purchase")?.status).toBe("processed");
    expect(store.credited.size).toBe(1);
  });

  it("a permanent database refusal is recorded as rejected, not retried forever", async () => {
    const store = new FakeStore();
    store.failNext = new StoreError("add_purchased_credits: HTTP 409 23505", "23505");
    const res = await deliver(store, completed());
    expect(res.status).toBe(200);
    expect(store.events.get("evt_01purchase")?.status).toBe("rejected");
  });

  it("refunds in proportion, once", async () => {
    const store = new FakeStore();
    await deliver(store, completed());
    expect((await deliver(store, adjustment())).status).toBe(200);
    expect(store.refunds.get(ADJ)).toEqual({ amount: 250, reason: "refund" });
    // adjustment.updated re-sent, and a later update of the same adjustment:
    await deliver(store, adjustment());
    await deliver(store, adjustment({}, "evt_01refund2"));
    expect(store.refunds.size).toBe(1);
  });

  it("a refund that arrives before its purchase asks Paddle to retry", async () => {
    const store = new FakeStore();
    const res = await deliver(store, adjustment());
    expect(res.status).toBe(503);
    expect(store.refunds.size).toBe(0);
    await deliver(store, completed());
    expect((await deliver(store, adjustment())).status).toBe(200);
    expect(store.refunds.size).toBe(1);
  });

  it("a refund of a purchase that was never credited moves nothing", async () => {
    const store = new FakeStore();
    store.orgs.clear();
    await deliver(store, completed());
    const res = await deliver(store, adjustment());
    expect(res.status).toBe(200);
    expect(store.events.get("evt_01refund")?.status).toBe("ignored");
    expect(store.refunds.size).toBe(0);
  });

  it("ignores events it does not handle with 200", async () => {
    const store = new FakeStore();
    const body = JSON.stringify({ event_id: "evt_01sub", event_type: "subscription.created", data: {} });
    const res = await deliver(store, body);
    expect(res.status).toBe(200);
    expect(store.events.get("evt_01sub")?.status).toBe("ignored");
  });

  it("rejects a non-POST and a non-event body", async () => {
    const store = new FakeStore();
    expect((await deliver(store, completed(), sign(completed()), "GET")).status).toBe(405);
    expect((await deliver(store, "not json")).status).toBe(400);
  });
});

describe("createRestStore", () => {
  it("calls the service-role RPCs and never puts the key in an error", async () => {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const key = "service-key-never-logged";
    const store = createRestStore({
      url: "https://proj.supabase.co/",
      serviceKey: key,
      fetch: async (url, init) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers as Record<string, string> });
        if (url.endsWith("/rpc/add_purchased_credits")) return new Response(JSON.stringify({ duplicate: false }), { status: 200 });
        return new Response(JSON.stringify({ code: "42501", message: "denied", hint: key }), { status: 403 });
      },
    });
    expect(await store.addPurchasedCredits(ORG, 1000, TXN, "note")).toEqual({ duplicate: false });
    expect(calls[0].url).toBe("https://proj.supabase.co/rest/v1/rpc/add_purchased_credits");
    expect(calls[0].body).toEqual({ p_org: ORG, p_amount: 1000, p_external_id: TXN, p_note: "note" });
    expect(calls[0].headers.apikey).toBe(key);

    const err = await store.orgExists(ORG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe("42501");
    expect((err as StoreError).message).not.toContain(key);
  });
});
