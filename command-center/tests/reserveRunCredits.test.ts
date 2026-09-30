import { describe, expect, it, vi } from "vitest";

/**
 * reserveRunCredits (lib/server/credits.ts): what "Run now" holds, and for
 * which length.
 *
 * What would break without these: a queued run held for one length and run at
 * another — the channel's target read again at run time, or above the 60
 * minutes a run may be (review finding C1, migration 0041) — or the Actions
 * path's pricing changing along with it.
 */

vi.mock("server-only", () => ({}));

const { reserveRunCredits } = await import("../lib/server/credits");

const ORG = "0a000000-0000-0000-0000-00000000000a";

function fakeSupabase(agentConfig: Record<string, unknown>) {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: { exempt: false }, error: null }));
  const rows: Record<string, unknown> = {
    credit_prices: [
      { unit: "video_minute", credits_per_unit: 12, margin: 0 },
      { unit: "job_minimum", credits_per_unit: 5, margin: 0 },
    ],
    video_costs: [],
  };
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "limit", "order", "in"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: table === "channels" ? { org_id: ORG, agent_config: agentConfig } : null, error: null });
    b.then = (resolve: (v: unknown) => void) => resolve({ data: rows[table] ?? [], error: null });
    return b;
  };
  return { client: { from, rpc } as never, rpc };
}

describe("reserveRunCredits", () => {
  it("a queue run is held for its frozen length and returns it for the job", async () => {
    const { client, rpc } = fakeSupabase({ target_duration_seconds: 7200 });
    const res = await reserveRunCredits(client, "ch-a", undefined, "rj");
    expect(res).toMatchObject({ ok: true, durationS: 3600 });
    // 60 minutes (the cap), not the 120 the channel asks for, at 12 credits a minute.
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_org: ORG, p_amount: 720 });
  });

  it("a queue run with no length at all is refused with the fix, and nothing is held", async () => {
    const { client, rpc } = fakeSupabase({});
    const res = await reserveRunCredits(client, "ch-a", undefined, "rj");
    expect(res).toEqual({ ok: false, status: 409, body: { error: "credit_estimate_unavailable", gap: "no_length" } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the Actions path prices exactly as before and freezes nothing", async () => {
    const { client, rpc } = fakeSupabase({ target_duration_seconds: 7200 });
    const res = await reserveRunCredits(client, "ch-a", undefined, "gh");
    expect(res).toMatchObject({ ok: true, durationS: null });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_amount: 1440 });
  });
});
