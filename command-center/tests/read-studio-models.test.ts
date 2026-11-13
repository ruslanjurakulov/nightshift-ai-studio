/**
 * readStudioModels (lib/server/creative.ts), the real function: the tool-availability marks depend on it telling "could not read"
 * (null) from "read, nothing on sale" ([]). What would break without this: a registry error drawn as "Not available yet" on every tool
 * (rule 5), or an empty registry drawn as unknown (every tool linked to a form with nothing to pick). loadStudioModels keeps its
 * old contract: [] either way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Result = { data: unknown; error: unknown };
const state: { client: unknown; registry: Result; sellable: Result } = {
  client: null,
  registry: { data: [], error: null },
  sellable: { data: [], error: null },
};
function query(result: () => Result) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "in", "not", "order", "limit", "eq"]) q[m] = () => q;
  q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
  return q;
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.client,
  getUser: async () => ({ id: "u1" }),
}));
vi.mock("@/lib/server/model-switch", () => ({ readSwitchedOffIds: async () => [] }));
vi.mock("@/lib/server/geo", () => ({ hideBlockedModelsHere: async <T,>(m: T[]) => m }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: null }) }));

const { readStudioModels, loadStudioModels } = await import("../lib/server/creative");

const row = { id: "pic", display_name: "Pic", capabilities: ["t2i"], availability: "ga", verified_at: "2026-10-01T00:00:00Z" };

beforeEach(() => {
  state.registry = { data: [], error: null };
  state.sellable = { data: [], error: null };
  state.client = {
    from: () => query(() => state.registry),
    rpc: (fn: string) => query(() => (fn === "sellable_models" ? state.sellable : { data: [], error: null })),
  };
});

describe("readStudioModels", () => {
  it("is null when model_registry cannot be read, and when there is no client", async () => {
    state.registry = { data: null, error: { code: "XX000", message: "boom" } };
    expect(await readStudioModels()).toBeNull();
    expect(await loadStudioModels()).toEqual([]);
    state.client = null;
    expect(await readStudioModels()).toBeNull();
  });

  it("is [] when the read worked and nothing is on sale", async () => {
    expect(await readStudioModels()).toEqual([]);
  });

  it("keeps only what sellable_models() lists once it answers", async () => {
    state.registry = { data: [row, { ...row, id: "gone" }], error: null };
    state.sellable = { data: [{ id: "pic", spec: {} }], error: null };
    expect((await readStudioModels())?.map((m) => m.id)).toEqual(["pic"]);
  });
});
