import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: { id: "u" } as { id: string } | null,
  inOrg: true,
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.user,
  createClient: async () => ({ rpc: h.rpc }),
}));
vi.mock("@/lib/channels-server", () => ({ isChannelInCurrentOrg: async () => h.inOrg }));
// Same-origin is pinned by its own tests; here the route's answers are what matters.
vi.mock("@/lib/server/same-origin", () => ({ requireSameOrigin: <T>(fn: T) => fn }));

const { POST } = await import("../app/api/brain/refresh/route");

const ask = (body: unknown = { channel_id: "my-channel" }) =>
  POST(new Request("http://localhost/api/brain/refresh", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  h.user = { id: "u" };
  h.inOrg = true;
  h.rpc.mockReset().mockResolvedValue({ data: { ok: true, status: "queued" }, error: null });
});

describe("POST /api/brain/refresh", () => {
  it("writes one request for the open workspace's channel and nothing else", async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "queued" });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith("research_request_refresh", { p_channel: "my-channel", p_kind: "own_channel" });
  });

  it("a channel of another workspace is 404 and nothing is asked", async () => {
    h.inOrg = false;
    expect((await ask()).status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a draft channel is 409 not_connected, told apart from the daily limit (the remedy is connecting, not waiting)", async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, error: "not_connected" }, error: null });
    const res = await ask();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_connected" });
    h.rpc.mockResolvedValue({ data: { ok: false, error: "daily_limit" }, error: null });
    const limit = await ask();
    expect(limit.status).toBe(429);
    expect(await limit.json()).toEqual({ error: "daily_limit" });
  });

  it("'recent' passes on when a new refresh is allowed, and only a real timestamp", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, status: "recent", next_at: "2026-11-21T12:00:00Z" }, error: null });
    expect(await (await ask()).json()).toEqual({ status: "recent", next_at: "2026-11-21T12:00:00Z" });
    h.rpc.mockResolvedValue({ data: { ok: true, status: "recent", next_at: "soon<script>" }, error: null });
    expect(await (await ask()).json()).toEqual({ status: "recent" });
  });

  it("an unknown answer is 'failed', never shown as asked", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, status: "done" }, error: null });
    expect((await ask()).status).toBe(502);
  });

  it("signed out is 401 and a malformed channel id is 400, neither asks anything", async () => {
    h.user = null;
    expect((await ask()).status).toBe(401);
    h.user = { id: "u" };
    expect((await ask({ channel_id: "../x" })).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
