import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/agent/run: a customer cannot choose the paid video/image generator.
 *
 * What would break without this: a customer organization's run is priced per
 * minute whatever the footage source, so a body carrying video_provider=veo
 * turned on a funded Veo key at a price that does not cover it. The operator's
 * own organization (credit-exempt) keeps the choice.
 */

vi.mock("server-only", () => ({}));

const DEFAULT_ORG = (await import("../lib/orgs")).DEFAULT_ORG_ID;

const h = {
  org: "org-customer" as string,
  /** The caller is a platform owner/admin (they hold that role in every organization). */
  admin: false,
  insert: vi.fn(),
  reserve: vi.fn(),
  dispatch: vi.fn(),
};

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => ({ id: "u-me" }),
  createClient: async () => ({
    from: () => ({ insert: (row: unknown) => ({ select: () => ({ single: async () => h.insert(row) }) }) }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/lib/auth/org-roles", () => ({
  requireOrgRole: async () => ({ ok: true, role: "admin", orgId: h.org, source: "org" }),
  isOperator: async () => h.admin,
  isPlatformAdmin: async () => h.admin,
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
  h.org = "org-customer";
  h.admin = false;
  h.dispatch.mockReset().mockResolvedValue(undefined);
  h.insert.mockReset().mockResolvedValue({ data: { id: 7 }, error: null, status: 201 });
  h.reserve.mockReset().mockResolvedValue({ ok: true, creditRef: "rj-ref", estimate: { credits: 36 }, exempt: false, durationS: 180 });
});

describe("provider choice on the customer path", () => {
  it.each([{ video_provider: "veo" }, { image_provider: "leonardo" }, { video_provider: "kling", image_provider: "flux" }])(
    "refuses %j before any hold or job exists",
    async (extra) => {
      const res = await post(extra);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "provider_not_allowed" });
      expect(h.reserve).not.toHaveBeenCalled();
      expect(h.insert).not.toHaveBeenCalled();
    },
  );

  it("a customer run without a provider is unchanged", async () => {
    const res = await post({ topic: "Rome" });
    expect(res.status).toBe(200);
    expect(h.insert).toHaveBeenCalledTimes(1);
    expect(h.insert.mock.calls[0][0].params).not.toHaveProperty("video_provider");
  });

  it("blank selects (the form's 'automatic') are not a choice", async () => {
    const res = await post({ video_provider: "  ", image_provider: "" });
    expect(res.status).toBe(200);
  });

  it("the operator's own organization keeps the choice", async () => {
    h.org = DEFAULT_ORG;
    h.reserve.mockResolvedValue({ ok: true, creditRef: null, estimate: null, exempt: true, durationS: null });
    const res = await post({ video_provider: "veo", image_provider: "leonardo" });
    expect(res.status).toBe(200);
    expect(h.insert.mock.calls[0][0].params).toMatchObject({ video_provider: "veo", image_provider: "leonardo" });
  });

  // The refusal keys on WHOSE organization the channel is, never on who is asking. A platform admin holds owner in every
  // organization, so "the operator may choose" must not follow them onto a customer's channel: migration 0111's trigger
  // (render_jobs_payment_guard) refuses the same job for a paying organization whoever inserts it, and without this
  // gate the insert would come back as a 502 with an open three-hour credit hold behind it.
  it.each([
    ["queue", { video_provider: "veo" }],
    ["queue", { image_provider: "leonardo" }],
    ["actions", { video_provider: "kling", image_provider: "flux" }],
  ])("a platform admin on a customer's channel (%s backend) cannot pass %j either", async (backend, extra) => {
    process.env.NIGHTSHIFT_RUN_BACKEND = backend;
    h.admin = true;
    const res = await post(extra);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "provider_not_allowed" });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("a platform admin's plain run of a customer's channel still goes through", async () => {
    h.admin = true;
    const res = await post({ topic: "Rome" });
    expect(res.status).toBe(200);
    expect(h.insert.mock.calls[0][0].params).not.toHaveProperty("video_provider");
  });
});
