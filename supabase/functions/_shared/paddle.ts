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
 *   - Every purchase is credited through add_purchased_credits() with the
 *     Paddle transaction id as its external_id, so a webhook delivered twice,
 *     or retried after a timeout, credits once.
 *   - A paid purchase that cannot be credited (unknown organization, unknown
 *     price) is answered 200 and recorded as `rejected`: retrying cannot fix
 *     it, a person must (refund it in Paddle, or grant by hand). A failure
 *     that retrying CAN fix (the database was unreachable) is answered 5xx so
 *     Paddle delivers the event again.
 *   - No secret, and nothing of the payer beyond ids, is ever logged or stored.
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
export function decideTransaction(data: Record<string, unknown>, prices: PriceTable): Decision {
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

  const note = [`Paddle ${transactionId}: ${lines.join(", ")}`, userId ? `bought by user ${userId}` : null]
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

export function decideEvent(event: PaddleEvent, prices: PriceTable): Decision {
  switch (event.eventType) {
    case "transaction.completed":
      return decideTransaction(event.data, prices);
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
  deps: { secret: string; prices: PriceTable; store: PaddleStore; now?: () => number; log?: Logger },
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

    const decision = decideEvent(event, deps.prices);
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
