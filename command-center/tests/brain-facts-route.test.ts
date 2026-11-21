import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-2222-4333-8444-555555555555";
const h = vi.hoisted(() => ({
  user: { id: "u" } as { id: string } | null,
  org: { supported: true, current: { id: "11111111-2222-4333-8444-555555555555" } } as unknown,
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => ({ rpc: h.rpc }),
}));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => h.org }));

const { GET } = await import("../app/api/brain/facts/route");

const facts = (org = ORG) => ({
  org_id: org,
  generated_at: "2026-11-21T10:00:00Z",
  credits: { spend_by_tool_14d: { "cj:t2i": 4 }, daily_14d: [], usage: { spendable_now: 10 } },
  projects: { videos_total: 0, recent_videos: [] },
  memory: { characters: 0, style_kits: 0, brand_domains: 0 },
});

beforeEach(() => {
  h.user = { id: "u" };
  h.org = { supported: true, current: { id: ORG } };
  h.rpc.mockReset().mockResolvedValue({ data: facts(), error: null });
});

describe("GET /api/brain/facts", () => {
  it("signed out is 401 and nothing is read", async () => {
    h.user = null;
    const res = await GET();
    expect(res.status).toBe(401);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("asks the database for the OPEN workspace only, never one the request names", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("brain_org_facts", { p_org: ORG });
    const body = (await res.json()) as { state: string; facts: { orgId: string; spend14: Record<string, number> } };
    expect(body.state).toBe("ok");
    expect(body.facts.orgId).toBe(ORG);
    expect(body.facts.spend14.image).toBe(4);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("an answer about another org than the one asked is refused, not shown", async () => {
    h.rpc.mockResolvedValue({ data: facts("99999999-2222-4333-8444-555555555555"), error: null });
    const res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ state: "failed" });
  });

  it("not a member (null) is 404; 0202 not applied is 503; any other error is 502", async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect((await GET()).status).toBe(404);
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    expect((await GET()).status).toBe(503);
    h.rpc.mockResolvedValueOnce({ data: null, error: { code: "57014", message: "timeout" } });
    expect((await GET()).status).toBe(502);
  });

  it("no workspace open is 404 and nothing is read", async () => {
    h.org = { supported: true, current: null };
    expect((await GET()).status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
