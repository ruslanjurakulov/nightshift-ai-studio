import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OWNER_REFUSALS,
  granted24h,
  isOwnerGrant,
  isOwnerRefusal,
  newIdempotencyKey,
  ownerReplyToHttp,
  ownerRpcErrorToHttp,
  parseGrant,
  parseOwnerRpcFlag,
  parsePrice,
  parseReverse,
  parseTeam,
  priceBigChange,
  ratioText,
  reasonOk,
  reversedGrantIds,
  reversibleGrants,
  type GrantRow,
} from "../lib/owner-rpc";

/**
 * The owner pages' side of the 0107 functions: the flag, the request checks a route makes before it calls the
 * database, how the database's answer becomes an HTTP answer, and the small derivations the screens show.
 * What would break without these: a flag value that turns the new path on by accident, a request that reaches the
 * database malformed, a refusal that reads as success, a "big change" the screen does not see coming, a grant offered
 * for reversal that the database would refuse (or the reverse), and a new refusal code the screens cannot word.
 */

const ORG = "0b000000-0000-0000-0000-00000000000b";
const MEMBER = "11111111-2222-3333-4444-555555555555";
const KEY = "g-0123456789abcdef";
const WHY = "welcome gift for the pilot";

describe("NIGHTSHIFT_OWNER_RPC", () => {
  it.each([
    ["on", true],
    [" ON ", true],
    ["off", false],
    ["", false],
    [undefined, false],
    [null, false],
    ["1", false],
    ["true", false],
    ["yes", false],
    ["enabled", false],
  ])("%j reads as %s: only the word on turns it on", (value, expected) => {
    expect(parseOwnerRpcFlag(value as string | undefined)).toBe(expected);
  });
});

describe("the refusal codes", () => {
  it("every code the 0107 owner functions can answer with is one the screens can word", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0107_owner_safety.sql"), "utf8");
    const used = new Set([...sql.matchAll(/owner_err\(\s*'([a-z_0-9]+)'/g)].map((m) => m[1]));
    // These belong to enable_admin_mfa / disable_admin_mfa, which no screen calls.
    const gateOnly = new Set(["admins_need_two_factors", "factors_unreadable", "no_admins", "session_not_fresh", "all", "or"]);
    const missing = [...used].filter((c) => !gateOnly.has(c) && !isOwnerRefusal(c));
    expect(missing, `add these to OWNER_REFUSALS and lib/i18n/owner-rpc: ${missing.join(", ")}`).toEqual([]);
    expect(used.size).toBeGreaterThan(30);
  });

  it("names no refusal twice", () => {
    expect(new Set(OWNER_REFUSALS).size).toBe(OWNER_REFUSALS.length);
  });
});

describe("parseGrant", () => {
  const ok = { org: ORG, credits: 250, reason: ` ${WHY} `, key: KEY };

  it("passes exactly the four arguments of owner_grant_credits, with the reason trimmed", () => {
    expect(parseGrant(ok)).toEqual({
      ok: true,
      call: { fn: "owner_grant_credits", args: { p_org: ORG, p_credits: 250, p_reason: WHY, p_idempotency_key: KEY } },
    });
  });

  it.each([
    ["no body", null, "bad_request"],
    ["an array", [], "bad_request"],
    ["an organization that is not an id", { ...ok, org: "acme" }, "unknown_org"],
    ["no organization", { ...ok, org: undefined }, "unknown_org"],
    ["zero credits", { ...ok, credits: 0 }, "bad_amount"],
    ["negative credits", { ...ok, credits: -5 }, "bad_amount"],
    ["credits as text", { ...ok, credits: "250" }, "bad_amount"],
    ["Infinity", { ...ok, credits: Infinity }, "bad_amount"],
    ["more than the ledger can hold", { ...ok, credits: 100_000_001 }, "bad_amount"],
    ["a 7 character reason", { ...ok, reason: "too bad" }, "reason_required"],
    ["a reason of spaces", { ...ok, reason: "          " }, "reason_required"],
    ["a 301 character reason", { ...ok, reason: "x".repeat(301) }, "reason_required"],
    ["no reason", { ...ok, reason: undefined }, "reason_required"],
    ["a short key", { ...ok, key: "abc" }, "idempotency_key_required"],
    ["a key with a space", { ...ok, key: "g 0123456789abcdef" }, "idempotency_key_required"],
    ["no key", { ...ok, key: undefined }, "idempotency_key_required"],
  ])("refuses %s as %s before the database is asked", (_what, body, code) => {
    expect(parseGrant(body)).toEqual({ ok: false, error: code });
  });

  it("accepts an 8 and a 300 character reason", () => {
    expect(parseGrant({ ...ok, reason: "12345678" }).ok).toBe(true);
    expect(parseGrant({ ...ok, reason: "x".repeat(300) }).ok).toBe(true);
    expect(reasonOk("1234567")).toBe(false);
    expect(reasonOk("x".repeat(300))).toBe(true);
  });
});

describe("parseReverse", () => {
  it("passes the ledger id and the trimmed reason", () => {
    expect(parseReverse({ transactionId: 42, reason: ` ${WHY}` })).toEqual({
      ok: true,
      call: { fn: "owner_reverse_grant", args: { p_transaction_id: 42, p_reason: WHY } },
    });
  });
  it.each([
    [{ transactionId: 0, reason: WHY }, "not_a_grant"],
    [{ transactionId: 1.5, reason: WHY }, "not_a_grant"],
    [{ transactionId: "42", reason: WHY }, "not_a_grant"],
    [{ transactionId: 42, reason: "short" }, "reason_required"],
    [undefined, "bad_request"],
  ])("refuses %j as %s", (body, code) => {
    expect(parseReverse(body)).toEqual({ ok: false, error: code });
  });
});

describe("parsePrice", () => {
  it("set: the rate, margin and optional note and reason, and the confirm only when it is exactly true", () => {
    expect(parsePrice({ action: "set", unit: "usd", rate: 100, margin: 0.25, reason: " raise ", confirm: true })).toEqual({
      ok: true,
      call: {
        fn: "owner_set_credit_price",
        args: { p_unit: "usd", p_credits_per_unit: 100, p_margin: 0.25, p_note: null, p_reason: "raise", p_confirm_big_change: true },
      },
    });
    const truthy = parsePrice({ action: "set", unit: "usd", rate: 1, margin: 0, confirm: "yes" });
    expect(truthy.ok && truthy.call.args.p_confirm_big_change).toBe(false);
  });

  it("delete and restore carry the confirm and the reason", () => {
    expect(parsePrice({ action: "delete", unit: "image_generations", confirm: true })).toEqual({
      ok: true,
      call: { fn: "owner_delete_credit_price", args: { p_unit: "image_generations", p_reason: null, p_confirm_big_change: true } },
    });
    expect(parsePrice({ action: "restore", historyId: 7 })).toEqual({
      ok: true,
      call: { fn: "owner_restore_credit_price", args: { p_history_id: 7, p_reason: null, p_confirm_big_change: false } },
    });
  });

  it.each([
    [{ action: "set", unit: "Usd", rate: 1, margin: 0 }, "bad_unit"],
    [{ action: "set", unit: "1usd", rate: 1, margin: 0 }, "bad_unit"],
    [{ action: "set", unit: "usd", rate: -1, margin: 0 }, "bad_rate"],
    [{ action: "set", unit: "usd", rate: 1_000_001, margin: 0 }, "bad_rate"],
    [{ action: "set", unit: "usd", rate: "1", margin: 0 }, "bad_rate"],
    [{ action: "set", unit: "usd", rate: 1, margin: 11 }, "bad_margin"],
    [{ action: "set", unit: "usd", rate: 1, margin: -0.1 }, "bad_margin"],
    [{ action: "set", unit: "usd", rate: 1, margin: 0, note: "x".repeat(301) }, "bad_note"],
    [{ action: "set", unit: "usd", rate: 1, margin: 0, reason: 5 }, "bad_note"],
    [{ action: "delete", unit: "" }, "bad_unit"],
    [{ action: "restore", historyId: 0 }, "no_such_history"],
    [{ action: "explode", unit: "usd" }, "bad_request"],
    [null, "bad_request"],
  ])("refuses %j as %s", (body, code) => {
    expect(parsePrice(body)).toEqual({ ok: false, error: code });
  });
});

describe("parseTeam", () => {
  it("add: the address is lower-cased and trimmed", () => {
    expect(parseTeam({ action: "add", email: "  New@A.uz ", role: "editor" })).toEqual({
      ok: true,
      call: { fn: "owner_add_member", args: { p_email: "new@a.uz", p_role: "editor", p_reason: null } },
    });
  });
  it("role and remove take the member id", () => {
    expect(parseTeam({ action: "role", member: MEMBER, role: "viewer" })).toEqual({
      ok: true,
      call: { fn: "owner_set_member_role", args: { p_member: MEMBER, p_role: "viewer", p_reason: null } },
    });
    expect(parseTeam({ action: "remove", member: MEMBER })).toEqual({
      ok: true,
      call: { fn: "owner_remove_member", args: { p_member: MEMBER, p_reason: null } },
    });
  });
  it.each([
    [{ action: "add", email: "not-an-address", role: "editor" }, "bad_email"],
    [{ action: "add", email: "a@b", role: "editor" }, "bad_email"],
    [{ action: "add", email: "a@b.uz", role: "superuser" }, "bad_role"],
    [{ action: "add", email: "a@b.uz" }, "bad_role"],
    [{ action: "role", member: "1", role: "viewer" }, "no_such_member"],
    [{ action: "role", member: MEMBER, role: "root" }, "bad_role"],
    [{ action: "remove", member: undefined }, "no_such_member"],
    [{ action: "wipe", member: MEMBER }, "bad_request"],
  ])("refuses %j as %s", (body, code) => {
    expect(parseTeam(body)).toEqual({ ok: false, error: code });
  });
});

describe("ownerReplyToHttp: the database's answer as a status and a body", () => {
  it("success keeps every field and is a 200", () => {
    const out = ownerReplyToHttp({ ok: true, duplicate: false, balance: 1250, transaction_id: 9 });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, duplicate: false, balance: 1250, transaction_id: 9 });
  });

  it("a refusal keeps its code and figures but never the English sentence", () => {
    const out = ownerReplyToHttp({ ok: false, error: "daily_cap", message: "The 24 hour grant limit would be exceeded.", granted_24h: 450000, requested: 100000, cap: 500000 });
    expect(out.status).toBe(422);
    expect(out.body).toEqual({ ok: false, error: "daily_cap", granted_24h: 450000, requested: 100000, cap: 500000 });
    expect(JSON.stringify(out.body)).not.toContain("limit would be");
  });

  it.each([
    ["mfa_required", 401],
    ["rate_limited", 429],
    ["confirm_required", 409],
    ["last_owner", 422],
    ["per_call_cap", 422],
    ["bad_reply", 502],
  ])("%s is a %i", (code, status) => {
    expect(ownerReplyToHttp({ ok: false, error: code, message: "m" }).status).toBe(status);
  });

  it("confirm_required carries the old and new figures and the ratios the sheet shows", () => {
    const out = ownerReplyToHttp({
      ok: false,
      error: "confirm_required",
      message: "big",
      reason: "ratio",
      old: { credits_per_unit: 1, margin: 0 },
      new: { credits_per_unit: 5, margin: 0 },
      max_ratio: 3,
      rate_ratio: 5,
      charged_ratio: 5,
    });
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ error: "confirm_required", old: { credits_per_unit: 1 }, new: { credits_per_unit: 5 }, max_ratio: 3, rate_ratio: 5, charged_ratio: 5 });
  });

  it.each([null, undefined, "ok", 7, [], {}, { ok: "yes" }])("%j is not an answer: a 502, never a success", (data) => {
    const out = ownerReplyToHttp(data);
    expect(out.status).toBe(502);
    expect(out.body.ok).toBe(false);
  });

  it("a refusal with no code is not a success either", () => {
    expect(ownerReplyToHttp({ ok: false })).toEqual({ status: 502, body: { ok: false, error: "bad_reply" } });
  });
});

describe("ownerRpcErrorToHttp: a database error, without its text", () => {
  it.each([
    ["42501", 403, "forbidden"],
    ["PGRST202", 503, "migration_missing"],
    ["42883", 503, "migration_missing"],
    ["PGRST301", 401, "unauthorized"],
    ["XX000", 502, "rpc_failed"],
    ["", 502, "rpc_failed"],
  ])("%s is %i %s", (code, status, error) => {
    const out = ownerRpcErrorToHttp({ code, message: "relation secret_table does not exist at host db.internal" });
    expect(out).toEqual({ status, body: { ok: false, error } });
  });
});

describe("priceBigChange: the same rule as owner_price_write", () => {
  const p = (rate: number, margin = 0) => ({ rate, margin });
  it("a first price is not big (nothing to compare with)", () => {
    expect(priceBigChange(null, p(5), 3).big).toBe(false);
  });
  it("up to the limit either way is fine; past it is big, with the ratio", () => {
    expect(priceBigChange(p(1), p(3), 3).big).toBe(false);
    expect(priceBigChange(p(3), p(1), 3).big).toBe(false);
    const up = priceBigChange(p(1), p(3.01), 3);
    expect(up).toMatchObject({ big: true, reason: "ratio" });
    expect(up.rateRatio).toBeCloseTo(3.01);
    expect(priceBigChange(p(1), p(0.3), 3)).toMatchObject({ big: true, reason: "ratio" });
  });
  it("what the customer pays counts too: a markup swing alone can be big", () => {
    expect(priceBigChange(p(1, 0), p(1, 3), 3)).toMatchObject({ big: true, reason: "ratio" });
    expect(priceBigChange(p(1, 0), p(1, 1), 3).big).toBe(false);
  });
  it("zero is always big, from or to", () => {
    expect(priceBigChange(p(2), p(0), 3)).toMatchObject({ big: true, reason: "zero" });
    expect(priceBigChange(p(0), p(2), 3)).toMatchObject({ big: true, reason: "was_zero" });
    expect(priceBigChange(null, p(0), 3)).toMatchObject({ big: true, reason: "zero" });
  });
  it("a delete is always big", () => {
    expect(priceBigChange(p(2), null, 3)).toMatchObject({ big: true, reason: "delete" });
  });
  it("words a ratio the way people say it", () => {
    expect(ratioText(4)).toBe("×4");
    expect(ratioText(0.25)).toBe("×0.25");
    expect(ratioText(3.14159)).toBe("×3.14");
    expect(ratioText(null)).toBeNull();
    expect(ratioText(0)).toBeNull();
    expect(ratioText(NaN)).toBeNull();
  });
});

describe("which grants can be reversed, and what the 24 hour cap has used", () => {
  const NOW = Date.parse("2026-10-18T12:00:00Z");
  const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  const row = (id: number, over: Partial<GrantRow> = {}): GrantRow => ({
    id,
    kind: "grant",
    amount: 100,
    created_at: hoursAgo(1),
    note: "owner grant: gift",
    external_id: `owner-grant:g-${id}0000000`,
    created_by: "u1",
    ...over,
  });

  it("an owner-path grant and a manual grant_credits row count; welcome, invite and purchase rows do not", () => {
    expect(isOwnerGrant(row(1))).toBe(true);
    expect(isOwnerGrant(row(2, { external_id: null, created_by: "u1" }))).toBe(true);
    expect(isOwnerGrant(row(3, { external_id: null, created_by: null }))).toBe(false);
    expect(isOwnerGrant(row(4, { external_id: "welcome:org-1" }))).toBe(false);
    expect(isOwnerGrant(row(5, { kind: "purchase" }))).toBe(false);
    expect(isOwnerGrant(row(6, { kind: "adjust", external_id: "owner-reverse:1" }))).toBe(false);
  });

  it("finds the reversals by their external id", () => {
    expect([...reversedGrantIds([{ external_id: "owner-reverse:12" }, { external_id: "owner-reverse:abc" }, { external_id: null }, { external_id: "x:5" }])]).toEqual([12]);
  });

  it("offers only grants inside the window, newest first, and marks the reversed ones", () => {
    const rows = [row(1, { created_at: hoursAgo(24 * 20) }), row(2, { created_at: hoursAgo(24 * 13) }), row(3), row(4, { external_id: "welcome:x" })];
    const out = reversibleGrants(rows, new Set([2]), 14, NOW);
    expect(out.map((g) => [g.id, g.reversed])).toEqual([
      [3, false],
      [2, true],
    ]);
  });

  it("a grant exactly on the edge of the window is still offered; one second past is not", () => {
    const edge = new Date(NOW - 14 * 86_400_000).toISOString();
    const past = new Date(NOW - 14 * 86_400_000 - 1000).toISOString();
    expect(reversibleGrants([row(1, { created_at: edge })], new Set(), 14, NOW)).toHaveLength(1);
    expect(reversibleGrants([row(2, { created_at: past })], new Set(), 14, NOW)).toHaveLength(0);
  });

  it("sums the rolling 24 hours the way the cap does: owner and manual grants, all organizations", () => {
    const rows = [row(1, { amount: 100 }), row(2, { amount: 50, org_id: "other" }), row(3, { amount: 999, created_at: hoursAgo(25) }), row(4, { amount: 7, external_id: "welcome:x" })];
    expect(granted24h(rows, NOW)).toBe(150);
    expect(granted24h([], NOW)).toBe(0);
  });
});

describe("newIdempotencyKey", () => {
  it("is a key the database accepts, and different every time", () => {
    const keys = new Set(Array.from({ length: 20 }, newIdempotencyKey));
    expect(keys.size).toBe(20);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
  });
});
