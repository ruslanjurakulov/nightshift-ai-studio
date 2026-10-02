import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BR-L-101: the signed-out plan-catalog read on / and /pricing was bounded but
 * not kept or shared: 30 visitors made 120 backend calls. BR-L-100: when that
 * read failed, the pages said top-up credits "do not expire".
 */
const backend = vi.hoisted(() => ({ calls: 0, fail: false, policiesFail: false, policy: 12 as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@supabase/supabase-js", () => {
  const rows: Record<string, unknown[]> = {
    plans: [],
    entitlement_keys: [],
    plan_entitlements: [],
  };
  const query = (table: string) => {
    const q = {
      select: () => q,
      order: () => q,
      abortSignal: () => q,
      then: (resolve: (v: unknown) => void) =>
        resolve(
          backend.fail || (backend.policiesFail && table === "credit_lot_policies")
            ? { data: null, error: { code: "57014", message: "canceling statement" } }
            : { data: table === "credit_lot_policies" ? [{ source: "pack", valid_months: backend.policy }] : rows[table], error: null },
        ),
    };
    return q;
  };
  return { createClient: () => ({ from: (t: string) => (backend.calls++, query(t)) }) };
});

const { readPublicPlanCatalog } = await import("@/lib/server/public-catalog");
const { FAIL_TTL_MS, OK_TTL_MS, resetPublicReads } = await import("@/lib/server/public-read");
const { packExpiry } = await import("@/lib/plans");

beforeEach(() => {
  resetPublicReads();
  backend.calls = 0;
  backend.fail = false;
  backend.policiesFail = false;
  backend.policy = 12;
  vi.useRealTimers();
});

describe("the signed-out plan catalog", () => {
  it("is read once for many visitors: kept and shared like the price lists", async () => {
    const reads = await Promise.all(Array.from({ length: 30 }, () => readPublicPlanCatalog()));
    await readPublicPlanCatalog();
    expect(reads.every((r) => r.state === "ok")).toBe(true);
    expect(backend.calls).toBe(4); // one read = its four tables, for 31 visitors
  });

  it("a failed read is 'failed' (the pages say so), never an empty catalog", async () => {
    backend.fail = true;
    expect((await readPublicPlanCatalog()).state).toBe("failed");
  });
});

describe("pack expiry as a page may state it (BR-L-100)", () => {
  it("is the catalog's policy when it was read", () => {
    expect(packExpiry({ state: "ok", value: { packValidMonths: 12 } }, null)).toEqual({ kind: "months", months: 12 });
    expect(packExpiry({ state: "ok", value: { packValidMonths: null } }, 6)).toEqual({ kind: "never" });
  });

  it("is the operator's env when the catalog has no policy or could not be read", () => {
    expect(packExpiry({ state: "ok", value: {} }, 6)).toEqual({ kind: "months", months: 6 });
    expect(packExpiry({ state: "failed" }, 6)).toEqual({ kind: "months", months: 6 });
  });

  it("is unknown — never 'do not expire' — when the read failed and the env is empty", () => {
    expect(packExpiry({ state: "failed" }, null)).toEqual({ kind: "unknown" });
  });

  it("is 'never' only where nothing could expire credits: no catalog at all and an empty env", () => {
    expect(packExpiry(null, null)).toEqual({ kind: "never" });
    expect(packExpiry({ state: "unsupported" }, null)).toEqual({ kind: "never" });
  });
});

describe("a partial catalog read (BR-L-131)", () => {
  it("only the policy query failed: the expiry is unknown, never 'do not expire'", async () => {
    backend.policiesFail = true;
    const read = await readPublicPlanCatalog();
    expect(read.state).toBe("ok");
    expect(packExpiry(read, null)).toEqual({ kind: "unknown" });
    // The operator's own env may still state the term.
    expect(packExpiry(read, 6)).toEqual({ kind: "months", months: 6 });
  });

  it.each([0, 500, "twelve", 1.5])("a pack row with valid_months = %s is unknown, not 'never'", async (bad) => {
    backend.policy = bad;
    expect(packExpiry(await readPublicPlanCatalog(), null)).toEqual({ kind: "unknown" });
  });

  it("a null term is still a real 'never'", async () => {
    backend.policy = null;
    expect(packExpiry(await readPublicPlanCatalog(), null)).toEqual({ kind: "never" });
  });

  it("such a degraded read is kept only as long as a failure, so the gap is retried soon", async () => {
    vi.useFakeTimers();
    backend.policiesFail = true;
    await readPublicPlanCatalog();
    const after = backend.calls;
    backend.policiesFail = false;
    await vi.advanceTimersByTimeAsync(FAIL_TTL_MS + 1);
    const read = await readPublicPlanCatalog();
    expect(backend.calls).toBeGreaterThan(after);
    expect(packExpiry(read, null)).toEqual({ kind: "months", months: 12 });
    expect(FAIL_TTL_MS).toBeLessThan(OK_TTL_MS);
  });
});
