import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which Paddle settings the Studio's plan dialog gets (lib/server/upsell.ts). The sandbox allow-list (PADDLE_TEST_ORG_IDS)
 * is Paddle's own rule: under Dodo the dialog must keep main's behaviour (the Paddle settings as they are), or switching the
 * provider would quietly take the dialog's plans away from every organization that is not on a Paddle test list.
 */

const state = vi.hoisted(() => ({ provider: "paddle" as "paddle" | "dodo", seen: [] as unknown[] }));
const SANDBOX = vi.hoisted(() => ({ environment: "sandbox", clientToken: "test_visualqafake0000" }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/server/plans", () => ({
  readPlanCatalog: async () => ({ state: "ok", value: { plans: [] } }),
  readBillingSummary: async () => ({ state: "ok", value: null }),
}));
vi.mock("@/lib/paddle", () => ({ paddleClient: SANDBOX }));
vi.mock("@/lib/server/payments", () => ({
  paymentsProvider: () => state.provider,
  // Paddle's sandbox rule: this organization is not on the test list.
  paddleClientFor: () => null,
}));
vi.mock("@/lib/upsell", () => ({
  upsellCatalog: (...args: unknown[]) => {
    state.seen.push(args[4]);
    return { plans: null };
  },
}));

import { loadUpsellCatalog } from "@/lib/server/upsell";

const ORG = "0a000000-0000-4000-8000-00000000000a";

beforeEach(() => {
  state.seen = [];
});

describe("the plan dialog's Paddle settings", () => {
  it("with Paddle: an organization a sandbox may not sell to gets none (the allow-list applies)", async () => {
    state.provider = "paddle";
    await loadUpsellCatalog(ORG);
    expect(state.seen).toEqual([null]);
  });

  it("with Dodo: main's behaviour, the Paddle settings as they are, whatever the Paddle test list says", async () => {
    state.provider = "dodo";
    await loadUpsellCatalog(ORG);
    expect(state.seen).toEqual([SANDBOX]);
  });
});
