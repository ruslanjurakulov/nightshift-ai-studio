import { describe, expect, it } from "vitest";
import { quotaGaugeView } from "@/lib/quota-gauge";
import type { QuotaAllocation } from "@/lib/advisory";

function alloc(over: Partial<QuotaAllocation> = {}): QuotaAllocation {
  return {
    ts: "2026-09-13T00:00:00Z",
    totalSlots: 5,
    channelCount: 2,
    channels: [],
    ...over,
  };
}

describe("quotaGaugeView", () => {
  it("returns an empty, no-event view for null (poller hasn't run)", () => {
    const v = quotaGaugeView(null);
    expect(v.rows).toEqual([]);
    expect(v.totalSlots).toBeNull();
    expect(v.ts).toBeNull();
    expect(v.emptyAllocation).toBe(false);
  });

  it("flags an event with no channels as an empty allocation", () => {
    const v = quotaGaugeView(alloc({ channels: [] }));
    expect(v.rows).toEqual([]);
    expect(v.emptyAllocation).toBe(true);
  });

  it("converts a measured share to a whole percent and fills the bar", () => {
    const v = quotaGaugeView(
      alloc({
        channels: [{ channelId: "c1", name: "Alpha", slots: 3, score: 900, share: 0.6 }],
      }),
    );
    expect(v.rows[0]).toMatchObject({
      name: "Alpha",
      slots: 3,
      sharePct: 60,
      fillPct: 60,
      measured: true,
    });
  });

  it("renders an unmeasured channel as N/A, never 0% (null != 0)", () => {
    const v = quotaGaugeView(
      alloc({
        channels: [{ channelId: "c2", name: "Beta", slots: 1, score: null, share: null }],
      }),
    );
    expect(v.rows[0].measured).toBe(false);
    expect(v.rows[0].sharePct).toBeNull();
    // The bar must be empty, not a full-looking or misleading bar.
    expect(v.rows[0].fillPct).toBe(0);
  });

  it("keeps a measured zero share distinct from unmeasured", () => {
    const v = quotaGaugeView(
      alloc({
        channels: [{ channelId: "c3", name: "Gamma", slots: 0, score: 0, share: 0 }],
      }),
    );
    // share 0 IS a measurement: 0%, measured true — not N/A.
    expect(v.rows[0].measured).toBe(true);
    expect(v.rows[0].sharePct).toBe(0);
    expect(v.rows[0].fillPct).toBe(0);
  });

  it("clamps an out-of-range share into the bar", () => {
    const v = quotaGaugeView(
      alloc({
        channels: [{ channelId: "c4", name: "Delta", slots: 9, score: 1, share: 1.4 }],
      }),
    );
    expect(v.rows[0].sharePct).toBe(140);
    expect(v.rows[0].fillPct).toBe(100);
  });

  it("passes through null slots and total as N/A-able nulls", () => {
    const v = quotaGaugeView(
      alloc({
        totalSlots: null,
        channels: [{ channelId: "c5", name: "Eps", slots: null, score: 5, share: 0.5 }],
      }),
    );
    expect(v.totalSlots).toBeNull();
    expect(v.rows[0].slots).toBeNull();
    expect(v.rows[0].sharePct).toBe(50);
  });
});
