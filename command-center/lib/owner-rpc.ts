/**
 * The owner pages' side of the server-side owner functions (migration 0107, 0106).
 *
 * Pure and free of server-only imports, so the routes, the client components and the tests all share ONE
 * reading of what the database answers:
 *
 *  - which words the database uses to refuse (`owner_err` codes) and which of them a route can produce itself,
 *  - the request checks a route makes before it calls the database (the database checks again; these exist so a
 *    malformed request is a 400 with a code a person can read, not a Postgres error),
 *  - turning the database's JSON document into an HTTP status and a body the browser reads with
 *    lib/operator-post.ts,
 *  - the small derivations the pages need (is this price change a "big" one, which grants can still be reversed,
 *    how much has been granted in the last 24 hours).
 *
 * NIGHTSHIFT_OWNER_RPC is read in lib/server/owner-rpc.ts, per request. Everything here is inert without it.
 */

/** The flag's value: only the literal "on" turns the owner functions on. Anything else, empty included, is off. */
export function parseOwnerRpcFlag(value: string | undefined | null): boolean {
  return (value ?? "").trim().toLowerCase() === "on";
}

/** Every refusal the database (owner_err) can give to the six screens, plus the ones a route gives itself. */
export const OWNER_REFUSALS = [
  // the front door of every owner function
  "mfa_required",
  "rate_limited",
  // grants
  "per_call_cap",
  "daily_cap",
  "reason_required",
  "idempotency_key_required",
  "key_reused",
  "unknown_org",
  "exempt_org",
  "bad_amount",
  "balance_limit",
  // reversals
  "not_a_grant",
  "not_reversible",
  "too_old",
  "nothing_to_reverse",
  "already_reversed",
  // prices
  "bad_unit",
  "bad_rate",
  "bad_margin",
  "bad_note",
  "no_such_price",
  "no_such_history",
  "confirm_required",
  // team
  "bad_role",
  "bad_email",
  "owner_required",
  "already_member",
  "no_such_member",
  "self_change",
  "last_owner",
  // a route's own
  "unauthorized",
  "forbidden",
  "migration_missing",
  "not_found",
  "bad_request",
  "bad_reply",
  "rpc_failed",
  "not_configured",
] as const;
export type OwnerRefusal = (typeof OWNER_REFUSALS)[number];

export function isOwnerRefusal(code: unknown): code is OwnerRefusal {
  return typeof code === "string" && (OWNER_REFUSALS as readonly string[]).includes(code);
}

/** Roles the roster accepts (owner_add_member / owner_set_member_role). */
const ROLE_SET = ["owner", "admin", "editor", "viewer"] as const;
type RoleName = (typeof ROLE_SET)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const UNIT = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_GRANT = 100_000_000;
const MAX_RATE = 1_000_000;

/** A call the route may make: the function and its named arguments. Nothing else is ever sent. */
export type OwnerCall = { fn: string; args: Record<string, unknown> };
export type OwnerParse = { ok: true; call: OwnerCall } | { ok: false; error: OwnerRefusal };

const bad = (error: OwnerRefusal): OwnerParse => ({ ok: false, error });
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Optional free text: absent/null/blank = null; longer than 300 characters is a refusal (the database's own limit). */
function optionalText(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const t = v.trim();
  if (t.length > 300) return { ok: false };
  return { ok: true, value: t === "" ? null : t };
}

export const REASON_MIN = 8;
export const REASON_MAX = 300;

/** A required reason: 8 to 300 characters after trimming, as owner_grant_credits / owner_reverse_grant demand. */
export function reasonOk(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= REASON_MIN && v.trim().length <= REASON_MAX;
}

export function parseGrant(body: unknown): OwnerParse {
  const b = obj(body);
  if (!b) return bad("bad_request");
  const org = str(b.org);
  if (!org || !UUID.test(org)) return bad("unknown_org");
  const credits = num(b.credits);
  if (credits === null || !(credits > 0) || credits > MAX_GRANT) return bad("bad_amount");
  if (!reasonOk(b.reason)) return bad("reason_required");
  const key = str(b.key);
  if (!key || !KEY.test(key)) return bad("idempotency_key_required");
  return {
    ok: true,
    call: {
      fn: "owner_grant_credits",
      args: { p_org: org, p_credits: credits, p_reason: (b.reason as string).trim(), p_idempotency_key: key },
    },
  };
}

export function parseReverse(body: unknown): OwnerParse {
  const b = obj(body);
  if (!b) return bad("bad_request");
  const id = num(b.transactionId);
  if (id === null || !Number.isSafeInteger(id) || id <= 0) return bad("not_a_grant");
  if (!reasonOk(b.reason)) return bad("reason_required");
  return { ok: true, call: { fn: "owner_reverse_grant", args: { p_transaction_id: id, p_reason: (b.reason as string).trim() } } };
}

export function parsePrice(body: unknown): OwnerParse {
  const b = obj(body);
  if (!b) return bad("bad_request");
  const reason = optionalText(b.reason);
  if (!reason.ok) return bad("bad_note");
  const confirm = b.confirm === true;
  const action = str(b.action);
  if (action === "set") {
    const unit = str(b.unit)?.trim() ?? "";
    if (!UNIT.test(unit)) return bad("bad_unit");
    const rate = num(b.rate);
    if (rate === null || rate < 0 || rate > MAX_RATE) return bad("bad_rate");
    const margin = num(b.margin);
    if (margin === null || margin < 0 || margin > 10) return bad("bad_margin");
    const note = optionalText(b.note);
    if (!note.ok) return bad("bad_note");
    return {
      ok: true,
      call: {
        fn: "owner_set_credit_price",
        args: { p_unit: unit, p_credits_per_unit: rate, p_margin: margin, p_note: note.value, p_reason: reason.value, p_confirm_big_change: confirm },
      },
    };
  }
  if (action === "delete") {
    const unit = str(b.unit)?.trim() ?? "";
    if (!UNIT.test(unit)) return bad("bad_unit");
    return { ok: true, call: { fn: "owner_delete_credit_price", args: { p_unit: unit, p_reason: reason.value, p_confirm_big_change: confirm } } };
  }
  if (action === "restore") {
    const id = num(b.historyId);
    if (id === null || !Number.isSafeInteger(id) || id <= 0) return bad("no_such_history");
    return { ok: true, call: { fn: "owner_restore_credit_price", args: { p_history_id: id, p_reason: reason.value, p_confirm_big_change: confirm } } };
  }
  return bad("bad_request");
}

export function parseTeam(body: unknown): OwnerParse {
  const b = obj(body);
  if (!b) return bad("bad_request");
  const reason = optionalText(b.reason);
  if (!reason.ok) return bad("bad_note");
  const action = str(b.action);
  const role = str(b.role);
  const roleOk = role !== null && (ROLE_SET as readonly string[]).includes(role);
  if (action === "add") {
    const email = (str(b.email) ?? "").trim().toLowerCase();
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad("bad_email");
    if (!roleOk) return bad("bad_role");
    return { ok: true, call: { fn: "owner_add_member", args: { p_email: email, p_role: role, p_reason: reason.value } } };
  }
  const member = str(b.member);
  if (action === "role") {
    if (!member || !UUID.test(member)) return bad("no_such_member");
    if (!roleOk) return bad("bad_role");
    return { ok: true, call: { fn: "owner_set_member_role", args: { p_member: member, p_role: role, p_reason: reason.value } } };
  }
  if (action === "remove") {
    if (!member || !UUID.test(member)) return bad("no_such_member");
    return { ok: true, call: { fn: "owner_remove_member", args: { p_member: member, p_reason: reason.value } } };
  }
  return bad("bad_request");
}

/** What a route sends back for the database's JSON answer. */
export interface OwnerHttp {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The database answers `{ok: true, ...}` or `{ok: false, error, message, ...extra}` (owner_err). The English
 * `message` is dropped here: the screens word every refusal themselves, in the person's language
 * (lib/i18n/owner-rpc). Statuses are chosen so lib/operator-post.ts reads them right: 401 mfa_required is "type your
 * code again", 429 is "too many", and every other refusal is a 4xx that keeps its `error` and figures for the screen.
 * 409 confirm_required carries the old/new figures and the ratio, so the screen can show an explicit confirm step.
 */
export function ownerReplyToHttp(data: unknown): OwnerHttp {
  const d = obj(data);
  if (!d || typeof d.ok !== "boolean") return { status: 502, body: { ok: false, error: "bad_reply" } };
  if (d.ok) return { status: 200, body: d };
  const code = typeof d.error === "string" ? d.error : "bad_reply";
  const { message: _message, ...rest } = d;
  void _message;
  const body = { ...rest, ok: false, error: code };
  if (code === "mfa_required") return { status: 401, body };
  if (code === "rate_limited") return { status: 429, body };
  if (code === "confirm_required") return { status: 409, body };
  if (code === "bad_reply") return { status: 502, body };
  return { status: 422, body };
}

/** An error PostgREST returned for an rpc call, as the route's answer. The database's own text is never forwarded. */
export function ownerRpcErrorToHttp(error: { code?: string | null; message?: string | null }): OwnerHttp {
  const code = error.code ?? "";
  if (code === "42501") return { status: 403, body: { ok: false, error: "forbidden" } };
  // PGRST202: not in the schema cache; 42883: no such function. 0107 not applied (or the cache is stale).
  if (code === "PGRST202" || code === "42883") return { status: 503, body: { ok: false, error: "migration_missing" } };
  if (code === "PGRST301" || code === "PGRST303") return { status: 401, body: { ok: false, error: "unauthorized" } };
  return { status: 502, body: { ok: false, error: "rpc_failed" } };
}

/**
 * Does this price change need an explicit confirm? The same rule as owner_price_write: a rate of zero, a price that
 * was zero, or either the rate or what the customer is charged (rate x (1 + margin)) moving by more than `maxRatio`
 * in either direction. The database decides; this lets the sheet show the figures before it asks.
 */
export interface PriceFigures {
  rate: number;
  margin: number;
}
export type BigReason = "zero" | "was_zero" | "ratio" | "delete";
export function priceBigChange(
  old: PriceFigures | null,
  next: PriceFigures | null,
  maxRatio: number,
): { big: boolean; reason: BigReason | null; rateRatio: number | null; chargedRatio: number | null } {
  if (next === null) return { big: true, reason: "delete", rateRatio: null, chargedRatio: null };
  if (next.rate === 0) return { big: true, reason: "zero", rateRatio: null, chargedRatio: null };
  if (old === null) return { big: false, reason: null, rateRatio: null, chargedRatio: null };
  if (old.rate === 0) return { big: true, reason: "was_zero", rateRatio: null, chargedRatio: null };
  const rateRatio = next.rate / old.rate;
  const chargedRatio = (next.rate * (1 + next.margin)) / (old.rate * (1 + old.margin));
  const out = (r: number) => r > maxRatio || r < 1 / maxRatio;
  const big = out(rateRatio) || out(chargedRatio);
  return { big, reason: big ? "ratio" : null, rateRatio, chargedRatio };
}

/** "x4" for a ratio of 4 and "x0.25" for a quarter: the size of a change in words people say. */
export function ratioText(ratio: number | null | undefined): string | null {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio) || ratio <= 0) return null;
  return `×${Number(ratio.toPrecision(3))}`;
}

/** A grant row as the Credits page reads it (credit_transactions, platform owner/admin). */
export interface GrantRow {
  id: number;
  org_id?: string | null;
  kind: string;
  amount: number;
  created_at: string;
  note: string | null;
  external_id: string | null;
  created_by: string | null;
}

/**
 * Is this ledger row a grant an owner or admin gave? The same test owner_reverse_grant and the 24 hour cap use:
 * an `owner-grant:` request key, or a manual grant_credits row (no external id, an author). Welcome credits, invite
 * rewards and the like are not.
 */
export function isOwnerGrant(row: Pick<GrantRow, "kind" | "external_id" | "created_by">): boolean {
  if (row.kind !== "grant") return false;
  if (typeof row.external_id === "string" && row.external_id.startsWith("owner-grant:")) return true;
  return row.external_id === null && Boolean(row.created_by);
}

/** The grant ids that already have a reversal (`owner-reverse:<id>` on an adjust row). */
export function reversedGrantIds(rows: ReadonlyArray<{ external_id: string | null }>): Set<number> {
  const ids = new Set<number>();
  for (const r of rows) {
    const m = /^owner-reverse:(\d+)$/.exec(r.external_id ?? "");
    if (m) ids.add(Number(m[1]));
  }
  return ids;
}

export interface ReversibleGrant {
  id: number;
  amount: number;
  createdAt: string;
  note: string | null;
  reversed: boolean;
}

/** Grants inside the reversal window, newest first, each marked reversed or not. Outside the window nothing is offered. */
export function reversibleGrants(
  rows: readonly GrantRow[],
  reversed: ReadonlySet<number>,
  windowDays: number,
  nowMs: number,
): ReversibleGrant[] {
  const since = nowMs - windowDays * 86_400_000;
  return rows
    .filter((r) => isOwnerGrant(r) && Number.isFinite(Date.parse(r.created_at)) && Date.parse(r.created_at) >= since)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)
    .map((r) => ({ id: r.id, amount: r.amount, createdAt: r.created_at, note: r.note, reversed: reversed.has(r.id) }));
}

/** Credits granted through the owner path in the rolling 24 hours (all organizations, all actors), as the cap counts them. */
export function granted24h(rows: readonly GrantRow[], nowMs: number): number {
  const since = nowMs - 86_400_000;
  return rows.filter((r) => isOwnerGrant(r) && Date.parse(r.created_at) > since).reduce((s, r) => s + r.amount, 0);
}

/** A request key for one grant attempt. `crypto.randomUUID` where it exists; a random fallback otherwise. */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const id = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `g-${id}`;
}

/** Narrowing helpers the screens use for the database's documents. */
export function roleName(v: unknown): RoleName | null {
  return typeof v === "string" && (ROLE_SET as readonly string[]).includes(v) ? (v as RoleName) : null;
}
