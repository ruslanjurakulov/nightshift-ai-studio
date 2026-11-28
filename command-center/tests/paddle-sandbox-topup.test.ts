import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The API-balance top-up (Developer console → Add funds) while Paddle is the
 * SANDBOX on a production database. What would break without this: any
 * workspace owner opens a sandbox checkout, pays with Paddle's public test
 * card, and a sandbox-mode webhook either refuses it (a "payment" that never
 * arrives) or, before PADDLE_WEBHOOK_ENV existed, credited real API balance.
 * Only PADDLE_TEST_ORG_IDS may be offered a sandbox checkout. Nothing here
 * calls Paddle: the transaction call is a spy.
 */

vi.mock("server-only", () => ({}));

const TEST_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CUSTOMER_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const h = vi.hoisted(() => ({
  environment: "sandbox" as "sandbox" | "production",
  created: [] as unknown[],
}));

vi.mock("@/lib/paddle", async (orig) => ({
  ...(await orig<typeof import("@/lib/paddle")>()),
  get paddleClient() {
    return { environment: h.environment, clientToken: h.environment === "sandbox" ? "test_0123456789abcdef" : "live_0123456789abcdef" };
  },
}));
vi.mock("@/lib/server/paddle-api", () => ({
  paddleApi: { apiKey: "k", productId: "pro_01apitopup00000000000000", baseUrl: "https://sandbox-api.paddle.com" },
  createTopupTransaction: async (_cfg: unknown, body: unknown) => {
    h.created.push(body);
    return { ok: true, id: "txn_01h000000000000000000000aa" };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => ({ id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" }),
  createClient: async () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { activated_at: "2026-01-01T00:00:00Z" }, error: null }) };
    return { from: () => q };
  },
}));
vi.mock("@/lib/auth/org-roles", () => ({ requireOrgRole: async () => ({ ok: true, role: "owner" }) }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => {} }));

const topup = await import("../app/api/developers/topup/route");

const add = (orgId: string) =>
  topup.POST(
    new Request("http://test.local/api/developers/topup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://test.local" },
      body: JSON.stringify({ org_id: orgId, amount_cents: 2500 }),
    }),
  );

beforeEach(() => {
  h.environment = "sandbox";
  h.created = [];
  vi.stubEnv("PAYMENTS_PROVIDER", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("API top-up checkout, Paddle sandbox", () => {
  it("refuses a workspace that is not in PADDLE_TEST_ORG_IDS before any Paddle transaction is created", async () => {
    vi.stubEnv("PADDLE_TEST_ORG_IDS", TEST_ORG);
    const res = await add(CUSTOMER_ORG);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "test_mode_only" });
    expect(h.created).toHaveLength(0);
  });

  it("with no list at all, nobody is sold a sandbox top-up", async () => {
    expect((await add(TEST_ORG)).status).toBe(403);
    expect(h.created).toHaveLength(0);
  });

  it("an allow-listed test workspace gets its transaction", async () => {
    vi.stubEnv("PADDLE_TEST_ORG_IDS", TEST_ORG.toUpperCase());
    const res = await add(TEST_ORG);
    expect(res.status).toBe(200);
    expect(h.created).toHaveLength(1);
  });

  it("production sells to every workspace, list or no list", async () => {
    h.environment = "production";
    expect((await add(CUSTOMER_ORG)).status).toBe(200);
    expect(h.created).toHaveLength(1);
  });
});
