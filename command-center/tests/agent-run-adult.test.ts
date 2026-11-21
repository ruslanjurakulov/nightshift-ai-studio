import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/agent/run for a person who said "under 18" (migration 0192). What would break without this: in a credits-exempt
 * workspace the Actions dispatch takes no credit hold and writes no render_jobs row, so none of 0192's database gates sees the run,
 * and a declared minor admin could start a paid video. The route reads the answer itself, before anything is dispatched. An
 * unknown answer (migration not applied, read failed) blocks no one, as on every other screen: the database still refuses.
 */

vi.mock("server-only", () => ({}));

const h = { age: "minor" as "adult" | "minor" | "none" | "unknown" | "absent", dispatch: vi.fn(), reserve: vi.fn(), insert: vi.fn() };

vi.mock("@/lib/server/age", () => ({ readAgeState: async () => (h.age === "absent" ? "unknown" : h.age), readAgeAnswer: async () => h.age }));
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

  it.each(["adult", "none", "unknown"] as const)("does not refuse with adult_only_service when the answer is %s", async (age) => {
    h.age = age;
    const res = await post();
    expect((await res.clone().json().catch(() => ({}))).error).not.toBe("adult_only_service");
  });

  it("0196: refuses a person with no answer with adult_attestation_required (the run spends on Google), before anything is held", async () => {
    h.age = "none";
    const res = await post();
    expect(res.status).toBe(428);
    expect(await res.json()).toMatchObject({ error: "adult_attestation_required", google_stages: ["text"] });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("0196: an adult (the demo and owner accounts once they answered) runs as before", async () => {
    h.age = "adult";
    const res = await post();
    expect(res.status).toBe(200);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it("0196: on Actions an answer that could not be read stops the run (try again), because nothing after the route asks again", async () => {
    h.age = "unknown";
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "age_unavailable" });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    const { creditRunError } = await import("../lib/credits");
    for (const [loc, d] of Object.entries(dictionaries)) expect(creditRunError({ error: "age_unavailable" }, d, loc), loc).toBe(d.credits.ageUnavailable);
  });

  it("0196: on the queue an unread answer goes on to the database, whose run gate refuses the row itself", async () => {
    process.env.NIGHTSHIFT_RUN_BACKEND = "queue";
    h.age = "unknown";
    h.insert.mockResolvedValue({ data: { id: "job-1" }, error: null });
    const res = await post();
    expect((await res.clone().json().catch(() => ({}))).error).not.toBe("age_unavailable");
    expect(res.status).not.toBe(428);
    // It reached the row: on the queue the database's run gate, not this route, decides.
    expect(h.insert).toHaveBeenCalledTimes(1);
  });

  it("0196: the remedy is in every language and names Create", async () => {
    const { creditRunError } = await import("../lib/credits");
    for (const [loc, d] of Object.entries(dictionaries)) {
      const text = creditRunError({ error: "adult_attestation_required" }, d, loc);
      expect(text, loc).toBe(d.credits.adultRequired);
      expect(text!.length, loc).toBeGreaterThan(40);
    }
  });

  it("names the reason in every language instead of a generic failure", () => {
    for (const d of Object.values(dictionaries)) expect(d.creative.errors.adult_only_service.length).toBeGreaterThan(20);

  });
});
