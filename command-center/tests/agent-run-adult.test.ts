import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/agent/run for a person who said "under 18" (migration 0192). What would break without this: in a credits-exempt
 * workspace the Actions dispatch takes no credit hold and writes no render_jobs row, so none of 0192's database gates sees the run,
 * and a declared minor admin could start a paid video. The route reads the answer itself, before anything is dispatched. An
 * unknown answer (migration not applied, read failed) blocks no one, as on every other screen: the database still refuses.
 */

vi.mock("server-only", () => ({}));

const h = { age: "minor" as "adult" | "minor" | "none" | "unknown", dispatch: vi.fn(), reserve: vi.fn(), insert: vi.fn() };

vi.mock("@/lib/server/age", () => ({ readAgeState: async () => h.age }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => ({ id: "u-me" }),
  createClient: async () => ({
    from: () => ({ insert: (row: unknown) => ({ select: () => ({ single: async () => h.insert(row) }) }) }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/lib/auth/org-roles", () => ({
  requireOrgRole: async () => ({ ok: true, role: "admin", orgId: "00000000-0000-0000-0000-000000000001", source: "org" }),
  isOperator: async () => true,
  isPlatformAdmin: async () => true,
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ current: null }) }));
vi.mock("@/lib/server/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/connectedAccounts", () => ({ readConnectedAccounts: async () => [] }));
vi.mock("@/lib/server/github-secrets", () => ({ dispatchDailyVideo: (...a: unknown[]) => h.dispatch(...a), isGithubConfigured: true }));
vi.mock("@/lib/server/credits", async () => {
  const actual = await vi.importActual<typeof import("../lib/server/credits")>("../lib/server/credits");
  return { ...actual, creditsEnforced: true, reserveRunCredits: (...a: unknown[]) => h.reserve(...a) };
});

const route = await import("../app/api/agent/run/route");

const { dictionaries } = await import("../lib/i18n");

const post = () =>
  route.POST(
    new Request("http://test.local/api/agent/run", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://test.local" },
      body: JSON.stringify({ channel_id: "ch-a", idempotency_key: "11111111-1111-4111-8111-111111111111" }),
    }),
  );

beforeEach(() => {
  h.dispatch.mockReset();
  h.reserve.mockReset();
  h.insert.mockReset();
  h.reserve.mockResolvedValue({ ok: true, exempt: true });
  h.dispatch.mockResolvedValue(undefined);
  delete process.env.NIGHTSHIFT_RUN_BACKEND;
});

describe("Run now and the adult answer", () => {
  it("refuses a person who said under 18 with adult_only_service, before anything is held or dispatched", async () => {
    h.age = "minor";
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "adult_only_service" });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it.each(["adult", "none", "unknown"] as const)("does not refuse on the answer when it is %s", async (age) => {
    h.age = age;
    const res = await post();
    expect((await res.clone().json().catch(() => ({}))).error).not.toBe("adult_only_service");
  });

  it("names the reason in every language instead of a generic failure", () => {
    for (const d of Object.values(dictionaries)) expect(d.creative.errors.adult_only_service.length).toBeGreaterThan(20);

  });
});
