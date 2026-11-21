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
  const OLD = "2026-01-01T00:00:00Z";
  it("averages over all 14 calendar days, quiet days included", () => {
    // 28 credits in one busy day out of 14: 2 a day, not 28.
    const f = forecast({ spendable: 20, daily: days([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 28]), renewsAt: null, historyStart: OLD }, NOW);
    expect(f).toMatchObject({ state: "estimate", avgPerDay: 2, daysLeft: 10, runsOutOn: "2026-12-01" });
  });

  it("a young workspace divides by the days it existed, not by 14, and gives no date before a week", () => {
    const daily = days([0, 0, 0, 0, 0, 0, 70, 70, 70, 70, 70, 70, 70, 70]);
    // 8 days old: 560 / 8 = 70 a day (dividing by 14 would claim 40 and a date almost twice as far).
    const f = forecast({ spendable: 700, daily, renewsAt: null, historyStart: new Date(NOW - 8 * 86_400_000).toISOString() }, NOW);
    expect(f).toMatchObject({ state: "estimate", avgPerDay: 70, daysLeft: 10 });
    expect(forecast({ spendable: 700, daily, renewsAt: null, historyStart: new Date(NOW - 2 * 86_400_000).toISOString() }, NOW)).toEqual({
      state: "short_history",
      days: 2,
    });
  });

  it("never gives a date past the renewal: plan credits expire then", () => {
    const daily = days(Array(14).fill(10));
    expect(forecast({ spendable: 50, daily, renewsAt: "2026-12-20T00:00:00Z", historyStart: OLD }, NOW)).toMatchObject({ state: "estimate", daysLeft: 5 });
    expect(forecast({ spendable: 500, daily, renewsAt: "2026-11-25T00:00:00Z", historyStart: OLD }, NOW)).toEqual({
      state: "past_renewal",
      avgPerDay: 10,
      renewsAt: "2026-11-25T00:00:00Z",
    });
  });

  it("no spend, an unknown balance, a short series and an exempt workspace never produce a date", () => {
    expect(forecast({ spendable: 100, daily: days(Array(14).fill(0)), renewsAt: null, historyStart: OLD }, NOW).state).toBe("no_spend");
    expect(forecast({ spendable: null, daily: days(Array(14).fill(5)), renewsAt: null, historyStart: OLD }, NOW).state).toBe("unknown");
    expect(forecast({ spendable: 100, daily: days([5, 5, 5]), renewsAt: null, historyStart: OLD }, NOW).state).toBe("unknown");
    expect(forecast({ spendable: "exempt", daily: days(Array(14).fill(5)), renewsAt: null, historyStart: OLD }, NOW).state).toBe("exempt");
  });
});

describe("renewal", () => {
  it("'renews on' only for a subscription that will renew; a cancelled or cancelling one 'ends on'", () => {
    const sub = (status: string, cancel = false) =>
      coerceFacts({ org_id: "o", credits: { usage: { subscription: { status, current_period_end: "2026-12-01T00:00:00Z", cancel_at_period_end: cancel } } } });
    expect(sub("active")).toMatchObject({ renewsAt: "2026-12-01T00:00:00Z", endsAt: null });
    expect(sub("active", true)).toMatchObject({ renewsAt: null, endsAt: "2026-12-01T00:00:00Z" });
    expect(sub("canceled")).toMatchObject({ renewsAt: null, endsAt: "2026-12-01T00:00:00Z" });
  });
});

describe("ledger tags", () => {
  it("scene re-renders count as channel videos; reply drafts and downloads are other", () => {
    expect(toolOfTag("scene_regenerate")).toBe("channel_videos");
    expect(toolOfTag("reply_draft")).toBe("other");
    expect(toolOfTag("download")).toBe("other");
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
      credits: { usage: { spendable_now: 12, subscription: { status: "active", current_period_end: "2026-12-01T00:00:00Z" } } },
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

import { QUESTIONS_THEME, coerceChannel, dataThroughDay } from "@/lib/brain/dashboard";

describe("the channel card reads S10's envelope as it comes", () => {
  const env = (status: string, data: unknown = {}) => ({ status, fetched_at: "2026-11-21T11:00:00Z", source: "youtube", data });

  it("a hidden subscriber count is hidden, not 0; unknown counts stay null; uploads sort by views, unknown last", () => {
    const r = coerceChannel("ch", env("ok", {
      channel: { title: "My channel", subscriber_count: null, subscribers_hidden: true, view_count: 1200, video_count: null },
      recent_videos: [{ video_id: "a", view_count: null }, { video_id: "b", view_count: 50 }, { video_id: "c", view_count: 900 }],
    }), null);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.subscribersHidden).toBe(true);
    expect(r.subscribers).toBeNull();
    expect(r.videoCount).toBeNull();
    expect(r.topUploads.map((u) => u.videoId)).toEqual(["c", "b", "a"]);
    expect(r.analytics).toBeNull();
    expect(r.themes).toEqual([]);
  });

  it("every other status is carried as such with its fetch time, and not_enabled / junk never read as an empty channel", () => {
    expect(coerceChannel("ch", env("budget_exhausted"), null)).toMatchObject({ state: "budget_exhausted", fetchedAt: "2026-11-21T11:00:00Z" });
    expect(coerceChannel("ch", env("not_connected"), null).state).toBe("not_connected");
    expect(coerceChannel("ch", env("not_enabled"), null).state).toBe("not_enabled");
    expect(coerceChannel("ch", { status: "whatever" }, null).state).toBe("failed");
    expect(coerceChannel("ch", null, null).state).toBe("failed");
  });

  it("themes are labels with counts, capped, only from an ok themes answer", () => {
    const own = env("ok", { channel: { view_count: 1 } });
    const themes = env("ok", { questions: { count: 4, samples: [] }, words: [{ untrusted_word: "<b>music</b>", count: 3 }, { nope: 1 }] });
    const r = coerceChannel("ch", own, themes);
    // The questions group is named by the card; a viewer's word is kept as the plain text it is.
    expect(r.state === "ok" && r.themes).toEqual([{ label: QUESTIONS_THEME, count: 4 }, { label: "<b>music</b>", count: 3 }]);
    const r2 = coerceChannel("ch", own, env("refreshing"));
    expect(r2.state === "ok" && r2.themes).toEqual([]);
  });
});

describe("YouTube Analytics' window", () => {
  it("ends the day before it was fetched (UTC)", () => {
    expect(dataThroughDay("2026-11-21T03:00:00Z")).toBe("2026-11-20");
    expect(dataThroughDay(null)).toBeNull();
  });
});

describe("coerceChannel: the channel's own uploads", () => {
  it("keeps privacy_status so a member sees which top video is private or unlisted; anything else is null", () => {
    const own = {
      status: "ok",
      fetched_at: "2026-11-21T11:00:00Z",
      data: {
        channel: { title: "C" },
        recent_videos: [
          { video_id: "a", title: "A", view_count: 9, privacy_status: "private" },
          { video_id: "b", title: "B", view_count: 5, privacy_status: "public" },
          { video_id: "c", title: "C", view_count: 1, privacy_status: "secret" },
        ],
      },
    };
    const r = coerceChannel("ch", own, null);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.topUploads.map((u) => [u.videoId, u.privacy])).toEqual([["a", "private"], ["b", "public"], ["c", null]]);
  });
});

describe("coerceChannel: remedy codes", () => {
  it("keeps S10's stable remedy_code and never the English remedy text; an unknown code is null", () => {
    const env = (code: unknown) => ({ status: "not_connected", fetched_at: null, data: null, remedy: "Please reconnect in English", remedy_code: code });
    expect(coerceChannel("ch", env("token_expired"), null)).toMatchObject({ state: "not_connected", remedy: "token_expired" });
    expect(coerceChannel("ch", env("drop table"), null)).toMatchObject({ remedy: null });
    expect(JSON.stringify(coerceChannel("ch", env("connect"), null))).not.toContain("English");
  });
});
