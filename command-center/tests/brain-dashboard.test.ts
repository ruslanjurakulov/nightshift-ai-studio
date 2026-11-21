import { describe, expect, it } from "vitest";
import {
  coerceFacts,
  forecast,
  minutesAgo,
  sparkPoints,
  spendByTool,
  toolOfTag,
  usedShare,
  warnUsed,
  type DayPoint,
} from "@/lib/brain/dashboard";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const days = (vals: number[]): DayPoint[] =>
  vals.map((credits, i) => ({ day: new Date(NOW - (vals.length - 1 - i) * 86_400_000).toISOString().slice(0, 10), credits }));

describe("spend by tool", () => {
  it("a creative job is named by its capability; channel runs, films and exports by their own ledger tag", () => {
    expect(toolOfTag("cj:t2i")).toBe("image");
    expect(toolOfTag("cj:i2v")).toBe("video");
    expect(toolOfTag("cj:tts")).toBe("voice");
    expect(toolOfTag("cj:unknown")).toBe("other");
    expect(toolOfTag("run")).toBe("channel_videos");
    expect(toolOfTag("film")).toBe("film");
    expect(toolOfTag("ads")).toBe("other");
  });

  it("sums tags into tools, every tool present, junk ignored", () => {
    const s = spendByTool({ "cj:t2i": 3, "cj:edit": "2.5", run: 40, nonsense: "x", neg: -5 });
    expect(s.image).toBe(5.5);
    expect(s.channel_videos).toBe(40);
    expect(s.chat).toBe(0);
    expect(Object.keys(s)).toHaveLength(8);
  });
});

describe("the credit forecast is an estimate from the last 14 days, or no date at all", () => {
  it("averages over all 14 calendar days, quiet days included", () => {
    // 28 credits in one busy day out of 14: 2 a day, not 28.
    const f = forecast({ spendable: 20, daily: days([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 28]), renewsAt: null }, NOW);
    expect(f).toMatchObject({ state: "estimate", avgPerDay: 2, daysLeft: 10, runsOutOn: "2026-12-01", beforeRenewal: null });
  });

  it("says whether the money runs out before the plan renews", () => {
    const daily = days(Array(14).fill(10));
    expect(forecast({ spendable: 50, daily, renewsAt: "2026-12-20T00:00:00Z" }, NOW)).toMatchObject({ beforeRenewal: true });
    expect(forecast({ spendable: 500, daily, renewsAt: "2026-11-25T00:00:00Z" }, NOW)).toMatchObject({ beforeRenewal: false });
  });

  it("no spend, an unknown balance, a short series and an exempt workspace never produce a date", () => {
    expect(forecast({ spendable: 100, daily: days(Array(14).fill(0)), renewsAt: null }, NOW).state).toBe("no_spend");
    expect(forecast({ spendable: null, daily: days(Array(14).fill(5)), renewsAt: null }, NOW).state).toBe("unknown");
    expect(forecast({ spendable: 100, daily: days([5, 5, 5]), renewsAt: null }, NOW).state).toBe("unknown");
    expect(forecast({ spendable: "exempt", daily: days(Array(14).fill(5)), renewsAt: null }, NOW).state).toBe("exempt");
  });
});

describe("the 70% warning", () => {
  it("warns at 70% used and not before; unknown is no warning and no share", () => {
    expect(warnUsed({ name: "Pro", granted: 1000, spent: 700, periodEnd: null })).toBe(true);
    expect(warnUsed({ name: "Pro", granted: 1000, spent: 699, periodEnd: null })).toBe(false);
    expect(usedShare({ name: "Pro", granted: null, spent: 10, periodEnd: null })).toBeNull();
    expect(usedShare({ name: "Pro", granted: 0, spent: 0, periodEnd: null })).toBeNull();
    expect(usedShare(null)).toBeNull();
  });
});

describe("reading brain_org_facts", () => {
  it("keeps unknowns as null, never 0", () => {
    const f = coerceFacts({ org_id: "o", credits: { usage: null }, projects: {}, memory: {} });
    expect(f?.spendable).toBeNull();
    expect(f?.videosTotal).toBeNull();
    expect(f?.memory.characters).toBeNull();
    expect(f?.recentVideos).toEqual([]);
  });

  it("an exempt workspace reads as exempt, and a non-object as no facts", () => {
    expect(coerceFacts({ org_id: "o", credits: { usage: { exempt: true, spendable_now: 5 } } })?.spendable).toBe("exempt");
    expect(coerceFacts(null)).toBeNull();
    expect(coerceFacts({})).toBeNull();
  });

  it("reads the renewal from the subscription, and a video's latest snapshot", () => {
    const f = coerceFacts({
      org_id: "o",
      credits: { usage: { spendable_now: 12, subscription: { current_period_end: "2026-12-01T00:00:00Z" } } },
      projects: { videos_total: 1, recent_videos: [{ video_id: "v1", title: "T", latest: { views: 10, date: "2026-11-20" } }] },
    });
    expect(f?.renewsAt).toBe("2026-12-01T00:00:00Z");
    expect(f?.recentVideos[0]).toMatchObject({ videoId: "v1", views: 10, likes: null, snapshotDate: "2026-11-20" });
  });
});

describe("freshness and the spark line", () => {
  it("minutes since a fetch; unknown time is null; a clock ahead is 0", () => {
    expect(minutesAgo("2026-11-21T11:45:30Z", NOW)).toBe(14);
    expect(minutesAgo(null, NOW)).toBeNull();
    expect(minutesAgo("2026-11-21T12:05:00Z", NOW)).toBe(0);
  });

  it("a quiet fortnight stays flat instead of being scaled up", () => {
    expect(sparkPoints(days([0, 0, 0]))).toEqual([0, 0, 0]);
    expect(sparkPoints(days([0, 5, 10]))).toEqual([0, 0.5, 1]);
  });
});
