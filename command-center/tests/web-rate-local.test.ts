import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));

const { takeLocal, localRateEntries } = await import("../lib/server/web-rate");

const RULE = { bucket: "test.prune", max: 2, windowSeconds: 60 };

describe("takeLocal, the in-process limiter", () => {
  it("counts per person per window and refuses past the allowance", () => {
    const t = 1_900_000_000_000;
    expect(takeLocal("a", RULE, t)).toBe(true);
    expect(takeLocal("a", RULE, t + 1)).toBe(true);
    expect(takeLocal("a", RULE, t + 2)).toBe(false);
    expect(takeLocal("b", RULE, t + 3)).toBe(true);
    // the next window starts again
    expect(takeLocal("a", RULE, t + 61_000)).toBe(true);
  });

  it("drops windows that have ended once many people have been seen, so the map does not grow without bound", () => {
    const t = 1_950_000_000_000;
    for (let i = 0; i < 1500; i++) takeLocal(`p${i}`, RULE, t);
    const before = localRateEntries();
    expect(before).toBeGreaterThanOrEqual(1000);
    // a call a few windows later sweeps every ended window, keeping only itself
    takeLocal("late", RULE, t + 10 * 60_000);
    expect(localRateEntries()).toBeLessThan(before);
    expect(localRateEntries()).toBeLessThan(10);
    // a live window is never dropped by the sweep
    expect(takeLocal("late", RULE, t + 10 * 60_000 + 1)).toBe(true);
    expect(takeLocal("late", RULE, t + 10 * 60_000 + 2)).toBe(false);
  });
});
