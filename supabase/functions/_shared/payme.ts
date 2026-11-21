/**
 * Payme Business Merchant API — the pure half: the UZS catalog, Basic-auth
 * verification, the transaction state machine, and what each method means for
 * an organization's credits. A third payment path next to Paddle and Dodo, for
 * Uzcard/Humo top-ups (packs only; no subscriptions).
 *
 * Runtime-neutral like ./dodo.ts: only Web Crypto, fetch and JSON, so the
 * Supabase Edge Function (supabase/functions/payme-merchant/index.ts) runs it
 * as-is and the Command Center's vitest suite tests it directly
 * (command-center/tests/payme-merchant.test.ts).
 *
 * *** THE PROTOCOL FACTS BELOW ARE UNCONFIRMED. *** Payme's developer site
 * (developer.help.paycom.uz) could not be read when this was written: the
 * session that wrote it had no network permission, and an earlier research
 * pass reported an expired certificate on that site. Every code, state, field
 * name and timeout here is from memory of the published Merchant API, collected
 * in PAYME_SPEC so that checking it against the official page is one table, not
 * a hunt. Nothing turns this on until that check is done (VERA_REPORT.md, the
 * owner's steps): the Command Center shows Payme only when PAYMENTS_PROVIDER
 * lists it AND a UZS price is set in the catalog, and both are null/off today.
 *
 * The rules this file keeps — the same as Paddle's and Dodo's:
 *
 *   - Nothing the browser sent decides an amount. The Command Center opens an
 *     ORDER for one pack (payme_open_order, an owner/admin of the organization,
 *     in their own session) and the checkout link names that order. Payme then
 *     asks US whether the amount is right (CheckPerformTransaction /
 *     CreateTransaction), and the answer comes from PAYME_PACKS here, by the
 *     order's pack: a hand-edited link with another amount is refused (-31001).
 *   - Credits are granted ONLY on PerformTransaction, through the same
 *     add_purchased_credits as every other purchase, with the Payme transaction
 *     id as the external id: a Perform delivered twice credits once.
 *   - A cancel after perform takes the credits back through the same
 *     refund_purchased_credits, with one refund id per Payme transaction: a
 *     cancel delivered twice refunds once.
 *   - Test mode (the default) accepts orders only from PAYME_TEST_ORG_IDS: a
 *     sandbox payment must not leave real credits on a customer's workspace.
 *   - No secret, and nothing of the payer beyond ids, is logged or stored. The
 *     merchant key is compared in constant time and never echoed.
 */

import { MAX_BODY_BYTES, StoreError, readBodyCapped, type Logger } from "./paddle.ts";

export { MAX_BODY_BYTES, StoreError, readBodyCapped };
export type { Logger };

// ───────────────────────────────────────────────────────────────────────────
// The protocol (UNCONFIRMED — see the header)
// ───────────────────────────────────────────────────────────────────────────

export const PAYME_SPEC = {
  /** Payme signs each call with `Authorization: Basic base64("Paycom:" + key)`. */
  login: "Paycom",
  /** A created transaction that is not performed within 12 hours is cancelled with reason 4. */
  timeoutMs: 43_200_000,
  /** Transaction states. */
  state: { created: 1, performed: 2, cancelled: -1, cancelledAfterPerform: -2 } as const,
  /** The cancel reason for a timed-out transaction. */
  reasonTimeout: 4,
  errors: {
    /** The request method is not POST. */
    transport: -32300,
    /** The body is not JSON. */
    parse: -32700,
    /** A required field is missing or has the wrong type. */
    invalidRequest: -32600,
    /** The method is not one we answer. */
    methodNotFound: -32601,
    /** Authorization failed. */
    insufficientPrivilege: -32504,
    /** Our own failure (database down): Payme asks again. */
    system: -32400,
    /** The amount is not the order's. */
    wrongAmount: -31001,
    /** No transaction with this id. */
    transactionNotFound: -31003,
    /** The transaction cannot be cancelled (the service was delivered and cannot be taken back). */
    cannotCancel: -31007,
    /** The operation cannot be performed in the transaction's state. */
    cannotPerform: -31008,
    /** Account errors are -31050..-31099, with `data` naming the account field. Ours: */
    orderNotFound: -31050,
    orderBusy: -31051,
  },
  /** The account field the merchant cabinet is configured with; the checkout link writes `ac.order_id=`. */
  accountField: "order_id",
  /** Hosted checkout: GET {base}/{base64("m=…;ac.order_id=…;a=…;l=…;c=…")}. */
  checkoutBase: { test: "https://test.paycom.uz", live: "https://checkout.paycom.uz" },
} as const;

const E = PAYME_SPEC.errors;
const S = PAYME_SPEC.state;

/** What Payme shows the payer for each error we return, in the three languages it asks for. */
const MESSAGES: Record<number, { ru: string; uz: string; en: string }> = {
  [E.transport]: { ru: "Метод запроса должен быть POST", uz: "So‘rov usuli POST bo‘lishi kerak", en: "The request method must be POST" },
  [E.parse]: { ru: "Ошибка разбора JSON", uz: "JSON tahlilida xato", en: "JSON parse error" },
  [E.invalidRequest]: { ru: "Неверный запрос", uz: "Noto‘g‘ri so‘rov", en: "Invalid request" },
  [E.methodNotFound]: { ru: "Метод не найден", uz: "Usul topilmadi", en: "Method not found" },
  [E.insufficientPrivilege]: { ru: "Недостаточно привилегий", uz: "Ruxsat yetarli emas", en: "Insufficient privileges" },
  [E.system]: { ru: "Системная ошибка, повторите позже", uz: "Tizim xatosi, keyinroq qayta urinib ko‘ring", en: "System error, try again later" },
  [E.wrongAmount]: { ru: "Неверная сумма", uz: "Noto‘g‘ri summa", en: "Wrong amount" },
  [E.transactionNotFound]: { ru: "Транзакция не найдена", uz: "Tranzaksiya topilmadi", en: "Transaction not found" },
  [E.cannotCancel]: { ru: "Невозможно отменить транзакцию", uz: "Tranzaksiyani bekor qilib bo‘lmaydi", en: "The transaction cannot be cancelled" },
  [E.cannotPerform]: { ru: "Невозможно выполнить операцию", uz: "Amalni bajarib bo‘lmaydi", en: "The operation cannot be performed" },
  [E.orderNotFound]: { ru: "Заказ не найден или недоступен", uz: "Buyurtma topilmadi yoki mavjud emas", en: "Order not found or not available" },
  [E.orderBusy]: { ru: "Заказ уже оплачивается или оплачен", uz: "Buyurtma allaqachon to‘lanmoqda yoki to‘langan", en: "The order is already being paid or is paid" },
};

// ───────────────────────────────────────────────────────────────────────────
// The catalog
// ───────────────────────────────────────────────────────────────────────────

/**
 * The packs sold through Payme: credits (the same as Paddle's and Dodo's) and
 * the price in whole Uzbek so'm. The UZS prices are the OWNER's decision and
 * have not been made: null means "not on sale through Payme", and no price is
 * invented here (CLAUDE.md rule 5). A price is set by a reviewed change to this
 * table AND to its copy in command-center/lib/payme.ts (a test keeps them
 * equal), the same way Dodo's USD catalog is kept.
 */
export const PAYME_PACKS: readonly { id: string; credits: number; uzs: number | null }[] = [
  { id: "starter", credits: 1000, uzs: null },
  { id: "creator", credits: 5000, uzs: null },
  { id: "studio", credits: 20000, uzs: null },
];

export interface PaymePack {
  id: string;
  credits: number;
  /** The price in tiyin (1 so'm = 100 tiyin): the unit Payme sends amounts in. */
  tiyin: number;
}

/** pack id -> what it sells for. Only packs with a positive whole-so'm price are in it. */
export type PaymePackTable = ReadonlyMap<string, PaymePack>;

export function paymePackTable(packs: readonly { id: string; credits: number; uzs: number | null }[] = PAYME_PACKS): PaymePackTable {
  const m = new Map<string, PaymePack>();
  for (const p of packs) {
    if (typeof p.uzs === "number" && Number.isSafeInteger(p.uzs) && p.uzs > 0 && Number.isSafeInteger(p.credits) && p.credits > 0)
      m.set(p.id, { id: p.id, credits: p.credits, tiyin: p.uzs * 100 });
  }
  return m;
}

// ───────────────────────────────────────────────────────────────────────────
// Settings
// ───────────────────────────────────────────────────────────────────────────

export type PaymeMode = "test" | "live";

/** PAYME_MODE: live only when it says exactly `live`; anything else is test (orders from PAYME_TEST_ORG_IDS only). */
export function paymeModeFromEnv(raw: string | null | undefined): PaymeMode {
  return (raw ?? "").trim().toLowerCase() === "live" ? "live" : "test";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function paymeTestOrgsFromEnv(raw: string | null | undefined): ReadonlySet<string> {
  return new Set((raw ?? "").split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter((x) => UUID_RE.test(x)));
}

/** The merchant key is usable only when it is long enough to be a real key and has no white space (a pasted line break). */
export function paymeKeyUsable(key: string | null | undefined): boolean {
  return typeof key === "string" && key.length >= 16 && !/\s/.test(key);
}

// ───────────────────────────────────────────────────────────────────────────
// Authorization
// ───────────────────────────────────────────────────────────────────────────

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Equal byte strings, in time that depends only on the expected length — never an early exit on the first wrong byte. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (i < a.length ? a[i] : 0) ^ b[i];
  return diff === 0;
}

/**
 * Whether the Authorization header is Payme's: `Basic base64("Paycom:" + key)`.
 * The decoded text is compared whole, in constant time, so a wrong login and a
 * wrong key look the same from outside. Nothing here is ever logged.
 */
export function paymeAuthorized(header: string | null | undefined, key: string): boolean {
  if (!paymeKeyUsable(key) || typeof header !== "string") return false;
  const m = /^Basic ([A-Za-z0-9+/=]{4,2048})$/.exec(header.trim());
  if (!m) return false;
  let decoded: string;
  try {
    decoded = atob(m[1]);
  } catch {
    return false;
  }
  // atob gives one char per byte: compare those bytes with the expected UTF-8 bytes.
  const got = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  return sameBytes(got, utf8(`${PAYME_SPEC.login}:${key}`));
}

// ───────────────────────────────────────────────────────────────────────────
// The store
// ───────────────────────────────────────────────────────────────────────────

export interface PaymeOrder {
  orderId: string;
  orgId: string;
  userId: string | null;
  packId: string;
  /** Epoch ms after which the order cannot be paid. */
  expiresAt: number;
}

export type PaymeState = -2 | -1 | 1 | 2;

export interface PaymeTransaction {
  /** Payme's transaction id (params.id). */
  paymeId: string;
  /** Our id for it, the `transaction` field of every answer. */
  ourId: string;
  orderId: string;
  orgId: string;
  packId: string;
  credits: number;
  /** tiyin, as Payme sent it. */
  amount: number;
  /** Payme's own creation time (params.time), epoch ms: what GetStatement filters on. */
  paymeTime: number;
  createTime: number;
  performTime: number;
  cancelTime: number;
  state: PaymeState;
  reason: number | null;
}

export type NewPaymeTransaction = Omit<PaymeTransaction, "ourId">;

/** What the handler needs from the database (service role). */
export interface PaymeStore {
  findOrder(orderId: string): Promise<PaymeOrder | null>;
  findTransaction(paymeId: string): Promise<PaymeTransaction | null>;
  /** The order's transaction in state 1 or 2, if any: one order is paid once. */
  liveTransactionForOrder(orderId: string): Promise<PaymeTransaction | null>;
  /** Inserts; a second row for the same Payme id, or a second live row for the same order, fails with StoreError 23505. */
  insertTransaction(tx: NewPaymeTransaction): Promise<PaymeTransaction>;
  /** Moves a transaction ONLY if it is still in `from`; null when it was not (another call moved it first). */
  moveTransaction(
    paymeId: string,
    from: PaymeState,
    to: { state: PaymeState; performTime?: number; cancelTime?: number; reason?: number | null },
  ): Promise<PaymeTransaction | null>;
  /** Transactions whose Payme time is within [from, to], oldest first. */
  transactionsBetween(fromMs: number, toMs: number): Promise<PaymeTransaction[]>;
  /** add_purchased_credits (0020): idempotent on the external id. */
  addPurchasedCredits(orgId: string, credits: number, externalId: string, note: string): Promise<{ duplicate: boolean }>;
  /** refund_purchased_credits (0021/0167), full refund: idempotent on the refund id. */
  refundPurchasedCredits(
    externalId: string,
    refundId: string,
    note: string,
  ): Promise<{ duplicate: boolean; requested: number; taken: number; shortfall: number }>;
}

/** The ledger keys: one purchase and one refund per Payme transaction, never colliding with a Paddle or Dodo id. */
export const paymeExternalId = (paymeId: string) => `payme_${paymeId}`;
export const paymeRefundId = (paymeId: string) => `payme_cancel_${paymeId}`;

/** SQLSTATEs retrying cannot fix (the same set Paddle's and Dodo's webhooks treat as permanent). */
const PERMANENT_CODES = new Set(["23505", "22023", "P0002"]);
function permanentCode(err: unknown): string | null {
  return err instanceof StoreError && err.code && PERMANENT_CODES.has(err.code) ? err.code : null;
}

// ───────────────────────────────────────────────────────────────────────────
// The handler
// ───────────────────────────────────────────────────────────────────────────

export interface PaymeRequest {
  method: string;
  authorization: string | null;
  rawBody: string;
}

export interface PaymeDeps {
  /** PAYME_MERCHANT_KEY: the cashbox key Payme signs with (the sandbox key in test mode). */
  key: string;
  mode: PaymeMode;
  testOrgs: ReadonlySet<string>;
  packs: PaymePackTable;
  store: PaymeStore;
  now?: () => number;
  log?: Logger;
}

type RpcId = string | number | null;
type RpcBody = { jsonrpc: "2.0"; id: RpcId; result: unknown } | { jsonrpc: "2.0"; id: RpcId; error: { code: number; message: { ru: string; uz: string; en: string }; data?: string } };

/** Payme's calls are answered 200 with a JSON-RPC body; the error, if any, is in the body. */
export interface PaymeResponse {
  status: 200;
  body: RpcBody;
}

class RpcFail extends Error {
  constructor(readonly code: number, readonly data?: string) {
    super(String(code));
  }
}

function fail(id: RpcId, code: number, data?: string): PaymeResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message: MESSAGES[code], ...(data ? { data } : {}) } } };
}

const PAYME_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Our order ids (payme_open_order): 32 lower-case hex digits. */
export const PAYME_ORDER_ID_RE = /^[0-9a-f]{32}$/;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

function rpcId(v: unknown): RpcId {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) ? v : null;
}

export async function handlePaymeRequest(req: PaymeRequest, deps: PaymeDeps): Promise<PaymeResponse> {
  const log: Logger = deps.log ?? console;
  const now = deps.now ?? Date.now;
  if (req.method !== "POST") return fail(null, E.transport);

  // The id is read before authorization only so the refusal can echo it, as Payme's sandbox checks; nothing else is used.
  let parsed: unknown;
  let parsedOk = true;
  try {
    parsed = JSON.parse(req.rawBody);
  } catch {
    parsedOk = false;
  }
  const id = rpcId(obj(parsed).id);

  if (!paymeKeyUsable(deps.key)) {
    log.error("payme-merchant: PAYME_MERCHANT_KEY is not set — every call is refused");
    return fail(id, E.insufficientPrivilege);
  }
  if (!paymeAuthorized(req.authorization, deps.key)) {
    // The reason only — never the header.
    log.warn("payme-merchant: authorization refused");
    return fail(id, E.insufficientPrivilege);
  }
  if (!parsedOk) return fail(null, E.parse);
  const body = obj(parsed);
  const method = body.method;
  const params = body.params;
  if (typeof method !== "string" || !params || typeof params !== "object" || Array.isArray(params)) return fail(id, E.invalidRequest);

  try {
    const result = await dispatch(method, obj(params), deps, now, log);
    return { status: 200, body: { jsonrpc: "2.0", id, result } };
  } catch (err) {
    if (err instanceof RpcFail) return fail(id, err.code, err.data);
    const code = err instanceof StoreError ? err.code : null;
    log.error(`payme-merchant: ${method} failed (${code ?? (err instanceof Error ? err.name : "error")}); Payme will ask again`);
    return fail(id, E.system);
  }
}

async function dispatch(method: string, p: Record<string, unknown>, deps: PaymeDeps, now: () => number, log: Logger): Promise<unknown> {
  switch (method) {
    case "CheckPerformTransaction":
      await checkOrder(p, deps);
      return { allow: true };
    case "CreateTransaction":
      return createTransaction(p, deps, now);
    case "PerformTransaction":
      return performTransaction(p, deps, now, log);
    case "CancelTransaction":
      return cancelTransaction(p, deps, now, log);
    case "CheckTransaction":
      return checkTransaction(p, deps);
    case "GetStatement":
      return getStatement(p, deps);
    default:
      // ChangePassword included: the key lives in the Edge Function's secrets, set by the owner, never by a call.
      throw new RpcFail(E.methodNotFound);
  }
}

/** The order an amount and account name, checked the same way for CheckPerformTransaction and a new CreateTransaction. */
async function checkOrder(p: Record<string, unknown>, deps: PaymeDeps): Promise<{ order: PaymeOrder; pack: PaymePack; amount: number }> {
  const field = PAYME_SPEC.accountField;
  const amount = p.amount;
  if (!isInt(amount) || amount <= 0) throw new RpcFail(E.wrongAmount);
  const orderId = obj(p.account)[field];
  if (typeof orderId !== "string" || !PAYME_ORDER_ID_RE.test(orderId)) throw new RpcFail(E.orderNotFound, field);
  const order = await deps.store.findOrder(orderId);
  if (!order || order.expiresAt < (deps.now ?? Date.now)()) throw new RpcFail(E.orderNotFound, field);
  // Test mode: a sandbox card must not buy real credits for a workspace that is not on the list.
  if (deps.mode !== "live" && !deps.testOrgs.has(order.orgId.toLowerCase())) throw new RpcFail(E.orderNotFound, field);
  const pack = deps.packs.get(order.packId);
  // A pack whose UZS price was withdrawn after the order was opened: not on sale, never sold at a guessed price.
  if (!pack) throw new RpcFail(E.orderNotFound, field);
  if (amount !== pack.tiyin) throw new RpcFail(E.wrongAmount);
  if (await deps.store.liveTransactionForOrder(orderId)) throw new RpcFail(E.orderBusy, field);
  return { order, pack, amount };
}

function paymeIdOf(p: Record<string, unknown>): string {
  const id = p.id;
  if (typeof id !== "string" || !PAYME_ID_RE.test(id)) throw new RpcFail(E.invalidRequest);
  return id;
}

function timedOut(tx: PaymeTransaction, nowMs: number): boolean {
  return nowMs - tx.createTime > PAYME_SPEC.timeoutMs;
}

/** A created transaction past the timeout is cancelled (reason 4) and the call is refused with -31008. */
async function cancelForTimeout(tx: PaymeTransaction, deps: PaymeDeps, nowMs: number): Promise<never> {
  await deps.store.moveTransaction(tx.paymeId, S.created, { state: S.cancelled, cancelTime: nowMs, reason: PAYME_SPEC.reasonTimeout });
  throw new RpcFail(E.cannotPerform);
}

function createAnswer(tx: PaymeTransaction) {
  return { create_time: tx.createTime, transaction: tx.ourId, state: tx.state };
}

/** A repeated CreateTransaction for a transaction we already have: the same answer while it is open, -31008 otherwise. */
async function existingCreate(tx: PaymeTransaction, p: Record<string, unknown>, deps: PaymeDeps, nowMs: number) {
  if (tx.state !== S.created) throw new RpcFail(E.cannotPerform);
  // The same Payme id cannot be re-used for another order or amount.
  if (p.amount !== tx.amount || obj(p.account)[PAYME_SPEC.accountField] !== tx.orderId) throw new RpcFail(E.cannotPerform);
  if (timedOut(tx, nowMs)) await cancelForTimeout(tx, deps, nowMs);
  return createAnswer(tx);
}

async function createTransaction(p: Record<string, unknown>, deps: PaymeDeps, now: () => number) {
  const paymeId = paymeIdOf(p);
  if (!isInt(p.time) || p.time <= 0) throw new RpcFail(E.invalidRequest);
  const nowMs = now();
  const prior = await deps.store.findTransaction(paymeId);
  if (prior) return existingCreate(prior, p, deps, nowMs);

  const { order, pack, amount } = await checkOrder(p, deps);
  try {
    const tx = await deps.store.insertTransaction({
      paymeId,
      orderId: order.orderId,
      orgId: order.orgId,
      packId: pack.id,
      credits: pack.credits,
      amount,
      paymeTime: p.time,
      createTime: nowMs,
      performTime: 0,
      cancelTime: 0,
      state: S.created,
      reason: null,
    });
    return createAnswer(tx);
  } catch (err) {
    if (!(err instanceof StoreError) || err.code !== "23505") throw err;
    // Two creates raced: the same Payme id (answer as a repeat), or another transaction took the order first.
    const raced = await deps.store.findTransaction(paymeId);
    if (raced) return existingCreate(raced, p, deps, nowMs);
    throw new RpcFail(E.orderBusy, PAYME_SPEC.accountField);
  }
}

function performAnswer(tx: PaymeTransaction) {
  return { transaction: tx.ourId, perform_time: tx.performTime, state: tx.state };
}

async function performTransaction(p: Record<string, unknown>, deps: PaymeDeps, now: () => number, log: Logger) {
  const paymeId = paymeIdOf(p);
  const tx = await deps.store.findTransaction(paymeId);
  if (!tx) throw new RpcFail(E.transactionNotFound);
  if (tx.state === S.performed) return performAnswer(tx);
  if (tx.state !== S.created) throw new RpcFail(E.cannotPerform);
  const nowMs = now();
  if (timedOut(tx, nowMs)) await cancelForTimeout(tx, deps, nowMs);

  // Credits first, then the state: add_purchased_credits is idempotent on the external id, so a retry after a
  // failure between the two lines credits once and then records the state.
  try {
    const res = await deps.store.addPurchasedCredits(tx.orgId, tx.credits, paymeExternalId(paymeId), `Payme ${paymeId}: ${tx.packId} pack`);
    log.info(`payme-merchant: ${paymeId} ${res.duplicate ? "already credited" : `credited ${tx.credits}`}`);
  } catch (err) {
    const code = permanentCode(err);
    if (code) {
      log.error(`payme-merchant: ${paymeId} cannot be credited (${code}) — refused; a person must look`);
      throw new RpcFail(E.cannotPerform);
    }
    throw err;
  }
  const moved = await deps.store.moveTransaction(paymeId, S.created, { state: S.performed, performTime: nowMs });
  if (moved) return performAnswer(moved);
  const after = await deps.store.findTransaction(paymeId);
  if (after?.state === S.performed) return performAnswer(after);
  // A cancel landed between the grant and the move: the transaction is not paid, so the grant is taken back.
  await deps.store.refundPurchasedCredits(paymeExternalId(paymeId), paymeRefundId(paymeId), `Payme ${paymeId}: cancelled before perform`);
  log.warn(`payme-merchant: ${paymeId} was cancelled while it was being performed — credits taken back`);
  throw new RpcFail(E.cannotPerform);
}

function cancelAnswer(tx: PaymeTransaction) {
  return { transaction: tx.ourId, cancel_time: tx.cancelTime, state: tx.state };
}

async function cancelTransaction(p: Record<string, unknown>, deps: PaymeDeps, now: () => number, log: Logger) {
  const paymeId = paymeIdOf(p);
  if (!isInt(p.reason)) throw new RpcFail(E.invalidRequest);
  const reason = p.reason;
  // Two passes at most: a created transaction that a Perform moves under us is then cancelled as a performed one.
  for (let pass = 0; pass < 2; pass++) {
    const tx = await deps.store.findTransaction(paymeId);
    if (!tx) throw new RpcFail(E.transactionNotFound);
    if (tx.state === S.cancelled || tx.state === S.cancelledAfterPerform) return cancelAnswer(tx);
    const nowMs = now();
    if (tx.state === S.created) {
      const moved = await deps.store.moveTransaction(paymeId, S.created, { state: S.cancelled, cancelTime: nowMs, reason });
      if (moved) return cancelAnswer(moved);
      continue;
    }
    // Performed: the credits go back first (idempotent on the refund id), then the state.
    try {
      const res = await deps.store.refundPurchasedCredits(paymeExternalId(paymeId), paymeRefundId(paymeId), `Payme ${paymeId}: cancelled (reason ${reason})`);
      if (res.shortfall > 0)
        log.warn(`payme-merchant: ${paymeId} cancelled after perform: took back ${res.taken} of ${res.requested} credits; ${res.shortfall} already spent`);
    } catch (err) {
      const code = permanentCode(err);
      if (code) {
        log.error(`payme-merchant: ${paymeId} refund refused (${code}) — cancel refused; a person must look`);
        throw new RpcFail(E.cannotCancel);
      }
      throw err;
    }
    const moved = await deps.store.moveTransaction(paymeId, S.performed, { state: S.cancelledAfterPerform, cancelTime: nowMs, reason });
    if (moved) return cancelAnswer(moved);
    const after = await deps.store.findTransaction(paymeId);
    if (after && after.state === S.cancelledAfterPerform) return cancelAnswer(after);
    throw new StoreError("cancel: the transaction moved during the refund", null);
  }
  throw new StoreError("cancel: the transaction kept moving", null);
}

function fullAnswer(tx: PaymeTransaction) {
  return {
    create_time: tx.createTime,
    perform_time: tx.performTime,
    cancel_time: tx.cancelTime,
    transaction: tx.ourId,
    state: tx.state,
    reason: tx.reason,
  };
}

async function checkTransaction(p: Record<string, unknown>, deps: PaymeDeps) {
  const tx = await deps.store.findTransaction(paymeIdOf(p));
  if (!tx) throw new RpcFail(E.transactionNotFound);
  return fullAnswer(tx);
}

async function getStatement(p: Record<string, unknown>, deps: PaymeDeps) {
  if (!isInt(p.from) || !isInt(p.to) || p.from > p.to) throw new RpcFail(E.invalidRequest);
  const rows = await deps.store.transactionsBetween(p.from, p.to);
  return {
    transactions: rows.map((tx) => ({
      id: tx.paymeId,
      time: tx.paymeTime,
      amount: tx.amount,
      account: { [PAYME_SPEC.accountField]: tx.orderId },
      ...fullAnswer(tx),
    })),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The database, over Supabase's REST API with the service role
// ───────────────────────────────────────────────────────────────────────────
// Needs the payme_orders / payme_transactions tables of the migration written out in VERA_REPORT.md (not in the repo
// yet: its number is assigned at merge). Until it is applied every call fails here and Payme is answered -32400.

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createPaymeRestStore(opts: { url: string; serviceKey: string; fetch?: FetchLike }): PaymeStore {
  const base = opts.url.replace(/\/+$/, "") + "/rest/v1";
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const headers = (extra: Record<string, string> = {}) => ({
    apikey: opts.serviceKey,
    Authorization: `Bearer ${opts.serviceKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra,
  });

  // Errors carry the HTTP status and the Postgres code only — never a header, so never the key.
  async function call(what: string, path: string, init: RequestInit, extra?: Record<string, string>): Promise<unknown> {
    const res = await doFetch(base + path, { ...init, headers: headers(extra) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const c = obj(json).code;
      const code = typeof c === "string" ? c : null;
      throw new StoreError(`${what}: HTTP ${res.status}${code ? ` ${code}` : ""}`, code);
    }
    return json;
  }
  const q = encodeURIComponent;
  const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
  const COLS = "payme_id,id,order_id,org_id,pack_id,credits,amount,payme_time,create_time,perform_time,cancel_time,state,reason";
  const toTx = (r: Record<string, unknown>): PaymeTransaction => ({
    paymeId: String(r.payme_id),
    ourId: String(r.id),
    orderId: String(r.order_id),
    orgId: String(r.org_id),
    packId: String(r.pack_id),
    credits: n(r.credits),
    amount: n(r.amount),
    paymeTime: n(r.payme_time),
    createTime: n(r.create_time),
    performTime: n(r.perform_time),
    cancelTime: n(r.cancel_time),
    state: n(r.state) as PaymeState,
    reason: r.reason === null || r.reason === undefined ? null : n(r.reason),
  });
  const first = (rows: unknown) => (Array.isArray(rows) && rows.length ? obj(rows[0]) : null);
  const rpc = (fn: string, args: Record<string, unknown>) => call(fn, `/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

  return {
    async findOrder(orderId) {
      const r = first(await call("payme_orders", `/payme_orders?order_id=eq.${q(orderId)}&select=order_id,org_id,user_id,pack_id,expires_at`, { method: "GET" }));
      if (!r) return null;
      const exp = Date.parse(String(r.expires_at));
      return { orderId: String(r.order_id), orgId: String(r.org_id), userId: r.user_id ? String(r.user_id) : null, packId: String(r.pack_id), expiresAt: Number.isFinite(exp) ? exp : 0 };
    },
    async findTransaction(paymeId) {
      const r = first(await call("payme_transactions", `/payme_transactions?payme_id=eq.${q(paymeId)}&select=${COLS}`, { method: "GET" }));
      return r ? toTx(r) : null;
    },
    async liveTransactionForOrder(orderId) {
      const r = first(await call("payme_transactions", `/payme_transactions?order_id=eq.${q(orderId)}&state=in.(1,2)&select=${COLS}&limit=1`, { method: "GET" }));
      return r ? toTx(r) : null;
    },
    async insertTransaction(tx) {
      const row = {
        payme_id: tx.paymeId, order_id: tx.orderId, org_id: tx.orgId, pack_id: tx.packId, credits: tx.credits, amount: tx.amount,
        payme_time: tx.paymeTime, create_time: tx.createTime, perform_time: tx.performTime, cancel_time: tx.cancelTime, state: tx.state, reason: tx.reason,
      };
      const r = first(await call("payme_transactions", `/payme_transactions?select=${COLS}`, { method: "POST", body: JSON.stringify(row) }, { Prefer: "return=representation" }));
      if (!r) throw new StoreError("payme_transactions: insert returned no row", null);
      return toTx(r);
    },
    async moveTransaction(paymeId, from, to) {
      const patch: Record<string, unknown> = { state: to.state };
      if (to.performTime !== undefined) patch.perform_time = to.performTime;
      if (to.cancelTime !== undefined) patch.cancel_time = to.cancelTime;
      if (to.reason !== undefined) patch.reason = to.reason;
      const r = first(
        await call("payme_transactions", `/payme_transactions?payme_id=eq.${q(paymeId)}&state=eq.${from}&select=${COLS}`, { method: "PATCH", body: JSON.stringify(patch) }, { Prefer: "return=representation" }),
      );
      return r ? toTx(r) : null;
    },
    async transactionsBetween(fromMs, toMs) {
      const rows = await call("payme_transactions", `/payme_transactions?payme_time=gte.${fromMs}&payme_time=lte.${toMs}&select=${COLS}&order=payme_time.asc`, { method: "GET" });
      return Array.isArray(rows) ? rows.map((r) => toTx(obj(r))) : [];
    },
    async addPurchasedCredits(orgId, credits, externalId, note) {
      const res = obj(await rpc("add_purchased_credits", { p_org: orgId, p_amount: credits, p_external_id: externalId, p_note: note }));
      return { duplicate: res.duplicate === true };
    },
    async refundPurchasedCredits(externalId, refundId, note) {
      const res = obj(await rpc("refund_purchased_credits", { p_external_id: externalId, p_refund_id: refundId, p_amount: null, p_note: note, p_reason: "refund" }));
      return { duplicate: res.duplicate === true, requested: n(res.requested), taken: n(res.taken), shortfall: n(res.shortfall) };
    },
  };
}
