import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/agent/run: YouTube's "made for kids" for a run (migration 0140).
 *
 * What would break without this: the Kids story form sending made_for_kids and the route dropping it (the video then
 * uploads as the channel's default, "not made for kids"), or the route taking `false` / "true" as a value. A run can only
 * turn the declaration on: true travels, absent stays absent, anything else is refused before a hold or a job exists.
 */

vi.mock("server-only", () => ({}));

const h = { insert: vi.fn(), reserve: vi.fn(), dispatch: vi.fn() };

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => ({ id: "u-me" }),
  createClient: async () => ({
    from: () => ({ insert: (row: unknown) => ({ select: () => ({ single: async () => h.insert(row) }) }) }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/lib/auth/org-roles", () => ({
  requireOrgRole: async () => ({ ok: true, role: "admin", orgId: "org-customer", source: "org" }),
  isOperator: async () => false,
  isPlatformAdmin: async () => false,
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ current: null }) }));
vi.mock("@/lib/server/audit", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/connectedAccounts", () => ({ readConnectedAccounts: async () => [] }));
vi.mock("@/lib/server/github-secrets", () => ({ dispatchDailyVideo: (...a: unknown[]) => h.dispatch(...a), isGithubConfigured: true }));
vi.mock("@/lib/server/credits", async () => {
  const actual = await vi.importActual<typeof import("../lib/server/credits")>("../lib/server/credits");
  return { ...actual, creditsEnforced: true, reserveRunCredits: (...a: unknown[]) => h.reserve(...a) };
});

const route = await import("../app/api/agent/run/route");
const post = (body: Record<string, unknown>) =>
  route.POST(
    new Request("http://test.local/api/agent/run", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://test.local" },
      body: JSON.stringify({ channel_id: "ch-a", ...body }),
    }),
  );

beforeEach(() => {
  process.env.NIGHTSHIFT_RUN_BACKEND = "queue";
  h.dispatch.mockReset().mockResolvedValue(undefined);
  h.insert.mockReset().mockResolvedValue({ data: { id: 7 }, error: null, status: 201 });
  h.reserve.mockReset().mockResolvedValue({ ok: true, creditRef: "rj-ref", estimate: { credits: 36 }, exempt: false, durationS: 180 });
});

describe("made_for_kids on a run", () => {
  it("true reaches the queued job's params", async () => {
    const res = await post({ topic: "A fox learns to share", made_for_kids: true });
    expect(res.status).toBe(200);
    expect(h.insert.mock.calls[0][0].params).toMatchObject({ topic: "A fox learns to share", made_for_kids: true });
  });

  it("absent stays absent: the channel, its series and its look decide", async () => {
    const res = await post({ topic: "Rome" });
    expect(res.status).toBe(200);
    expect(h.insert.mock.calls[0][0].params).not.toHaveProperty("made_for_kids");
  });

  it.each([false, "true", 1, {}])("%j is refused before any hold or job exists", async (value) => {
    const res = await post({ topic: "Rome", made_for_kids: value });
    expect(res.status).toBe(400);
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("true reaches the Actions dispatch too", async () => {
    process.env.NIGHTSHIFT_RUN_BACKEND = "actions";
    const res = await post({ topic: "A fox learns to share", made_for_kids: true });
    expect(res.status).toBe(200);
    expect(h.dispatch.mock.calls[0][1]).toMatchObject({ madeForKids: true });
    await post({ topic: "Rome" });
    expect(h.dispatch.mock.calls[1][1]).not.toHaveProperty("madeForKids");
  });
});
