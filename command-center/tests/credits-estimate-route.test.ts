import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY, FAILED, NO_ROW, supabaseStub, type StubResult } from "./helpers/supabaseStub";

/**
 * GET /api/credits/estimate (CLAUDE.md #5): a failed read is a retryable 503,
 * never `supported: false` (which hides the estimate line as "not enabled"), a
 * "price list gap" or a balance of 0. Genuinely empty / missing data keeps its
 * honest answer. The client half is in read-failures-client.test.ts.
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => h.client,
  getUser: async () => ({ id: "u1", email: "me@example.com" }),
}));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => ({ ok: true }) }));

const { GET } = await import("../app/api/credits/estimate/route");

const ORG = "0a000000-0000-0000-0000-00000000000a";
const PRICES: StubResult = {
  data: [
    { unit: "video_minute", credits_per_unit: 12, margin: 0 },
    { unit: "job_minimum", credits_per_unit: 5, margin: 0 },
  ],
  error: null,
};
const CHANNEL: StubResult = { data: { org_id: ORG, agent_config: { target_duration_seconds: 180 } }, error: null };
const ACCOUNT: StubResult = { data: { balance: 500, reserved: 100 }, error: null };

function setup(over: Record<string, StubResult> = {}) {
  const tables: Record<string, StubResult> = {
    channels: CHANNEL,
    credit_prices: PRICES,
    video_costs: EMPTY,
    credit_accounts: ACCOUNT,
    ...over,
  };
  // The price list as charged (credit_rates(), 0084) answers what the table would.
  tables.credit_rates = over.credit_rates ?? tables.credit_prices;
  h.client = supabaseStub((name) => tables[name] ?? EMPTY);
}

const call = async () => {
  const res = await GET(new Request("http://x/api/credits/estimate?channel=ch-a"));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  h.client = null;
});

describe("estimate route: a failed read is an error status, not 'unsupported' or a gap", () => {
  const readFailed = { status: 503, body: { error: "credits_read_failed" } };

  it("healthy baseline: a number and the real balance", async () => {
    setup();
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ supported: true, available: 400, balanceFailed: false });
    expect((r.body.estimate as { credits: number }).credits).toBe(36); // 3 minutes at 12 credits a minute
  });

  it("failed channel read -> 503, not supported:false", async () => {
    setup({ channels: FAILED });
    expect(await call()).toEqual(readFailed);
  });

  it("control: a channel that reads fine but is not there keeps supported:false", async () => {
    setup({ channels: NO_ROW });
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ supported: false });
  });

  it("failed price-list read -> 503, not supported:true with a 'price gap'", async () => {
    setup({ credit_prices: FAILED });
    expect(await call()).toEqual(readFailed);
  });

  it("control: an empty price list that reads fine is still the no_prices gap", async () => {
    setup({ credit_prices: EMPTY });
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ supported: true, estimate: { credits: null, gap: "no_prices" } });
  });

  it("control: migration 0020 missing (table does not exist) stays supported:false", async () => {
    setup({ credit_prices: { data: null, error: { code: "42P01", message: "relation does not exist" } } });
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ supported: false });
  });

  it("failed ledger read -> 503, not an estimate from a different basis", async () => {
    setup({ video_costs: FAILED });
    expect(await call()).toEqual(readFailed);
  });

  it("failed balance read -> estimate kept, balance UNKNOWN (null) and flagged, not 0", async () => {
    setup({ credit_accounts: FAILED });
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.available).toBeNull();
    expect(r.body.balanceFailed).toBe(true);
    expect((r.body.estimate as { credits: number | null }).credits).not.toBeNull();
  });

  it("control: an organization with no account row really has 0 available", async () => {
    setup({ credit_accounts: NO_ROW });
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ available: 0, balanceFailed: false });
  });
});
