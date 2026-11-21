import { describe, expect, it } from "vitest";
import {
  PAYME_PACKS,
  PAYME_SPEC,
  StoreError,
  createPaymeRestStore,
  handlePaymeRequest,
  paymeAuthorized,
  paymeExternalId,
  paymeModeFromEnv,
  paymePackTable,
  paymeRefundId,
  type NewPaymeTransaction,
  type PaymeDeps,
  type PaymeOrder,
  type PaymeState,
  type PaymeStore,
  type PaymeTransaction,
} from "../../supabase/functions/_shared/payme";
import { PAYME_CATALOG_PACKS } from "@/lib/payme";

// The Payme Merchant API handler (supabase/functions/_shared/payme.ts). Payme calls US; every answer is HTTP 200 with
// a JSON-RPC body. The store below is an in-memory double that keeps the two properties the real database functions
// promise and these tests lean on: add_purchased_credits is idempotent on the external id (0020), and
// refund_purchased_credits is idempotent on the refund id (0021/0167). The protocol constants come from PAYME_SPEC,
// which is UNCONFIRMED against Payme's official page (see the module header).

const KEY = "sandbox-cashbox-key-0123456789";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORDER = "0123456789abcdef0123456789abcdef";
const ORDER2 = "fedcba9876543210fedcba9876543210";
const NOW = 1_760_000_000_000;
const PACKS = paymePackTable([
  { id: "starter", credits: 1000, uzs: 120_000 },
  { id: "creator", credits: 5000, uzs: 540_000 },
]);
const STARTER_TIYIN = 12_000_000;
const E = PAYME_SPEC.errors;

const auth = (login: string, key: string) => "Basic " + Buffer.from(`${login}:${key}`).toString("base64");
const GOOD_AUTH = auth("Paycom", KEY);

class MemStore implements PaymeStore {
  orders = new Map<string, PaymeOrder>();
  txs = new Map<string, PaymeTransaction>();
  credits = new Map<string, { orgId: string; amount: number }>();
  refunds = new Map<string, { externalId: string; amount: number }>();
  balance = new Map<string, number>();
  addCalls = 0;
  refundCalls = 0;
  failNext: Partial<Record<keyof PaymeStore, StoreError>> = {};
  /** Runs once, inside the next moveTransaction, before it applies — to stage a race. */
  beforeMove: (() => void) | null = null;
  private seq = 100;

  private maybeFail(name: keyof PaymeStore) {
    const e = this.failNext[name];
    if (e) {
      delete this.failNext[name];
      throw e;
    }
  }
  async findOrder(orderId: string) {
    this.maybeFail("findOrder");
    return this.orders.get(orderId) ?? null;
  }
  async findTransaction(paymeId: string) {
    this.maybeFail("findTransaction");
    const t = this.txs.get(paymeId);
    return t ? { ...t } : null;
  }
  async liveTransactionForOrder(orderId: string) {
    for (const t of this.txs.values()) if (t.orderId === orderId && (t.state === 1 || t.state === 2)) return { ...t };
    return null;
  }
  async insertTransaction(tx: NewPaymeTransaction) {
    this.maybeFail("insertTransaction");
    if (this.txs.has(tx.paymeId)) throw new StoreError("dup", "23505");
    if ([...this.txs.values()].some((t) => t.orderId === tx.orderId && (t.state === 1 || t.state === 2))) throw new StoreError("dup", "23505");
    const row = { ...tx, ourId: String(this.seq++) };
    this.txs.set(tx.paymeId, row);
    return { ...row };
  }
  async moveTransaction(paymeId: string, from: PaymeState, to: { state: PaymeState; performTime?: number; cancelTime?: number; reason?: number | null }) {
    this.maybeFail("moveTransaction");
    const hook = this.beforeMove;
    this.beforeMove = null;
    hook?.();
    const t = this.txs.get(paymeId);
    if (!t || t.state !== from) return null;
    Object.assign(t, { state: to.state }, to.performTime !== undefined ? { performTime: to.performTime } : {}, to.cancelTime !== undefined ? { cancelTime: to.cancelTime } : {}, to.reason !== undefined ? { reason: to.reason } : {});
    return { ...t };
  }
  async transactionsBetween(fromMs: number, toMs: number) {
    return [...this.txs.values()].filter((t) => t.paymeTime >= fromMs && t.paymeTime <= toMs).sort((a, b) => a.paymeTime - b.paymeTime);
  }
  async addPurchasedCredits(orgId: string, credits: number, externalId: string) {
    this.addCalls++;
    this.maybeFail("addPurchasedCredits");
    const prior = this.credits.get(externalId);
    if (prior) {
      if (prior.orgId !== orgId || prior.amount !== credits) throw new StoreError("conflict", "23505");
      return { duplicate: true };
    }
    this.credits.set(externalId, { orgId, amount: credits });
    this.balance.set(orgId, (this.balance.get(orgId) ?? 0) + credits);
    return { duplicate: false };
  }
  async refundPurchasedCredits(externalId: string, refundId: string) {
    this.refundCalls++;
    this.maybeFail("refundPurchasedCredits");
    const purchase = this.credits.get(externalId);
    if (!purchase) throw new StoreError("no purchase", "P0002");
    const prior = this.refunds.get(refundId);
    if (prior) return { duplicate: true, requested: prior.amount, taken: prior.amount, shortfall: 0 };
    const bal = this.balance.get(purchase.orgId) ?? 0;
    const taken = Math.min(bal, purchase.amount);
    this.balance.set(purchase.orgId, bal - taken);
    this.refunds.set(refundId, { externalId, amount: purchase.amount });
    return { duplicate: false, requested: purchase.amount, taken, shortfall: purchase.amount - taken };
  }
}

const silent = { info() {}, warn() {}, error() {} };

function setup(over: Partial<PaymeDeps> = {}) {
  const store = new MemStore();
  store.orders.set(ORDER, { orderId: ORDER, orgId: ORG, userId: null, packId: "starter", expiresAt: NOW + 86_400_000 });
  store.orders.set(ORDER2, { orderId: ORDER2, orgId: ORG, userId: null, packId: "starter", expiresAt: NOW + 86_400_000 });
  let now = NOW;
  const deps: PaymeDeps = { key: KEY, mode: "test", testOrgs: new Set([ORG]), packs: PACKS, store, now: () => now, log: silent, ...over };
  const call = async (method: string, params: Record<string, unknown>, authorization: string | null = GOOD_AUTH) =>
    (await handlePaymeRequest({ method: "POST", authorization, rawBody: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) }, deps)).body as {
      id: unknown;
      result?: Record<string, unknown>;
      error?: { code: number; data?: string; message: Record<string, string> };
    };
  return { store, deps, call, advance: (ms: number) => (now += ms) };
}

const account = (order = ORDER) => ({ [PAYME_SPEC.accountField]: order });
const create = (id: string, amount = STARTER_TIYIN, order = ORDER) => ({ id, time: NOW - 1000, amount, account: account(order) });

describe("Payme catalog", () => {
  it("sells nothing until the owner sets a UZS price (no invented price)", () => {
    expect(PAYME_PACKS.every((p) => p.uzs === null)).toBe(true);
    expect(paymePackTable().size).toBe(0);
  });

  it("the Command Center's copy says exactly what the Edge Function credits and charges", () => {
    expect(PAYME_CATALOG_PACKS.map((p) => ({ ...p }))).toEqual(PAYME_PACKS.map((p) => ({ ...p })));
  });

  it("prices in tiyin (so'm x 100), and drops a pack with no, zero or fractional price", () => {
    const t = paymePackTable([
      { id: "a", credits: 10, uzs: 1500 },
      { id: "b", credits: 10, uzs: 0 },
      { id: "c", credits: 10, uzs: 10.5 },
      { id: "d", credits: 10, uzs: null },
    ]);
    expect([...t.keys()]).toEqual(["a"]);
    expect(t.get("a")?.tiyin).toBe(150_000);
  });

  it("is test mode unless PAYME_MODE says exactly live", () => {
    expect(paymeModeFromEnv(undefined)).toBe("test");
    expect(paymeModeFromEnv("production")).toBe("test");
    expect(paymeModeFromEnv("live")).toBe("live");
  });
});

describe("authorization", () => {
  it("accepts only Basic Paycom:<key>", () => {
    expect(paymeAuthorized(GOOD_AUTH, KEY)).toBe(true);
    expect(paymeAuthorized(auth("Paycom", KEY + "x"), KEY)).toBe(false);
    expect(paymeAuthorized(auth("Paycom", KEY.slice(0, -1)), KEY)).toBe(false);
    expect(paymeAuthorized(auth("Payme", KEY), KEY)).toBe(false);
    expect(paymeAuthorized("Bearer " + KEY, KEY)).toBe(false);
    expect(paymeAuthorized(null, KEY)).toBe(false);
    expect(paymeAuthorized("Basic !!!", KEY)).toBe(false);
  });

  it("refuses a wrong key with -32504, echoes the id, and touches nothing", async () => {
    const { call, store } = setup();
    const res = await call("PerformTransaction", { id: "p1" }, auth("Paycom", "wrong-key-wrong-key"));
    expect(res.error?.code).toBe(E.insufficientPrivilege);
    expect(res.id).toBe(7);
    expect(store.addCalls).toBe(0);
  });

  it("refuses a missing Authorization header with -32504", async () => {
    const { call } = setup();
    expect((await call("CheckPerformTransaction", { amount: STARTER_TIYIN, account: account() }, null)).error?.code).toBe(E.insufficientPrivilege);
  });

  it("refuses every call, even with the right header, while PAYME_MERCHANT_KEY is unset", async () => {
    const { call } = setup({ key: "" });
    expect((await call("CheckPerformTransaction", { amount: STARTER_TIYIN, account: account() }, auth("Paycom", ""))).error?.code).toBe(E.insufficientPrivilege);
  });

  it("never logs the key or the header", async () => {
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    const { call } = setup({ log });
    await call("CheckPerformTransaction", {}, auth("Paycom", "attacker-guess-0000000"));
    await call("CheckPerformTransaction", { amount: STARTER_TIYIN, account: account() });
    const all = lines.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("attacker-guess");
    expect(all).not.toContain(Buffer.from(`Paycom:${KEY}`).toString("base64"));
  });
});

describe("JSON-RPC envelope", () => {
  it("answers a non-POST with -32300", async () => {
    const { deps } = setup();
    const res = await handlePaymeRequest({ method: "GET", authorization: GOOD_AUTH, rawBody: "" }, deps);
    expect(res.status).toBe(200);
    expect((res.body as { error: { code: number } }).error.code).toBe(E.transport);
  });

  it("answers broken JSON with -32700 and a missing method with -32600", async () => {
    const { deps } = setup();
    const broken = await handlePaymeRequest({ method: "POST", authorization: GOOD_AUTH, rawBody: "{nope" }, deps);
    expect((broken.body as { error: { code: number } }).error.code).toBe(E.parse);
    const noMethod = await handlePaymeRequest({ method: "POST", authorization: GOOD_AUTH, rawBody: JSON.stringify({ id: 1, params: {} }) }, deps);
    expect((noMethod.body as { error: { code: number } }).error.code).toBe(E.invalidRequest);
  });

  it("answers an unknown method, ChangePassword included, with -32601 (the key lives in secrets, not in a call)", async () => {
    const { call } = setup();
    expect((await call("ChangePassword", { password: "x" })).error?.code).toBe(E.methodNotFound);
    expect((await call("Nope", {})).error?.code).toBe(E.methodNotFound);
  });

  it("every error carries ru, uz and en messages", async () => {
    const { call } = setup();
    const res = await call("CheckTransaction", { id: "missing" });
    expect(Object.keys(res.error?.message ?? {}).sort()).toEqual(["en", "ru", "uz"]);
  });

  it("a database failure is -32400 (Payme asks again) and records nothing as final", async () => {
    const { call, store } = setup();
    store.failNext.findOrder = new StoreError("down", null);
    expect((await call("CheckPerformTransaction", { amount: STARTER_TIYIN, account: account() })).error?.code).toBe(E.system);
    expect(store.txs.size).toBe(0);
  });
});

describe("CheckPerformTransaction", () => {
  it("allows the catalog amount for an open order", async () => {
    const { call } = setup();
    expect((await call("CheckPerformTransaction", { amount: STARTER_TIYIN, account: account() })).result).toEqual({ allow: true });
  });

  it("refuses a wrong amount with -31001 (a hand-edited checkout link)", async () => {
    const { call } = setup();
    expect((await call("CheckPerformTransaction", { amount: STARTER_TIYIN - 100, account: account() })).error?.code).toBe(E.wrongAmount);
    expect((await call("CheckPerformTransaction", { amount: "12000000", account: account() })).error?.code).toBe(E.wrongAmount);
  });

  it("refuses an unknown, malformed or expired order with -31050 naming the account field", async () => {
    const { call, advance } = setup();
    const unknown = await call("CheckPerformTransaction", { amount: STARTER_TIYIN, account: account("ffffffffffffffffffffffffffffffff") });
    expect(unknown.error).toMatchObject({ code: E.orderNotFound, data: PAYME_SPEC.accountField });
    expect((await call("CheckPerformTransaction", { amount: STARTER_TIYIN, account: account("../x") })).error?.code).toBe(E.orderNotFound);
    advance(86_400_001);
    expect((await call("CheckPerformTransaction", { amount: STARTER_TIYIN, account: account() })).error?.code).toBe(E.orderNotFound);
  });

  it("in test mode refuses an order of a workspace not in PAYME_TEST_ORG_IDS; live accepts it", async () => {
    const t = setup({ testOrgs: new Set([OTHER_ORG]) });
    expect((await t.call("CheckPerformTransaction", { amount: STARTER_TIYIN, account: account() })).error?.code).toBe(E.orderNotFound);
    const l = setup({ mode: "live", testOrgs: new Set() });
    expect((await l.call("CheckPerformTransaction", { amount: STARTER_TIYIN, account: account() })).result).toEqual({ allow: true });
  });

  it("refuses an order whose pack has no UZS price (withdrawn from sale) — never a guessed price", async () => {
    const { call } = setup({ packs: paymePackTable([{ id: "starter", credits: 1000, uzs: null }]) });
    expect((await call("CheckPerformTransaction", { amount: STARTER_TIYIN, account: account() })).error?.code).toBe(E.orderNotFound);
  });

  it("refuses an order already being paid with -31051", async () => {
    const { call } = setup();
    await call("CreateTransaction", create("p1"));
    expect((await call("CheckPerformTransaction", { amount: STARTER_TIYIN, account: account() })).error?.code).toBe(E.orderBusy);
  });
});

describe("CreateTransaction", () => {
  it("creates state 1 and grants nothing", async () => {
    const { call, store } = setup();
    const res = await call("CreateTransaction", create("p1"));
    expect(res.result).toEqual({ create_time: NOW, transaction: "100", state: 1 });
    expect(store.addCalls).toBe(0);
    expect(store.balance.get(ORG) ?? 0).toBe(0);
  });

  it("a duplicate create (same Payme id) returns the same answer and no second row", async () => {
    const { call, store } = setup();
    const a = await call("CreateTransaction", create("p1"));
    const b = await call("CreateTransaction", create("p1"));
    expect(b.result).toEqual(a.result);
    expect(store.txs.size).toBe(1);
  });

  it("a second Payme transaction for the same order is refused with -31051", async () => {
    const { call } = setup();
    await call("CreateTransaction", create("p1"));
    expect((await call("CreateTransaction", create("p2"))).error?.code).toBe(E.orderBusy);
  });

  it("a race on insert (the database's unique index) for another Payme id answers -31051", async () => {
    const { call, store } = setup();
    store.failNext.insertTransaction = new StoreError("dup", "23505");
    expect((await call("CreateTransaction", create("p1"))).error?.code).toBe(E.orderBusy);
  });

  it("refuses the same Payme id re-used with another amount", async () => {
    const { call } = setup();
    await call("CreateTransaction", create("p1"));
    expect((await call("CreateTransaction", create("p1", STARTER_TIYIN + 100))).error?.code).toBe(E.cannotPerform);
  });

  it("a wrong amount is -31001 and creates nothing", async () => {
    const { call, store } = setup();
    expect((await call("CreateTransaction", create("p1", 100))).error?.code).toBe(E.wrongAmount);
    expect(store.txs.size).toBe(0);
  });

  it("after the timeout a repeated create cancels it with reason 4 and answers -31008", async () => {
    const { call, store, advance } = setup();
    await call("CreateTransaction", create("p1"));
    advance(PAYME_SPEC.timeoutMs + 1);
    expect((await call("CreateTransaction", create("p1"))).error?.code).toBe(E.cannotPerform);
    expect(store.txs.get("p1")).toMatchObject({ state: -1, reason: PAYME_SPEC.reasonTimeout });
  });

  it("a cancelled order can be paid again by a new Payme transaction", async () => {
    const { call } = setup();
    await call("CreateTransaction", create("p1"));
    await call("CancelTransaction", { id: "p1", reason: 3 });
    expect((await call("CreateTransaction", create("p2"))).result?.state).toBe(1);
  });

  it("refuses a missing id or time with -32600", async () => {
    const { call } = setup();
    expect((await call("CreateTransaction", { time: NOW, amount: STARTER_TIYIN, account: account() })).error?.code).toBe(E.invalidRequest);
    expect((await call("CreateTransaction", { id: "p1", amount: STARTER_TIYIN, account: account() })).error?.code).toBe(E.invalidRequest);
  });
});

describe("PerformTransaction", () => {
  it("grants the pack's credits through add_purchased_credits with the Payme id as external id", async () => {
    const { call, store, advance } = setup();
    await call("CreateTransaction", create("p1"));
    advance(5000);
    const res = await call("PerformTransaction", { id: "p1" });
    expect(res.result).toEqual({ transaction: "100", perform_time: NOW + 5000, state: 2 });
    expect(store.credits.get(paymeExternalId("p1"))).toEqual({ orgId: ORG, amount: 1000 });
    expect(store.balance.get(ORG)).toBe(1000);
  });

  it("perform twice credits once and answers the same", async () => {
    const { call, store } = setup();
    await call("CreateTransaction", create("p1"));
    const a = await call("PerformTransaction", { id: "p1" });
    const b = await call("PerformTransaction", { id: "p1" });
    expect(b.result).toEqual(a.result);
    expect(store.balance.get(ORG)).toBe(1000);
    expect(store.addCalls).toBe(1);
  });

  it("a retry after the state write failed credits once (the grant is idempotent)", async () => {
    const { call, store } = setup();
    await call("CreateTransaction", create("p1"));
    store.failNext.moveTransaction = new StoreError("down", null);
    expect((await call("PerformTransaction", { id: "p1" })).error?.code).toBe(E.system);
    expect((await call("PerformTransaction", { id: "p1" })).result?.state).toBe(2);
    expect(store.balance.get(ORG)).toBe(1000);
  });

  it("an unknown transaction is -31003", async () => {
    const { call } = setup();
    expect((await call("PerformTransaction", { id: "nope" })).error?.code).toBe(E.transactionNotFound);
  });

  it("a cancelled transaction cannot be performed (-31008) and grants nothing", async () => {
    const { call, store } = setup();
    await call("CreateTransaction", create("p1"));
    await call("CancelTransaction", { id: "p1", reason: 3 });
    expect((await call("PerformTransaction", { id: "p1" })).error?.code).toBe(E.cannotPerform);
    expect(store.addCalls).toBe(0);
  });

  it("after the timeout: cancelled with reason 4, -31008, no credits", async () => {
    const { call, store, advance } = setup();
    await call("CreateTransaction", create("p1"));
    advance(PAYME_SPEC.timeoutMs + 1);
    expect((await call("PerformTransaction", { id: "p1" })).error?.code).toBe(E.cannotPerform);
    expect(store.txs.get("p1")).toMatchObject({ state: -1, reason: 4 });
    expect(store.addCalls).toBe(0);
    // And CheckTransaction then reports the timeout cancel.
    expect((await call("CheckTransaction", { id: "p1" })).result).toMatchObject({ state: -1, reason: 4, perform_time: 0 });
  });

  it("just inside the timeout it still performs", async () => {
    const { call, advance } = setup();
    await call("CreateTransaction", create("p1"));
    advance(PAYME_SPEC.timeoutMs);
    expect((await call("PerformTransaction", { id: "p1" })).result?.state).toBe(2);
  });

  it("a permanent ledger refusal (external id already used) is -31008, not a silent success", async () => {
    const { call, store } = setup();
    await call("CreateTransaction", create("p1"));
    store.failNext.addPurchasedCredits = new StoreError("conflict", "23505");
    expect((await call("PerformTransaction", { id: "p1" })).error?.code).toBe(E.cannotPerform);
    expect(store.txs.get("p1")?.state).toBe(1);
  });

  it("a cancel landing between the grant and the state write: the grant is taken back", async () => {
    const { call, store } = setup();
    await call("CreateTransaction", create("p1"));
    store.beforeMove = () => Object.assign(store.txs.get("p1")!, { state: -1, cancelTime: NOW, reason: 3 });
    expect((await call("PerformTransaction", { id: "p1" })).error?.code).toBe(E.cannotPerform);
    expect(store.balance.get(ORG)).toBe(0);
    expect(store.refunds.has(paymeRefundId("p1"))).toBe(true);
  });
});

describe("CancelTransaction", () => {
  it("cancels a created transaction to -1 with Payme's reason, no refund", async () => {
    const { call, store } = setup();
    await call("CreateTransaction", create("p1"));
    const res = await call("CancelTransaction", { id: "p1", reason: 3 });
    expect(res.result).toEqual({ transaction: "100", cancel_time: NOW, state: -1 });
    expect(store.refundCalls).toBe(0);
  });

  it("cancel after perform refunds through refund_purchased_credits and moves to -2", async () => {
    const { call, store } = setup();
    await call("CreateTransaction", create("p1"));
    await call("PerformTransaction", { id: "p1" });
    const res = await call("CancelTransaction", { id: "p1", reason: 5 });
    expect(res.result?.state).toBe(-2);
    expect(store.balance.get(ORG)).toBe(0);
    expect(store.refunds.get(paymeRefundId("p1"))).toEqual({ externalId: paymeExternalId("p1"), amount: 1000 });
  });

  it("cancel after perform twice refunds once and answers the same", async () => {
    const { call, store } = setup();
    await call("CreateTransaction", create("p1"));
    await call("PerformTransaction", { id: "p1" });
    store.balance.set(ORG, 5000); // other credits on the account must not be taken a second time
    const a = await call("CancelTransaction", { id: "p1", reason: 5 });
    const b = await call("CancelTransaction", { id: "p1", reason: 5 });
    expect(b.result).toEqual(a.result);
    expect(store.balance.get(ORG)).toBe(4000);
    expect(store.refundCalls).toBe(1);
  });

  it("a retry after the state write failed refunds once (the refund is idempotent)", async () => {
    const { call, store } = setup();
    await call("CreateTransaction", create("p1"));
    await call("PerformTransaction", { id: "p1" });
    store.balance.set(ORG, 5000);
    store.failNext.moveTransaction = new StoreError("down", null);
    expect((await call("CancelTransaction", { id: "p1", reason: 5 })).error?.code).toBe(E.system);
    expect((await call("CancelTransaction", { id: "p1", reason: 5 })).result?.state).toBe(-2);
    expect(store.balance.get(ORG)).toBe(4000);
  });

  it("a perform landing during a cancel of a created transaction is then refunded as performed", async () => {
    const { call, store } = setup();
    await call("CreateTransaction", create("p1"));
    store.beforeMove = () => {
      store.credits.set(paymeExternalId("p1"), { orgId: ORG, amount: 1000 });
      store.balance.set(ORG, 1000);
      Object.assign(store.txs.get("p1")!, { state: 2, performTime: NOW });
    };
    const res = await call("CancelTransaction", { id: "p1", reason: 5 });
    expect(res.result?.state).toBe(-2);
    expect(store.balance.get(ORG)).toBe(0);
  });

  it("a permanent refund refusal is -31007 and leaves the transaction performed", async () => {
    const { call, store } = setup();
    await call("CreateTransaction", create("p1"));
    await call("PerformTransaction", { id: "p1" });
    store.failNext.refundPurchasedCredits = new StoreError("no purchase", "P0002");
    expect((await call("CancelTransaction", { id: "p1", reason: 5 })).error?.code).toBe(E.cannotCancel);
    expect(store.txs.get("p1")?.state).toBe(2);
  });

  it("an unknown transaction is -31003; a missing reason is -32600", async () => {
    const { call } = setup();
    expect((await call("CancelTransaction", { id: "nope", reason: 1 })).error?.code).toBe(E.transactionNotFound);
    await call("CreateTransaction", create("p1"));
    expect((await call("CancelTransaction", { id: "p1" })).error?.code).toBe(E.invalidRequest);
  });
});

describe("CheckTransaction and GetStatement", () => {
  it("CheckTransaction reports times (0 when not reached), state and reason", async () => {
    const { call, advance } = setup();
    await call("CreateTransaction", create("p1"));
    expect((await call("CheckTransaction", { id: "p1" })).result).toEqual({ create_time: NOW, perform_time: 0, cancel_time: 0, transaction: "100", state: 1, reason: null });
    advance(10);
    await call("PerformTransaction", { id: "p1" });
    advance(10);
    await call("CancelTransaction", { id: "p1", reason: 5 });
    expect((await call("CheckTransaction", { id: "p1" })).result).toEqual({
      create_time: NOW, perform_time: NOW + 10, cancel_time: NOW + 20, transaction: "100", state: -2, reason: 5,
    });
  });

  it("GetStatement lists transactions by Payme's time within [from, to]", async () => {
    const { call } = setup();
    await call("CreateTransaction", { ...create("p1"), time: 1000 });
    await call("CancelTransaction", { id: "p1", reason: 3 });
    await call("CreateTransaction", { ...create("p2"), time: 2000 });
    const res = await call("GetStatement", { from: 1500, to: 2500 });
    const list = (res.result?.transactions ?? []) as Record<string, unknown>[];
    expect(list.map((t) => t.id)).toEqual(["p2"]);
    expect(list[0]).toMatchObject({ time: 2000, amount: STARTER_TIYIN, account: account(), state: 1, transaction: "101" });
    expect((await call("GetStatement", { from: 3000, to: 1000 })).error?.code).toBe(E.invalidRequest);
  });
});

describe("REST store", () => {
  it("moves a transaction only from the expected state (a conditional PATCH), and never sends the key in an error", async () => {
    const seen: { url: string; method?: string }[] = [];
    const store = createPaymeRestStore({
      url: "https://x.supabase.co/",
      serviceKey: "service-role-secret",
      fetch: async (url, init) => {
        seen.push({ url, method: init?.method });
        return new Response(JSON.stringify({ code: "42P01", message: "relation does not exist" }), { status: 404 });
      },
    });
    const err = await store.moveTransaction("p1", 1, { state: 2, performTime: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(String(err.message)).not.toContain("service-role-secret");
    expect(seen[0].method).toBe("PATCH");
    expect(seen[0].url).toContain("payme_id=eq.p1&state=eq.1");
  });

  it("refunds in full (p_amount null) as a refund, never a chargeback", async () => {
    let body: Record<string, unknown> = {};
    const store = createPaymeRestStore({
      url: "https://x.supabase.co",
      serviceKey: "k",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ duplicate: false, requested: 1000, taken: 1000, shortfall: 0 }), { status: 200 });
      },
    });
    await store.refundPurchasedCredits("payme_p1", "payme_cancel_p1", "n");
    expect(body).toMatchObject({ p_external_id: "payme_p1", p_refund_id: "payme_cancel_p1", p_amount: null, p_reason: "refund" });
  });
});
