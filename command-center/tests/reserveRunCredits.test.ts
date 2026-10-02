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

const { reserveRunCredits, runCreditRefFor } = await import("../lib/server/credits");

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
  // The price list as charged (credit_rates(), 0084) answers from the same
  // rows, outside the spy, so `rpc` still records only what the code holds.
  const rates = async (fn: string, args: Record<string, unknown>) => {
    if (fn !== "credit_rates") return rpc(fn, args);
    const failed = opts.failing?.includes("credit_prices") ?? false;
    return failed ? { data: null, error: { message: "boom", code: "XX000" } } : { data: rows.credit_prices ?? [], error: null };
  };
  return { client: { from, rpc: rates } as never, rpc };
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

/**
 * The Assistant's confirmed plan starts runs with a stable hold reference
 * and the price the person saw. What would break without these: a double
 * press or a reload holding (and running) a second video, or a run held at
 * a price higher than the one confirmed.
 */
describe("reserveRunCredits: a confirmed plan step", () => {
  const ref = (u = "user-1", c = "ch-a", k = "assistant:p:s1:0") => runCreditRefFor("rj", u, c, k);

  it("the reference is stable for (user, channel, key), different otherwise, and a valid hold id", () => {
    expect(ref()).toBe(ref());
    expect(new Set([ref(), ref("user-2"), ref("user-1", "ch-b"), ref("user-1", "ch-a", "assistant:p:s1:1")]).size).toBe(4);
    expect(ref()).toMatch(/^rj-[0-9a-f]{48}$/);
    // reserve_credits' own check on the reference (migration 0020).
    expect(ref()).toMatch(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/);
    expect(ref()).not.toContain("user-1");
  });

  it("holds with the given reference", async () => {
    const { client, rpc } = fakeSupabase({ target_duration_seconds: 180 });
    expect(await reserveRunCredits(client, "ch-a", undefined, "rj", { creditRef: ref() })).toMatchObject({ ok: true, creditRef: ref() });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_job_id: ref() });
  });

  it("a replay of the same reference is 'already started', never a second hold", async () => {
    const { client, rpc } = fakeSupabase({ target_duration_seconds: 180 });
    rpc.mockImplementationOnce(async () => ({ data: null, error: { code: "23505", message: "a reservation for this job already exists" } }) as never);
    expect(await reserveRunCredits(client, "ch-a", undefined, "rj", { creditRef: ref() })).toEqual({
      ok: false,
      status: 409,
      body: { error: "run_already_started" },
    });
  });

  it("an estimate above the confirmed price is refused and nothing is held; at or below it holds", async () => {
    // 3 minutes at 12 credits a minute = 36.
    const { client, rpc } = fakeSupabase({ target_duration_seconds: 180 });
    expect(await reserveRunCredits(client, "ch-a", undefined, "rj", { maxCredits: 35 })).toEqual({
      ok: false,
      status: 409,
      body: { error: "price_changed", credits: 36 },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(await reserveRunCredits(client, "ch-a", undefined, "rj", { maxCredits: 36 })).toMatchObject({ ok: true });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_amount: 36 });
  });
});
