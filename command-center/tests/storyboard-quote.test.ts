import { describe, expect, it, vi } from "vitest";

/**
 * quoteStoryboard (lib/server/storyboards.ts): the one price on the
 * storyboard's button.
 *
 * What would break without these: the render priced at the channel's target
 * length instead of the storyboard's own scenes; a price list that could not
 * be read shown as a price (or as 0); the operator's own channel asked to pay;
 * a customer render offered at a price on a deployment that does not enforce
 * credits (nobody would pay for it).
 */

vi.mock("server-only", () => ({}));
vi.stubEnv("NIGHTSHIFT_CREDITS_ENFORCE", "1");

const { quoteStoryboard } = await import("../lib/server/storyboards");

const ORG = "0a000000-0000-4000-8000-00000000000a";
const OPERATOR_ORG = "00000000-0000-0000-0000-000000000001";

function fakeSupabase(opts: { failing?: string[]; org?: string } = {}) {
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
    const failed = opts.failing?.includes(table) ?? false;
    b.maybeSingle = async () => ({ data: { org_id: opts.org ?? ORG }, error: null });
    b.then = (resolve: (v: unknown) => void) =>
      resolve(failed ? { data: null, error: { message: "boom", code: "XX000" } } : { data: rows[table] ?? [], error: null });
    return b;
  };
  // The price list as charged (credit_rates(), 0084) answers from the same rows.
  const rpc = async (fn: string) => {
    if (fn !== "credit_rates") return { data: null, error: { message: "unexpected rpc", code: "XX000" } };
    return opts.failing?.includes("credit_prices")
      ? { data: null, error: { message: "boom", code: "XX000" } }
      : { data: rows.credit_prices, error: null };
  };
  return { from, rpc } as never;
}

describe("quoteStoryboard", () => {
  it("prices the storyboard's own length", async () => {
    // 270 s at 12 credits a minute.
    expect(await quoteStoryboard(fakeSupabase(), { channelId: "chan-a", durationS: 270 }, ORG)).toEqual({
      kind: "paid",
      credits: 54,
    });
    expect(await quoteStoryboard(fakeSupabase(), { channelId: "chan-a", durationS: 600 }, ORG)).toEqual({
      kind: "paid",
      credits: 120,
    });
  });

  it("a price list that could not be read is unknown, never a number", async () => {
    expect(
      await quoteStoryboard(fakeSupabase({ failing: ["credit_prices"] }), { channelId: "chan-a", durationS: 270 }, ORG),
    ).toEqual({ kind: "unavailable", reason: "read_failed" });
    expect(
      await quoteStoryboard(fakeSupabase({ failing: ["video_costs"] }), { channelId: "chan-a", durationS: 270 }, ORG),
    ).toEqual({ kind: "unavailable", reason: "read_failed" });
  });

  it("the operator's own organization is included, whether known up front or read", async () => {
    expect(await quoteStoryboard(fakeSupabase(), { channelId: "default", durationS: 270 }, OPERATOR_ORG)).toEqual({
      kind: "included",
    });
    expect(
      await quoteStoryboard(fakeSupabase({ org: OPERATOR_ORG }), { channelId: "default", durationS: 270 }, null),
    ).toEqual({ kind: "included" });
  });
});
