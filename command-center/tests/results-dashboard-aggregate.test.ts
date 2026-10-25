/**
 * The results dashboard's arithmetic (lib/resultsDashboard/aggregate.ts, format.ts, platforms.ts).
 * What would break without these: a video nobody measured read as "0 views", a reading added to the same video's next reading
 * (the poll's two-day windows overlap), an average pulled around by a 2-view video, a platform with no results drawn with a
 * number, a "last 28 days" that includes day 29 or tomorrow, a stale dashboard that looks current.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY,
  STALE_AFTER_DAYS,
  buildHistory,
  buildVideoResults,
  coerceSnapshots,
  coerceVideos,
  computeKpis,
  freshness,
  historyStatus,
  isEmptyReading,
  parseRange,
  topByViews,
  windowStart,
  type RequestInput,
  type SnapshotInput,
  type VideoInput,
  type VideoResult,
} from "../lib/resultsDashboard/aggregate";
import { barPercent, dayOf, formatCount, formatDuration, formatHours } from "../lib/resultsDashboard/format";
import { PLATFORMS, platformCards, platformState } from "../lib/resultsDashboard/platforms";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

const video = (over: Partial<VideoInput> = {}): VideoInput => ({
  videoId: "vid00000001",
  channelId: "c1",
  title: "A title",
  publishedAt: iso(NOW - 2 * DAY),
  privacy: "private",
  format: "long",
  ...over,
});
const snap = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  videoId: "vid00000001",
  snapshotDate: "2026-10-24",
  views: 100,
  likes: 10,
  comments: 2,
  watchMinutes: 60,
  avgViewSeconds: 120,
  impressions: null,
  ...over,
});

describe("parseRange", () => {
  it("accepts exactly 7, 28 and 90, as text or number", () => {
    expect(parseRange("7")).toBe(7);
    expect(parseRange(" 28 ")).toBe(28);
    expect(parseRange(90)).toBe(90);
  });
  it("refuses everything else instead of rounding to a neighbour", () => {
    for (const bad of ["30", "6", "91", "0", "-7", "7.5", "abc", "", null, undefined, NaN, 29, {}]) expect(parseRange(bad)).toBeNull();
  });
});

describe("coerce", () => {
  it("drops rows without ids and takes the topic when a video has no title", () => {
    const out = coerceVideos([
      { video_id: "a", channel_id: "c", title: null, topic: "Topic", published_at: "2026-10-01T10:00:00", privacy: "private", video_format: "short" },
      { video_id: "", channel_id: "c" },
      { channel_id: "c" },
      null,
      "x",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Topic", format: "short", channelId: "c" });
    expect(coerceVideos({})).toEqual([]);
  });
  it("turns a negative, non-finite or non-number figure into null, never 0, and skips a row with an unreadable date", () => {
    const out = coerceSnapshots([
      { video_id: "a", snapshot_date: "2026-10-24", views: -5, likes: "7", comment_count: Infinity, watch_time_minutes: NaN, average_view_duration_seconds: 0, impressions: 12 },
      { video_id: "a", snapshot_date: "not a date", views: 1 },
      { video_id: "a", views: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ views: null, likes: null, comments: null, watchMinutes: null, avgViewSeconds: 0, impressions: 12 });
  });
});

describe("buildVideoResults: which videos, which reading", () => {
  it("keeps a video published exactly at the window start and drops one a millisecond earlier", () => {
    const start = windowStart(NOW, 28);
    const rows = buildVideoResults(
      [video({ videoId: "in", publishedAt: iso(start) }), video({ videoId: "out", publishedAt: iso(start - 1) })],
      [],
      NOW,
      28,
    );
    expect(rows.map((r) => r.videoId)).toEqual(["in"]);
  });
  it("leaves out a held run (no publish time) and a publish time in the future", () => {
    const rows = buildVideoResults([video({ videoId: "held", publishedAt: null }), video({ videoId: "future", publishedAt: iso(NOW + 1000) }), video({ videoId: "ok" })], [], NOW, 7);
    expect(rows.map((r) => r.videoId)).toEqual(["ok"]);
  });
  it("reads a stored bot timestamp with no zone as UTC, not local time", () => {
    const rows = buildVideoResults([video({ publishedAt: "2026-10-24T12:00:00.123456" })], [], NOW, 7);
    expect(rows).toHaveLength(1);
  });
  it("takes the NEWEST reading by date, whatever the order, and does not add readings together", () => {
    const rows = buildVideoResults(
      [video()],
      [snap({ snapshotDate: "2026-10-24", views: 300 }), snap({ snapshotDate: "2026-10-23", views: 999 }), snap({ snapshotDate: "2026-10-22", views: 5 })],
      NOW,
      28,
    );
    expect(rows[0].reading?.views).toBe(300);
    expect(rows[0].reading?.date).toBe("2026-10-24");
  });
  it("for two readings of the same day, the later row wins (the poll overwrites a day)", () => {
    const rows = buildVideoResults([video()], [snap({ views: 1 }), snap({ views: 2 })], NOW, 28);
    expect(rows[0].reading?.views).toBe(2);
  });
  it("a video with no reading has reading null: not measured, not zero", () => {
    const rows = buildVideoResults([video()], [snap({ videoId: "someone-else" })], NOW, 28);
    expect(rows[0].reading).toBeNull();
  });
  it("counts UTC calendar days between publishing and the reading, 0 for the same day; a reading dated before the upload is skipped", () => {
    const pub = Date.UTC(2026, 9, 20, 15, 0, 0);
    const mk = (date: string) => buildVideoResults([video({ publishedAt: iso(pub) })], [snap({ snapshotDate: date })], NOW, 28)[0].reading?.daysAfterPublish;
    expect(mk("2026-10-20")).toBe(0); // dated the day of the upload, though 00:00 is before 15:00
    expect(mk("2026-10-21")).toBe(1);
    expect(mk("2026-10-22")).toBe(2);
    expect(mk("2026-10-19")).toBeUndefined(); // dated before the upload: not a reading of this video at all
  });
  it("lists newest first with a stable tie-break", () => {
    const t = iso(NOW - DAY);
    const rows = buildVideoResults([video({ videoId: "b", publishedAt: t }), video({ videoId: "a", publishedAt: t }), video({ videoId: "c", publishedAt: iso(NOW - 3 * DAY) })], [], NOW, 7);
    expect(rows.map((r) => r.videoId)).toEqual(["a", "b", "c"]);
  });
});

describe("what is not a reading", () => {
  const empty = (over: Partial<SnapshotInput> = {}) => snap({ views: 0, likes: 0, comments: 0, watchMinutes: 0, avgViewSeconds: 0, ...over });
  it("a snapshot whose five figures are all exactly 0 is empty; one non-zero or null figure makes it a reading", () => {
    expect(isEmptyReading(empty())).toBe(true);
    for (const k of ["views", "likes", "comments", "watchMinutes", "avgViewSeconds"] as const) {
      expect(isEmptyReading(empty({ [k]: 1 })), k).toBe(false);
      expect(isEmptyReading(empty({ [k]: null })), `${k} null`).toBe(false);
    }
  });
  it("an all-zero snapshot is 'no data', not '0 views': no reading, flagged noData", () => {
    const [row] = buildVideoResults([video()], [empty()], NOW, 28);
    expect(row.reading).toBeNull();
    expect(row.noData).toBe(true);
    const k = computeKpis([row]);
    expect(k).toMatchObject({ videos: 1, measured: 0, noData: 1 });
    expect(k.views).toEqual({ value: null, known: 0, of: 1 });
  });
  it("an empty newest snapshot does not hide an older real one; the older reading is used", () => {
    const [row] = buildVideoResults([video()], [snap({ snapshotDate: "2026-10-23", views: 40 }), empty({ snapshotDate: "2026-10-24" })], NOW, 28);
    expect(row.reading?.views).toBe(40);
    expect(row.reading?.date).toBe("2026-10-23");
    expect(row.noData).toBe(false);
  });
  it("a video with no snapshot at all is not measured but is NOT 'noData'", () => {
    const [row] = buildVideoResults([video()], [], NOW, 28);
    expect(row).toMatchObject({ reading: null, noData: false });
  });
  it("a real zero (views 0 but a like) stays a measured 0", () => {
    const [row] = buildVideoResults([video()], [empty({ likes: 1 })], NOW, 28);
    expect(row.reading?.views).toBe(0);
    expect(row.noData).toBe(false);
  });
  it("a zero duration next to views is unknown, so it cannot drag the weighted average down", () => {
    const rows = buildVideoResults(
      [video({ videoId: "a" }), video({ videoId: "b" })],
      [snap({ videoId: "a", views: 1000, avgViewSeconds: 0 }), snap({ videoId: "b", views: 10, avgViewSeconds: 100 })],
      NOW,
      28,
    );
    expect(rows.find((r) => r.videoId === "a")?.reading?.avgViewSeconds).toBeNull();
    expect(rows.find((r) => r.videoId === "a")?.reading?.views).toBe(1000);
    const k = computeKpis(rows);
    expect(k.avgViewSeconds).toEqual({ value: 100, known: 1, of: 2 });
  });
  it("a zero duration with zero views is left as read (there are no views to weigh it by)", () => {
    const [row] = buildVideoResults([video()], [snap({ views: 0, likes: 1, avgViewSeconds: 0 })], NOW, 28);
    expect(row.reading?.avgViewSeconds).toBe(0);
  });
  it("a snapshot dated before the video's publish day is skipped, one dated the same day is kept", () => {
    const pub = Date.UTC(2026, 9, 20, 15, 0, 0);
    const v = video({ publishedAt: iso(pub) });
    const [early] = buildVideoResults([v], [snap({ snapshotDate: "2026-10-19", views: 999 })], NOW, 28);
    expect(early.reading).toBeNull();
    expect(early.noData).toBe(false);
    const [mixed] = buildVideoResults([v], [snap({ snapshotDate: "2026-10-19", views: 999 }), snap({ snapshotDate: "2026-10-20", views: 7 })], NOW, 28);
    expect(mixed.reading?.views).toBe(7);
  });
});

const result = (id: string, reading: Partial<NonNullable<VideoResult["reading"]>> | null, noData = false): VideoResult => ({
  videoId: id,
  channelId: "c1",
  title: id,
  publishedAt: iso(NOW - DAY),
  privacy: null,
  format: null,
  noData,
  reading: reading === null ? null : { date: "2026-10-24", daysAfterPublish: 1, views: null, likes: null, comments: null, watchMinutes: null, avgViewSeconds: null, impressions: null, ...reading },
});

describe("computeKpis", () => {
  it("sums only the known figures and says how many videos each covers", () => {
    const k = computeKpis([result("a", { views: 100, likes: 5 }), result("b", { views: 50 }), result("c", null)]);
    expect(k.videos).toBe(3);
    expect(k.measured).toBe(2);
    expect(k.views).toEqual({ value: 150, known: 2, of: 3 });
    expect(k.likes).toEqual({ value: 5, known: 1, of: 3 });
  });
  it("a figure no video has is null, not 0; a real zero is 0", () => {
    const none = computeKpis([result("a", null), result("b", { views: null })]);
    expect(none.views).toEqual({ value: null, known: 0, of: 2 });
    expect(none.watchHours.value).toBeNull();
    expect(none.avgViewSeconds.value).toBeNull();
    const zero = computeKpis([result("a", { views: 0 })]);
    expect(zero.views).toEqual({ value: 0, known: 1, of: 1 });
  });
  it("an empty set has no figures at all", () => {
    const k = computeKpis([]);
    expect(k).toMatchObject({ videos: 0, measured: 0 });
    expect(k.views).toEqual({ value: null, known: 0, of: 0 });
  });
  it("watch time is minutes over 60", () => {
    expect(computeKpis([result("a", { watchMinutes: 90 }), result("b", { watchMinutes: 30 })]).watchHours.value).toBe(2);
  });
  it("weights the average view duration by views, so a 2-view video cannot drag a 2,000-view one", () => {
    const k = computeKpis([result("big", { views: 2000, avgViewSeconds: 100 }), result("tiny", { views: 2, avgViewSeconds: 10 })]);
    expect(k.avgViewSeconds.value).toBeCloseTo((2000 * 100 + 2 * 10) / 2002, 6);
    expect(k.avgViewSeconds).toMatchObject({ known: 2, of: 2 });
  });
  it("a video missing either the duration or the views takes no part in the average, and zero total views means no average", () => {
    const k = computeKpis([result("a", { views: 10, avgViewSeconds: 60 }), result("b", { views: null, avgViewSeconds: 999 }), result("c", { views: 50, avgViewSeconds: null })]);
    expect(k.avgViewSeconds).toEqual({ value: 60, known: 1, of: 3 });
    expect(computeKpis([result("z", { views: 0, avgViewSeconds: 50 })]).avgViewSeconds).toEqual({ value: null, known: 1, of: 1 });
  });
});

describe("topByViews", () => {
  it("ranks by views, leaves out the unmeasured, breaks ties by id and honours n", () => {
    const rows = [result("c", { views: 10 }), result("a", { views: 10 }), result("x", null), result("n", { views: null }), result("b", { views: 99 })];
    expect(topByViews(rows, 3).map((r) => r.videoId)).toEqual(["b", "a", "c"]);
    // asked for more than there are measured videos: the one with no views figure is still not ranked
    expect(topByViews(rows, 10).map((r) => r.videoId)).toEqual(["b", "a", "c"]);
    expect(topByViews(rows, 1).map((r) => r.videoId)).toEqual(["b"]);
    expect(topByViews(rows, 0)).toEqual([]);
    expect(topByViews(rows, -2)).toEqual([]);
  });
  it("does not reorder the list it was given", () => {
    const rows = [result("c", { views: 1 }), result("a", { views: 9 })];
    topByViews(rows, 5);
    expect(rows.map((r) => r.videoId)).toEqual(["c", "a"]);
  });
});

describe("freshness", () => {
  it("no reading at all is not stale: there is nothing to be late", () => {
    expect(freshness([], NOW)).toEqual({ asOf: null, ageDays: null, stale: false });
    expect(freshness([null, undefined, "garbage"], NOW)).toEqual({ asOf: null, ageDays: null, stale: false });
  });
  it("takes the newest date whatever the order, and counts whole days", () => {
    const f = freshness(["2026-10-20", "2026-10-24", "2026-10-22"], NOW);
    expect(f).toEqual({ asOf: "2026-10-24", ageDays: 1, stale: false });
  });
  it(`is stale only beyond ${STALE_AFTER_DAYS} days`, () => {
    const day = (n: number) => iso(Date.UTC(2026, 9, 25 - n)).slice(0, 10);
    expect(freshness([day(STALE_AFTER_DAYS)], NOW).stale).toBe(false);
    expect(freshness([day(STALE_AFTER_DAYS + 1)], NOW).stale).toBe(true);
    expect(freshness([day(STALE_AFTER_DAYS + 1)], NOW).ageDays).toBe(STALE_AFTER_DAYS + 1);
  });
  it("a reading dated after now is age 0, never negative", () => {
    expect(freshness(["2026-10-27"], NOW).ageDays).toBe(0);
  });
});

const req = (over: Partial<RequestInput> = {}): RequestInput => ({
  id: 1,
  videoId: "vid00000001",
  platform: "instagram",
  status: "published",
  reason: null,
  privacy: null,
  resultUrl: "https://example.com/p/1",
  createdAt: iso(NOW - 3 * DAY),
  target: "@me",
  ...over,
});

describe("buildHistory", () => {
  const titles = new Map<string, string | null>([["vid00000001", "A title"]]);
  it("merges the pipeline's own upload and the cross-posts, newest first", () => {
    const out = buildHistory([{ ...video(), channelName: "Main" }], [req()], titles, NOW, 28);
    expect(out.map((e) => e.key)).toEqual(["up:vid00000001", "rq:1"]);
    expect(out[0]).toMatchObject({ kind: "upload", platform: "youtube", target: "Main", status: "uploaded", privacy: "private" });
    expect(out[1]).toMatchObject({ kind: "request", platform: "instagram", target: "@me", videoTitle: "A title" });
  });
  it("says 'uploaded' for a published request without claiming the privacy; a missing privacy stays null", () => {
    const out = buildHistory([], [req({ status: "published", privacy: null })], titles, NOW, 28);
    expect(out[0].status).toBe("uploaded");
    expect(out[0].privacy).toBeNull();
    expect(historyStatus("published")).toBe("uploaded");
    expect(historyStatus("refused")).toBe("refused");
    expect(historyStatus("mystery")).toBe("failed");
  });
  it("dates a request by when it was made (created_at, the same date the window filters by) and keeps only the window", () => {
    const inside = req({ id: 2, createdAt: iso(NOW - DAY) });
    const outside = req({ id: 3, createdAt: iso(windowStart(NOW, 7) - 1) });
    const out = buildHistory([], [inside, outside], titles, NOW, 7);
    expect(out.map((e) => e.key)).toEqual(["rq:2"]);
    expect(out[0].at).toBe(inside.createdAt);
  });
  it("shows a result link only when it is https", () => {
    const out = buildHistory([], [req({ id: 4, resultUrl: "http://x.test" }), req({ id: 5, resultUrl: "javascript:alert(1)" }), req({ id: 6 })], titles, NOW, 28);
    expect(out.find((e) => e.key === "rq:4")?.url).toBeNull();
    expect(out.find((e) => e.key === "rq:5")?.url).toBeNull();
    expect(out.find((e) => e.key === "rq:6")?.url).toBe("https://example.com/p/1");
  });
  it("cuts the list at the limit after sorting, so the oldest entries are the ones that go", () => {
    const many = Array.from({ length: 5 }, (_, i) => req({ id: i + 10, createdAt: iso(NOW - (i + 1) * 3600_000) }));
    const out = buildHistory([], many, titles, NOW, 7, 3);
    expect(out.map((e) => e.key)).toEqual(["rq:10", "rq:11", "rq:12"]);
    expect(MAX_HISTORY).toBeGreaterThan(3);
  });
  it("an untitled or unknown video keeps the entry with a null title", () => {
    const out = buildHistory([], [req({ videoId: "gone" })], titles, NOW, 28);
    expect(out[0].videoTitle).toBeNull();
  });
});

describe("format", () => {
  it("formats durations as m:ss and h:mm:ss, and has no text for nonsense", () => {
    expect(formatDuration(125)).toBe("2:05");
    expect(formatDuration(59.6)).toBe("1:00");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(-1)).toBeNull();
    expect(formatDuration(NaN)).toBeNull();
  });
  it("groups counts per locale and keeps one decimal of hours under 100", () => {
    expect(formatCount(1234567, "en")).toBe("1,234,567");
    expect(formatCount(1234.6, "en")).toBe("1,235");
    expect(formatHours(3.456, "en")).toBe("3.5");
    expect(formatHours(150.4, "en")).toBe("150");
  });
  it("reads a stored timestamp as a UTC day", () => {
    expect(dayOf("2026-10-24T23:30:00")).toBe("2026-10-24");
    expect(dayOf("2026-10-24")).toBe("2026-10-24");
    expect(dayOf(null)).toBeNull();
    expect(dayOf("nope")).toBeNull();
  });
  it("sizes a bar against the largest value: a real zero is empty, a small real value stays visible, nothing exceeds 100", () => {
    expect(barPercent(0, 100)).toBe(0);
    expect(barPercent(1, 1000)).toBe(2);
    expect(barPercent(50, 100)).toBe(50);
    expect(barPercent(200, 100)).toBe(100);
    expect(barPercent(5, 0)).toBe(0);
    expect(barPercent(NaN, 10)).toBe(0);
  });
});

describe("platform registry", () => {
  it("draws one card per platform in registry order and never a number for a platform without results", () => {
    const cards = platformCards({ youtube: 2, instagram: 1, tiktok: 0 });
    expect(cards.map((c) => c.id)).toEqual(PLATFORMS.map((p) => p.id));
    const by = Object.fromEntries(cards.map((c) => [c.id, c]));
    expect(by.youtube).toMatchObject({ state: "live", connected: 2 });
    expect(by.instagram).toMatchObject({ state: "connected_results_coming", connected: 1 });
    expect(by.tiktok).toMatchObject({ state: "not_connected", connected: 0 });
    expect(by.x).toMatchObject({ state: "coming", connected: 0 });
    expect(by.facebook).toMatchObject({ state: "coming", connected: 0 });
  });
  it("an unread platform is 'unknown', not 'not connected'; a platform nobody can connect stays 'coming' whatever was read", () => {
    const cards = Object.fromEntries(platformCards({ youtube: 1, instagram: null, x: 5 }).map((c) => [c.id, c]));
    expect(cards.instagram.state).toBe("unknown");
    expect(cards.tiktok.state).toBe("unknown");
    expect(cards.x).toMatchObject({ state: "coming", connected: 0 });
  });
  it("a platform nobody can connect is 'coming' whatever count it is given, even an unknown one", () => {
    const x = { id: "x", worker: "none", publish: "none", results: "planned" } as const;
    for (const n of [null, 0, 5, NaN]) expect(platformState(x, n)).toBe("coming");
  });
  it("a connected platform whose results are live is the only 'live' card", () => {
    expect(platformState({ id: "youtube", worker: "live", publish: "available", results: "live" }, 0)).toBe("not_connected");
    expect(platformState({ id: "youtube", worker: "live", publish: "available", results: "live" }, 1)).toBe("live");
    expect(platformState({ id: "tiktok", worker: "live", publish: "available", results: "planned" }, 3)).toBe("connected_results_coming");
    expect(platformState({ id: "tiktok", worker: "live", publish: "available", results: "planned" }, NaN)).toBe("not_connected");
  });
});
