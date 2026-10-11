import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HANDLE_META_KEY,
  RESERVED_HANDLES,
  applyPendingHandle,
  checkHandleFormat,
  handleAllowsSubmit,
  isReservedHandle,
  nextHandleChange,
  normalizeHandleInput,
  parseAvailability,
  parseSetHandle,
  pendingHandleFrom,
  type HandleClient,
} from "@/lib/handles";

describe("normalizeHandleInput", () => {
  it("trims, drops one leading @ and lowercases", () => {
    expect(normalizeHandleInput("  @Ana.K ")).toBe("ana.k");
    expect(normalizeHandleInput("@@ana")).toBe("@ana");
    expect(normalizeHandleInput("")).toBe("");
  });
});

describe("checkHandleFormat (mirrors handle_format_ok in 0096)", () => {
  it.each(["abc", "ana.k", "ana_k", "a1b2c3", "_ab", "ab_", "123", "a".repeat(30), "x.y.z", "ana__k"])("accepts %s", (h) => {
    expect(checkHandleFormat(h)).toBeNull();
  });
  it.each([
    ["", "too_short"],
    ["ab", "too_short"],
    ["a".repeat(31), "too_long"],
    ["Ana", "characters"],
    ["a b", "characters"],
    ["a-b", "characters"],
    ["ана", "characters"],
    [".ab", "dots"],
    ["ab.", "dots"],
    ["a..b", "dots"],
    ["___", "no_letter"],
    ["_._", "no_letter"],
  ])("%j -> %s", (h, problem) => {
    expect(checkHandleFormat(h as string)).toBe(problem);
  });
});

describe("isReservedHandle (mirrors handle_reserved in 0096)", () => {
  it.each(["admin", "administrator", "root", "support", "help", "billing", "api", "mcp", "nightshift", "security", "system", "staff", "moderator", "null", "undefined", "login", "signup"])(
    "%s is reserved",
    (h) => expect(isReservedHandle(h)).toBe(true),
  );
  it.each(["nightshift_team", "nightshift.support", "nightshifts", "nightshift99"])("anything starting with nightshift (%s)", (h) =>
    expect(isReservedHandle(h)).toBe(true),
  );
  it.each(["a.d.m.i.n", "su_pport", "bil.ling", "ad__min"])("dots and underscores do not hide a reserved word (%s)", (h) =>
    expect(isReservedHandle(h)).toBe(true),
  );
  it("lets ordinary names through", () => {
    for (const h of ["ana.k", "maria_92", "adminton", "night.owl", "shift"]) expect(isReservedHandle(h)).toBe(false);
  });

  it("is the same list the migration carries (they cannot drift)", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "0096_user_handles.sql"), "utf8");
    const body = /array\[([\s\S]*?)\]\)/.exec(sql)![1];
    const inSql = [...body.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect([...RESERVED_HANDLES].sort()).toEqual([...inSql].sort());
    expect(sql).toContain("like 'nightshift%'");
  });
});

describe("availability and set_handle answers", () => {
  it("true is available, false is taken, anything else is unknown", () => {
    expect(parseAvailability(true)).toBe("available");
    expect(parseAvailability(false)).toBe("taken");
    for (const v of [null, undefined, "true", 1, {}]) expect(parseAvailability(v)).toBe("unknown");
  });

  it("only an available or an unknown check lets the form go on", () => {
    expect(handleAllowsSubmit({ kind: "available" })).toBe(true);
    expect(handleAllowsSubmit({ kind: "unknown" })).toBe(true);
    for (const kind of ["idle", "checking", "taken", "same"] as const) expect(handleAllowsSubmit({ kind })).toBe(false);
    expect(handleAllowsSubmit({ kind: "rule", problem: "dots" })).toBe(false);
  });

  it("reads set_handle's codes and drops everything it does not know", () => {
    expect(parseSetHandle({ code: "ok", handle: "ana.k" })).toEqual({ code: "ok", handle: "ana.k", nextChangeAt: undefined });
    expect(parseSetHandle({ code: "cooldown", next_change_at: "2026-11-01T00:00:00Z" })).toMatchObject({ code: "cooldown", nextChangeAt: "2026-11-01T00:00:00Z" });
    for (const code of ["same", "invalid", "taken", "rate_limited"]) expect(parseSetHandle({ code }).code).toBe(code);
    for (const bad of [null, undefined, "ok", 3, {}, { code: "boom" }, { code: "42501" }]) expect(parseSetHandle(bad)).toEqual({ code: "failed" });
  });
});

describe("nextHandleChange", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  it("the first set is free: changed_at equals created_at", () => {
    expect(nextHandleChange({ created_at: "2026-10-10T00:00:00Z", changed_at: "2026-10-10T00:00:00Z" }, now)).toBeNull();
  });
  it("a change starts 30 days", () => {
    const due = nextHandleChange({ created_at: "2026-09-01T00:00:00Z", changed_at: "2026-10-01T00:00:00Z" }, now);
    expect(due?.toISOString()).toBe("2026-10-31T00:00:00.000Z");
  });
  it("after 30 days it is free again; no row, or unreadable dates, is free", () => {
    expect(nextHandleChange({ created_at: "2026-07-01T00:00:00Z", changed_at: "2026-08-01T00:00:00Z" }, now)).toBeNull();
    expect(nextHandleChange(null, now)).toBeNull();
    expect(nextHandleChange({ created_at: "x", changed_at: "y" }, now)).toBeNull();
  });
});

describe("the handle chosen at sign-up", () => {
  it("reads a well-formed one from the metadata, normalized", () => {
    expect(pendingHandleFrom({ [HANDLE_META_KEY]: "@Ana.K" })).toBe("ana.k");
  });
  it("ignores anything that is not a valid, unreserved handle", () => {
    for (const v of ["admin", "a..b", 7, null, "", "nightshift_x"]) expect(pendingHandleFrom({ [HANDLE_META_KEY]: v })).toBeNull();
    expect(pendingHandleFrom(null)).toBeNull();
    expect(pendingHandleFrom("x")).toBeNull();
  });

  function client(over: { meta?: unknown; own?: unknown; rpc?: unknown; rpcError?: boolean } = {}) {
    const rpc = vi.fn(async () => ({ data: over.rpc ?? { code: "ok", handle: "ana.k" }, error: over.rpcError ? { code: "x" } : null }));
    const c: HandleClient = {
      auth: { getUser: async () => ({ data: { user: { user_metadata: over.meta ?? { [HANDLE_META_KEY]: "ana.k" } } } }) },
      rpc,
      from: () => ({ select: () => ({ maybeSingle: async () => ({ data: over.own ?? null, error: null }) }) }),
    };
    return { c, rpc };
  }

  it("applies it once through set_handle", async () => {
    const { c, rpc } = client();
    expect(await applyPendingHandle(c)).toBe("applied");
    expect(rpc).toHaveBeenCalledWith("set_handle", { p_handle: "ana.k" });
  });
  it("leaves a person who already has a handle alone", async () => {
    const { c, rpc } = client({ own: { handle: "ana.k" } });
    expect(await applyPendingHandle(c)).toBe("none");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("does nothing without a chosen handle", async () => {
    const { c, rpc } = client({ meta: {} });
    expect(await applyPendingHandle(c)).toBe("none");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a name taken meanwhile is reported, not thrown, and costs nothing", async () => {
    expect(await applyPendingHandle(client({ rpc: { code: "taken" } }).c)).toBe("taken");
    expect(await applyPendingHandle(client({ rpcError: true }).c)).toBe("failed");
  });
  it("never throws, whatever the client does", async () => {
    const broken = { auth: { getUser: async () => { throw new Error("boom"); } } } as unknown as HandleClient;
    expect(await applyPendingHandle(broken)).toBe("failed");
  });
});
