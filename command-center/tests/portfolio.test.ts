import { describe, expect, it } from "vitest";
import {
  channelEconomics,
  portfolioTotals,
  type ChannelEconomicsInput,
} from "@/lib/portfolio";

function input(over: Partial<ChannelEconomicsInput> & { channelId: string }): ChannelEconomicsInput {
  return {
    channelId: over.channelId,
    name: over.name ?? over.channelId,
    videoCount: over.videoCount ?? 0,
    cost: "cost" in over ? (over.cost as number | null) : null,
    revenue: "revenue" in over ? (over.revenue as number | null) : null,
    rpm: "rpm" in over ? (over.rpm as number | null) : null,
  };
}

describe("channelEconomics", () => {
  it("computes profit, margin and cost/video when everything is known", () => {
    const c = channelEconomics(input({ channelId: "a", videoCount: 5, cost: 20, revenue: 100, rpm: 8 }));
    expect(c.profit).toBe(80);
    expect(c.margin).toBeCloseTo(0.8, 10);
    expect(c.costPerVideo).toBeCloseTo(4, 10);
    expect(c.rpm).toBe(8);
  });

  it("leaves profit and margin blank when cost is known but revenue is unknown", () => {
    const c = channelEconomics(input({ channelId: "a", videoCount: 4, cost: 12, revenue: null }));
    expect(c.cost).toBe(12);
    expect(c.revenue).toBeNull();
    expect(c.profit).toBeNull(); // both sides required — a known cost is not a loss
    expect(c.margin).toBeNull();
    expect(c.costPerVideo).toBeCloseTo(3, 10); // cost/video still derivable
  });

  it("leaves profit and margin blank when revenue is known but cost is unknown", () => {
    const c = channelEconomics(input({ channelId: "a", videoCount: 2, cost: null, revenue: 50 }));
    expect(c.profit).toBeNull();
    expect(c.margin).toBeNull();
    expect(c.costPerVideo).toBeNull(); // cost unknown → cannot divide
  });

  it("leaves cost/video blank when the channel has zero videos", () => {
    const c = channelEconomics(input({ channelId: "a", videoCount: 0, cost: 30, revenue: 90 }));
    expect(c.costPerVideo).toBeNull(); // no division by zero, no invented per-video
    expect(c.profit).toBe(60); // portfolio profit is unaffected by the count
  });

  it("leaves margin blank when revenue is zero, but still reports profit", () => {
    const c = channelEconomics(input({ channelId: "a", videoCount: 3, cost: 15, revenue: 0 }));
    expect(c.profit).toBe(-15); // 0 revenue is a KNOWN 0 here — a real -cost profit
    expect(c.margin).toBeNull(); // margin is a share of revenue; 0 revenue → blank
  });

  it("treats a non-finite input as unknown (null), never as a number", () => {
    const c = channelEconomics(input({ channelId: "a", videoCount: 1, cost: Number.NaN, revenue: 10 }));
    expect(c.cost).toBeNull();
    expect(c.profit).toBeNull();
  });
});

describe("portfolioTotals", () => {
  it("aggregates known costs, revenue and profit across channels", () => {
    const totals = portfolioTotals([
      input({ channelId: "a", videoCount: 5, cost: 20, revenue: 100 }),
      input({ channelId: "b", videoCount: 3, cost: 10, revenue: 30 }),
    ]);
    expect(totals.totalVideos).toBe(8);
    expect(totals.totalCost).toBe(30);
    expect(totals.totalRevenue).toBe(130);
    expect(totals.totalProfit).toBe(100); // (100-20) + (30-10)
    expect(totals.avgMargin).toBeCloseTo(100 / 130, 10);
    expect(totals.costPartial).toBe(false);
    expect(totals.revenuePartial).toBe(false);
    expect(totals.hasAny).toBe(true);
  });

  it("excludes unknown values from the sums and flags the totals as floors", () => {
    const totals = portfolioTotals([
      input({ channelId: "a", videoCount: 5, cost: 20, revenue: 100 }), // fully known
      input({ channelId: "b", videoCount: 2, cost: 10, revenue: null }), // revenue unknown
      input({ channelId: "c", videoCount: 1, cost: null, revenue: 40 }), // cost unknown
    ]);
    expect(totals.totalCost).toBe(30); // 20 + 10 (c excluded)
    expect(totals.totalRevenue).toBe(140); // 100 + 40 (b excluded)
    // Only channel a has BOTH — profit never pairs b's cost with c's revenue.
    expect(totals.totalProfit).toBe(80);
    expect(totals.avgMargin).toBeCloseTo(80 / 100, 10);
    expect(totals.costPartial).toBe(true);
    expect(totals.revenuePartial).toBe(true);
  });

  it("returns nulls (not zeros) when nothing is known", () => {
    const totals = portfolioTotals([
      input({ channelId: "a", videoCount: 0, cost: null, revenue: null }),
    ]);
    expect(totals.totalCost).toBeNull();
    expect(totals.totalRevenue).toBeNull();
    expect(totals.totalProfit).toBeNull();
    expect(totals.avgMargin).toBeNull();
    expect(totals.hasAny).toBe(false);
  });

  it("handles an empty portfolio", () => {
    const totals = portfolioTotals([]);
    expect(totals.channels).toEqual([]);
    expect(totals.totalVideos).toBe(0);
    expect(totals.totalProfit).toBeNull();
    expect(totals.hasAny).toBe(false);
  });
});
