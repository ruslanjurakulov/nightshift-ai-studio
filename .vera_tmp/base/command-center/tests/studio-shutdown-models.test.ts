/**
 * The Studio's model picker over a model past its vendor's announced shutdown date (migration 0125).
 *
 * What would break without these: the picker offering a Veo preview whose date has passed because the RLS policy on model_registry cannot call
 * model_past_shutdown (revoked from signed-in users) and a platform admin reads every row, so the person picks it and the quote refuses it;
 * and the filter failing closed on a missing migration (an empty picker for everybody) instead of leaving the list as it was.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ROWS = [
  { id: "veo-3.1", display_name: "Veo 3.1", capabilities: ["t2v"], availability: "ga", verified_at: "2026-10-01T00:00:00Z" },
  { id: "kling-v3", display_name: "Kling 3", capabilities: ["t2v"], availability: "ga", verified_at: "2026-10-01T00:00:00Z" },
  { id: "img-a", display_name: "Picture A", capabilities: ["t2i"], availability: "beta", verified_at: "2026-10-01T00:00:00Z" },
];

const h = vi.hoisted(() => ({ sellable: { data: [] as unknown, error: null as unknown } }));

async function run(): Promise<string[]> {
  vi.resetModules();
  vi.doMock("@/lib/supabase/server", () => ({
    getUser: async () => ({ id: "u1" }),
    createClient: async () => ({
      // A platform admin: the policy shows every verified row, past-shutdown ones included.
      from: () => {
        const q: Record<string, unknown> = {
          select: () => q,
          in: () => q,
          not: () => q,
          order: () => q,
          limit: () => Promise.resolve({ data: ROWS, error: null }),
        };
        return q;
      },
      rpc: async (fn: string) => {
        if (fn === "sellable_models") return h.sellable;
        return { data: [], error: null }; // models_switched_off: nothing is switched off
      },
    }),
  }));
  vi.doMock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: null }) }));
  const mod = await import("../lib/server/creative");
  return (await mod.loadStudioModels()).map((m) => m.id);
}

describe("loadStudioModels and a vendor-announced shutdown", () => {
  beforeEach(() => {
    h.sellable = { data: [], error: null };
  });

  it("drops a model sellable_models() does not list, so a model past its date is never offered", async () => {
    h.sellable = { data: [{ id: "kling-v3", spec: {} }, { id: "img-a", spec: {} }], error: null };
    expect(await run()).toEqual(["kling-v3", "img-a"]);
  });

  it("keeps every model it lists, in the policy's order", async () => {
    h.sellable = { data: ROWS.map((r) => ({ id: r.id })), error: null };
    expect(await run()).toEqual(["veo-3.1", "kling-v3", "img-a"]);
  });

  it("when it lists nothing, the picker is empty: nothing is sellable, not 'show everything'", async () => {
    h.sellable = { data: [], error: null };
    expect(await run()).toEqual([]);
  });

  it("when the call failed or answered something that is not a list, the list is what it was", async () => {
    h.sellable = { data: null, error: { code: "PGRST202", message: "could not find the function" } };
    expect(await run()).toEqual(["veo-3.1", "kling-v3", "img-a"]);
    h.sellable = { data: { not: "a list" }, error: null };
    expect(await run()).toEqual(["veo-3.1", "kling-v3", "img-a"]);
  });
});
