import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/owner/*: the routes behind NIGHTSHIFT_OWNER_RPC.
 *
 * What would break without these: the routes answering while the flag is off (the legacy path is supposed to be
 * the only one), a request from another site reaching the session, a customer or a signed-out caller reaching the
 * database function, a call made with anything but the signed-in user's own client, a malformed body reaching
 * Postgres, a refusal read as success, and the database's own error text leaking to the browser.
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "owner@a.uz" } as { id: string; email: string } | null,
  role: "owner" as string | null,
  guard: null as Response | null,
  rpc: vi.fn(),
  /** credit_price_history rows the restore check reads; `error` makes every read fail. */
  history: [{ id: 5, unit: "usd" }] as { id: number; unit: string }[],
  historyError: null as { code: string; message: string } | null,
  reads: [] as string[],
  client: true,
}));

/** A query builder over h.history: .eq(col, v) filters, .maybeSingle() / awaiting after .order().limit() resolve. */
function fakeFrom(table: string) {
  let rows = h.history;
  let one = false;
  let top = false;
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (col: string, v: unknown) => {
      rows = rows.filter((r) => (r as Record<string, unknown>)[col] === v);
      return q;
    },
    order: () => {
      top = true;
      return q;
    },
    limit: () => q,
    maybeSingle: () => {
      one = true;
      return q;
    },
    then: (res: (v: unknown) => unknown) => {
      h.reads.push(table);
      if (h.historyError) return Promise.resolve({ data: null, error: h.historyError }).then(res);
      const sorted = top ? [...rows].sort((a, b) => b.id - a.id) : rows;
      return Promise.resolve({ data: one ? (sorted[0] ?? null) : sorted.slice(0, 1), error: null }).then(res);
    },
  };
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => (h.client ? { rpc: h.rpc, from: fakeFrom } : null),
}));
vi.mock("@/lib/auth/roles", () => ({ requireRole: async () => h.role }));
vi.mock("@/lib/server/admin-post-guard", () => ({ guardAdminPost: async () => h.guard }));

const grant = (await import("../app/api/owner/credits/grant/route")).POST;
const reverse = (await import("../app/api/owner/credits/reverse/route")).POST;
const prices = (await import("../app/api/owner/prices/route")).POST;
const team = (await import("../app/api/owner/team/route")).POST;

const ORIGIN = "https://app.test";
const ORG = "0b000000-0000-0000-0000-00000000000b";
const MEMBER = "11111111-2222-3333-4444-555555555555";

const post = (path: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
  new Request(`${ORIGIN}/api/owner/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const GRANT = { org: ORG, credits: 250, reason: "welcome gift for the pilot", key: "g-0123456789abcdef" };
const ROUTES = [
  ["credits/grant", grant, GRANT],
  ["credits/reverse", reverse, { transactionId: 42, reason: "given by mistake, twice" }],
  ["prices", prices, { action: "set", unit: "usd", rate: 100, margin: 0.25 }],
  ["team", team, { action: "remove", member: MEMBER }],
] as const;

beforeEach(() => {
  vi.unstubAllEnvs();
  h.user = { id: "u1", email: "owner@a.uz" };
  h.role = "owner";
  h.guard = null;
  h.client = true;
  h.rpc.mockReset().mockResolvedValue({ data: { ok: true }, error: null });
  h.history = [{ id: 5, unit: "usd" }];
  h.historyError = null;
  h.reads = [];
});

describe("with the flag off (the default) the routes do not exist", () => {
  it.each(ROUTES)("%s answers 404 and never touches the database", async (path, handler, body) => {
    for (const value of [undefined, "", "off", "0", "true", "1"]) {
      vi.stubEnv("NIGHTSHIFT_OWNER_RPC", value ?? "");
      const res = await handler(post(path, body));
      expect(res.status, `flag ${JSON.stringify(value)}`).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("an unset variable is off too", async () => {
    delete process.env.NIGHTSHIFT_OWNER_RPC;
    expect((await grant(post("credits/grant", GRANT))).status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("with the flag on", () => {
  beforeEach(() => vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on"));

  it.each(ROUTES)("%s: a request from another site is refused before the session is read", async (path, handler, body) => {
    for (const headers of [{}, { origin: "https://evil.example" }, { origin: "null" }, { origin: ORIGIN, "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const res = await handler(post(path, body, headers));
      expect(res.status).toBe(403);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each(ROUTES)("%s: signed out is 401, not an owner/admin is 403, the app second-factor gate is its own answer", async (path, handler, body) => {
    h.user = null;
    expect((await handler(post(path, body))).status).toBe(401);
    h.user = { id: "u2", email: "customer@a.uz" };
    h.role = null;
    expect((await handler(post(path, body))).status).toBe(403);
    h.role = "owner";
    h.guard = Response.json({ error: "mfa_required" }, { status: 401 });
    const res = await handler(post(path, body));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "mfa_required" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each(ROUTES)("%s: a body that is not JSON or not the right shape is a 400 and never reaches the database", async (path, handler) => {
    expect((await handler(post(path, "{not json"))).status).toBe(400);
    expect((await handler(post(path, "[]"))).status).toBe(400);
    expect((await handler(post(path, {}))).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("grant: exactly owner_grant_credits, with the four named arguments, as the signed-in user's client", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, duplicate: false, balance: 1250, credits: 250, transaction_id: 9 }, error: null });
    const res = await grant(post("credits/grant", GRANT));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, duplicate: false, balance: 1250, credits: 250, transaction_id: 9 });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("owner_grant_credits", {
      p_org: ORG,
      p_credits: 250,
      p_reason: "welcome gift for the pilot",
      p_idempotency_key: "g-0123456789abcdef",
    });
  });

  it("grant: an extra field in the body is dropped, never forwarded", async () => {
    await grant(post("credits/grant", { ...GRANT, p_org: "someone-else", is_admin: true, service_key: "x" }));
    expect(Object.keys(h.rpc.mock.calls[0][1]).sort()).toEqual(["p_credits", "p_idempotency_key", "p_org", "p_reason"]);
    expect(h.rpc.mock.calls[0][1].p_org).toBe(ORG);
  });

  it("reverse, prices and team call their own function with their own arguments", async () => {
    await reverse(post("credits/reverse", { transactionId: 42, reason: "given by mistake, twice" }));
    expect(h.rpc).toHaveBeenLastCalledWith("owner_reverse_grant", { p_transaction_id: 42, p_reason: "given by mistake, twice" });
    await prices(post("prices", { action: "set", unit: "usd", rate: 100, margin: 0.25, confirm: true }));
    expect(h.rpc).toHaveBeenLastCalledWith("owner_set_credit_price", { p_unit: "usd", p_credits_per_unit: 100, p_margin: 0.25, p_note: null, p_reason: null, p_confirm_big_change: true });
    await prices(post("prices", { action: "delete", unit: "usd", confirm: true }));
    expect(h.rpc).toHaveBeenLastCalledWith("owner_delete_credit_price", { p_unit: "usd", p_reason: null, p_confirm_big_change: true });
    await prices(post("prices", { action: "restore", historyId: 5 }));
    expect(h.rpc).toHaveBeenLastCalledWith("owner_restore_credit_price", { p_history_id: 5, p_reason: null, p_confirm_big_change: false });
    await team(post("team", { action: "add", email: "New@A.uz", role: "editor" }));
    expect(h.rpc).toHaveBeenLastCalledWith("owner_add_member", { p_email: "new@a.uz", p_role: "editor", p_reason: null });
    await team(post("team", { action: "role", member: MEMBER, role: "viewer" }));
    expect(h.rpc).toHaveBeenLastCalledWith("owner_set_member_role", { p_member: MEMBER, p_role: "viewer", p_reason: null });
    await team(post("team", { action: "remove", member: MEMBER }));
    expect(h.rpc).toHaveBeenLastCalledWith("owner_remove_member", { p_member: MEMBER, p_reason: null });
  });

  describe("every refusal of the database reaches the browser as a code with its figures", () => {
    it.each([
      ["mfa_required", 401],
      ["rate_limited", 429],
      ["per_call_cap", 422],
      ["daily_cap", 422],
      ["key_reused", 422],
      ["last_owner", 422],
      ["self_change", 422],
      ["owner_required", 422],
      ["already_member", 422],
      ["not_reversible", 422],
      ["too_old", 422],
    ])("%s", async (code, status) => {
      h.rpc.mockResolvedValue({ data: { ok: false, error: code, message: "English sentence from the database", cap: 100000, requested: 250000 }, error: null });
      const res = await grant(post("credits/grant", GRANT));
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body).toMatchObject({ ok: false, error: code, cap: 100000, requested: 250000 });
      expect(JSON.stringify(body)).not.toContain("English sentence");
    });

    it("confirm_required is a 409 with the old and new figures", async () => {
      h.rpc.mockResolvedValue({
        data: { ok: false, error: "confirm_required", message: "x", reason: "ratio", old: { credits_per_unit: 1, margin: 0 }, new: { credits_per_unit: 5, margin: 0 }, max_ratio: 3, rate_ratio: 5, charged_ratio: 5 },
        error: null,
      });
      const res = await prices(post("prices", { action: "set", unit: "usd", rate: 5, margin: 0 }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "confirm_required", old: { credits_per_unit: 1 }, new: { credits_per_unit: 5 }, rate_ratio: 5 });
    });
  });

  describe("a database error is an answer, never the database's own text", () => {
    it.each([
      [{ code: "42501", message: "only a platform owner or admin may do this" }, 403, "forbidden"],
      [{ code: "PGRST202", message: "Could not find the function public.owner_grant_credits" }, 503, "migration_missing"],
      [{ code: "XX000", message: "connection to db.internal.example:5432 refused" }, 502, "rpc_failed"],
    ])("%j", async (error, status, code) => {
      h.rpc.mockResolvedValue({ data: null, error });
      const res = await grant(post("credits/grant", GRANT));
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ ok: false, error: code });
      expect(text).not.toContain("internal");
      expect(text).not.toContain("platform owner");
    });

    it("a thrown error, an answer that is not a document and no client at all", async () => {
      h.rpc.mockRejectedValue(new Error("socket hang up"));
      expect((await grant(post("credits/grant", GRANT))).status).toBe(502);
      h.rpc.mockReset().mockResolvedValue({ data: "ok", error: null });
      const res = await grant(post("credits/grant", GRANT));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: "bad_reply" });
      h.client = false;
      expect((await grant(post("credits/grant", GRANT))).status).toBe(503);
    });
  });
});

describe("Restore refuses a row that is no longer the newest change of its service", () => {
  beforeEach(() => vi.stubEnv("NIGHTSHIFT_OWNER_RPC", "on"));
  const restore = (id: number) => prices(post("prices", { action: "restore", historyId: id }));

  it("the newest row goes through to the function", async () => {
    h.history = [{ id: 5, unit: "usd" }, { id: 4, unit: "usd" }, { id: 9, unit: "image_generations" }];
    const res = await restore(5);
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("owner_restore_credit_price", { p_history_id: 5, p_reason: null, p_confirm_big_change: false });
  });

  it("an older row is 409 price_changed, and the function is never called", async () => {
    h.history = [{ id: 7, unit: "usd" }, { id: 5, unit: "usd" }];
    const res = await restore(5);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "price_changed" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("another service's newer change does not matter", async () => {
    h.history = [{ id: 8, unit: "other" }, { id: 5, unit: "usd" }];
    expect((await restore(5)).status).toBe(200);
  });

  it("a row that does not exist is left to the function to name (no_such_history)", async () => {
    h.history = [];
    h.rpc.mockResolvedValue({ data: { ok: false, error: "no_such_history", message: "x" }, error: null });
    const res = await restore(99);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "no_such_history" });
  });

  it("a history read that fails refuses (no guess) and the function is never called", async () => {
    h.historyError = { code: "XX000", message: "boom" };
    const res = await restore(5);
    expect(res.status).toBe(502);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("only Restore reads the history: set and delete do not", async () => {
    await prices(post("prices", { action: "set", unit: "usd", rate: 1, margin: 0 }));
    await prices(post("prices", { action: "delete", unit: "usd", confirm: true }));
    expect(h.reads).toEqual([]);
  });
});

describe("the owner path never holds a service key", () => {
  it("the server helper, the routes and the readers name no service key and no service-role client", () => {
    const root = join(__dirname, "..");
    for (const file of ["lib/server/owner-rpc.ts", "lib/server/owner-reads.ts", "lib/owner-rpc.ts", "app/api/owner/credits/grant/route.ts", "app/api/owner/credits/reverse/route.ts", "app/api/owner/prices/route.ts", "app/api/owner/team/route.ts"]) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src, file).not.toMatch(/SERVICE_KEY|SERVICE_ROLE|service_role|serviceKey|createServiceClient/i);
    }
  });
});
