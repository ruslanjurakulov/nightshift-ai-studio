/**
 * GET /api/agent/runs/window's live facts. What would break without these: GitHub asked with the app's token about a channel the
 * person cannot see (another workspace's channel id would learn whether it ran), or a hold read from anything but RLS.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  visible: true,
  status: vi.fn(),
  holdRow: null as Record<string, unknown> | null,
  reads: [] as { table: string; filters: [string, unknown][] }[],
}));
vi.mock("@/lib/server/github-runs", () => ({ dispatchedRunStatus: (...a: unknown[]) => h.status(...a) }));
const rate = vi.hoisted(() => ({ take: vi.fn(async () => "ok") }));
vi.mock("@/lib/server/web-rate", () => ({ RUN_STATUS_RATE: { bucket: "studio.run_status", max: 240, windowSeconds: 3600 }, takeWebRate: rate.take }));

function query(table: string) {
  const filters: [string, unknown][] = [];
  h.reads.push({ table, filters });
  const q = {
    select: () => q,
    eq: (k: string, v: unknown) => (filters.push([k, v]), q),
    gte: () => q,
    lte: () => q,
    order: () => q,
    limit: async () => ({ data: [], error: null }),
    maybeSingle: async () =>
      table === "channels"
        ? { data: h.visible ? { id: filters[0]?.[1] } : null, error: null }
        : table === "credit_reservations"
          ? { data: h.holdRow, error: null }
          : { data: null, error: null },
  };
  return q;
}
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => ({ id: "u" }), createClient: async () => ({ from: query }) }));

const { GET } = await import("../app/api/agent/runs/window/route");
const CH = "ch-alpha";
const since = () => new Date(Date.now() - 60_000).toISOString();
const get = (extra = "") => GET(new Request(`http://x/api/agent/runs/window?channel=${CH}&since=${encodeURIComponent(since())}${extra}`));

beforeEach(() => {
  h.visible = true;
  h.status.mockReset().mockResolvedValue({ state: "in_progress" });
  h.holdRow = null;
  h.reads = [];
});

describe("the window route's live facts", () => {
  it("asks GitHub only for a channel RLS shows this person", async () => {
    h.visible = false;
    const body = await (await get()).json();
    expect(h.status).not.toHaveBeenCalled();
    expect(body.workflow).toBeNull();
    h.visible = true;
    expect((await (await get()).json()).workflow).toEqual({ state: "in_progress" });
    expect(h.status).toHaveBeenCalledWith(CH, expect.any(Number), expect.any(Function));
    // The channel is gated on its real key: channels has channel_id, no id (Breach 5).
    expect(h.reads.find((r) => r.table === "channels")?.filters).toEqual([["channel_id", CH]]);
    // The person's own rate limit is what the GitHub read is charged to.
    const mayAsk = h.status.mock.calls.at(-1)![2] as () => Promise<boolean>;
    rate.take.mockResolvedValueOnce("limited");
    expect(await mayAsk()).toBe(false);
    expect(rate.take).toHaveBeenCalledWith("u", expect.objectContaining({ bucket: "studio.run_status" }));
  });

  it("a channel id is a slug: a real one is read, anything else is not found", async () => {
    expect((await get()).status).toBe(200);
    const bad = await GET(new Request(`http://x/api/agent/runs/window?channel=${encodeURIComponent("a,b")}&since=${encodeURIComponent(since())}`));
    expect(bad.status).toBe(404);
  });

  it("reads the hold named by &hold= through the person's own client, and a malformed ref reads nothing", async () => {
    h.holdRow = { status: "open", amount: "42.00", captured: null };
    expect((await (await get("&hold=gh-abc123")).json()).hold).toEqual({ state: "open", amount: 42, captured: null });
    expect(h.reads.find((r) => r.table === "credit_reservations")?.filters).toEqual([["job_id", "gh-abc123"]]);
    h.reads = [];
    expect((await (await get("&hold=" + encodeURIComponent("x' or 1=1"))).json()).hold).toBeNull();
    expect(h.reads.some((r) => r.table === "credit_reservations")).toBe(false);
  });
});
