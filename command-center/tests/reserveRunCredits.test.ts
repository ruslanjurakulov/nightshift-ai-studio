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

/** `failing`: tables whose read returns an error (data null) instead of rows. */
function fakeSupabase(agentConfig: Record<string, unknown>, opts: { failing?: string[]; rows?: Record<string, unknown> } = {}) {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: { exempt: false }, error: null }));
  const rows: Record<string, unknown> = {
    credit_prices: [
      { unit: "video_minute", credits_per_unit: 12, margin: 0 },
      { unit: "job_minimum", credits_per_unit: 5, margin: 0 },
    ],
    video_costs: [],
    ...opts.rows,
  };
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "limit", "order", "in"]) b[m] = () => b;
    const failed = opts.failing?.includes(table) ?? false;
    const err = { message: "boom", code: "XX000" };
    b.maybeSingle = async () => ({ data: table === "channels" ? { org_id: ORG, agent_config: agentConfig } : null, error: null });
    b.then = (resolve: (v: unknown) => void) =>
      resolve(failed ? { data: null, error: err } : { data: rows[table] ?? [], error: null });
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

/**
 * CLAUDE.md #5: a read that ERRORED is not an empty one. Each of these used to
 * fall through to a different basis or a pricing-gap refusal; now the run is
 * refused as a retryable read failure and nothing is held.
 */
describe("reserveRunCredits: a failed read is unknown, never a number or a gap", () => {
  const readFailed = { ok: false, status: 503, body: { error: "credits_read_failed" } };

  it("a failed price-list read is a retryable 503, not a pricing-gap 409, and holds nothing", async () => {
    const { client, rpc } = fakeSupabase({ target_duration_seconds: 180 }, { failing: ["credit_prices"] });
    expect(await reserveRunCredits(client, "ch-a", undefined, "rj")).toEqual(readFailed);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("control: a price list that reads fine but is empty is still the no_prices gap (409)", async () => {
    const { client, rpc } = fakeSupabase({ target_duration_seconds: 180 }, { rows: { credit_prices: [] } });
    expect(await reserveRunCredits(client, "ch-a", undefined, "rj")).toEqual({
      ok: false,
      status: 409,
      body: { error: "credit_estimate_unavailable", gap: "no_prices" },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a failed ledger read fails the reservation instead of falling back to the per-minute basis", async () => {
    const { client, rpc } = fakeSupabase({ target_duration_seconds: 180 }, { failing: ["video_costs"] });
    // queue and Actions path alike: without the fix both produced a number and held it.
    expect(await reserveRunCredits(client, "ch-a", undefined, "rj")).toEqual(readFailed);
    expect(await reserveRunCredits(client, "ch-a", undefined, "gh")).toEqual(readFailed);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a failed video-length read (history basis) fails the reservation too", async () => {
    const { client, rpc } = fakeSupabase(
      { target_duration_seconds: 180 },
      {
        failing: ["videos"],
        rows: {
          video_costs: [
            { unit: "video_minute", quantity: 3, stage: "render", recorded_at: new Date().toISOString(), video_id: "v1", slug: "s1", channel_id: "ch-a", estimated_usd: 1 },
          ],
        },
      },
    );
    expect(await reserveRunCredits(client, "ch-a", undefined, "rj")).toEqual(readFailed);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("control: a ledger that reads fine and is empty still holds at the per-minute price", async () => {
    const { client, rpc } = fakeSupabase({ target_duration_seconds: 180 });
    expect(await reserveRunCredits(client, "ch-a", undefined, "rj")).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
