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
const CH = "c0000000-0000-4000-8000-0000000000c0";
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
    expect(h.status).toHaveBeenCalledWith(CH, expect.any(Number));
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
