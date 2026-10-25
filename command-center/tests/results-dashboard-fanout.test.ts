/**
 * The results page reads metrics_snapshots in chunks of 25 videos, and splits a chunk whose answer reaches the server's row cap.
 * What would break without these: a 200-video page opening 8 queries at once (and 16, 32 ... as chunks split) on the member's
 * own session, a limiter that lets a fifth query in when a slot is handed over, a failed read that never gives its place
 * back (every later read waits for ever), or a bound that drops or reorders readings.
 */
import { describe, expect, it, vi } from "vitest";
import { SNAPSHOT_CONCURRENCY, createLimiter, loadResults } from "@/lib/server/results-dashboard";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const DAY = 86_400_000;
const ticks = async (n: number) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe("createLimiter", () => {
  it("never runs more than max at once, runs everything, and returns each task's own result", async () => {
    const run = createLimiter(3);
    let active = 0;
    let peak = 0;
    const out = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        run(async () => {
          active++;
          peak = Math.max(peak, active);
          await ticks(1 + (i % 4));
          active--;
          return i * 2;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
  });

  it("a bound below one still runs everything, one at a time, instead of waiting for ever", async () => {
    for (const bad of [0, -3]) {
      const run = createLimiter(bad);
      let active = 0;
      let peak = 0;
      const out = await Promise.all(
        [1, 2, 3].map((n) =>
          run(async () => {
            active++;
            peak = Math.max(peak, active);
            await ticks(2);
            active--;
            return n;
          }),
        ),
      );
      expect(out, String(bad)).toEqual([1, 2, 3]);
      expect(peak, String(bad)).toBe(1);
    }
  });

  it("starts waiting tasks in the order they were asked for", async () => {
    const run = createLimiter(1);
    const started: number[] = [];
    await Promise.all([0, 1, 2, 3].map((i) => run(async () => (started.push(i), ticks(2)))));
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it("a task that throws gives its place back, so later tasks still run", async () => {
    const run = createLimiter(1);
    const first = run(async () => {
      throw new Error("boom");
    });
    const second = run(async () => "after");
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("after");
    await expect(run(async () => "again")).resolves.toBe("again");
  });

  it("a task started while a slot is being handed over does not take a place beyond max", async () => {
    const run = createLimiter(1);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await ticks(2);
      active--;
    };
    const first = run(task);
    const waiting = run(task);
    await first; // its slot goes to `waiting`; a new call right now must queue behind it, not slip in
    const late = run(task);
    await Promise.all([waiting, late]);
    expect(peak).toBe(1);
  });
});

function fleet(videos: number, readingsEach: number) {
  const videoRows: Row[] = Array.from({ length: videos }, (_, i) => ({
    video_id: `vidF${String(i).padStart(7, "0")}`,
    channel_id: "chanA1",
    title: `Video ${i}`,
    topic: null,
    published_at: new Date(NOW - 20 * DAY).toISOString(),
    privacy: "private",
    video_format: "long",
  }));
  const snapshotRows: Row[] = videoRows.flatMap((v, i) =>
    Array.from({ length: readingsEach }, (_, d) => ({
      video_id: v.video_id,
      snapshot_date: `2026-10-${String(13 + d).padStart(2, "0")}`,
      views: 1000 + i,
      likes: 1,
      comment_count: 0,
      watch_time_minutes: 60,
      average_view_duration_seconds: 100,
      impressions: null,
    })),
  );
  return { videoRows, snapshotRows };
}

/** A fake client whose metrics_snapshots reads take a few ticks, so overlapping reads are visible. */
function fakeClient(videoRows: Row[], snapshotRows: Row[], serverCap: number) {
  const stats = { inFlight: 0, peak: 0, reads: 0 };
  const from = (table: string) => {
    let ids: unknown[] | null = null;
    let max = Infinity;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.not = () => q;
    q.gte = () => q;
    q.order = () => q;
    q.in = (col: string, vals: unknown[]) => {
      if (col === "video_id") ids = vals;
      return q;
    };
    q.limit = (n: number) => ((max = n), q);
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const work = async () => {
        if (table === "videos") return { data: videoRows, error: null };
        if (table !== "metrics_snapshots") return { data: [], error: null };
        stats.reads++;
        stats.inFlight++;
        stats.peak = Math.max(stats.peak, stats.inFlight);
        await ticks(5);
        stats.inFlight--;
        const rows = snapshotRows.filter((r) => (ids ?? []).includes(r.video_id));
        // newest first, then the server's own cut
        rows.sort((a, b) => String(b.snapshot_date).localeCompare(String(a.snapshot_date)));
        return { data: rows.slice(0, Math.min(max, serverCap)), error: null };
      };
      return work().then(resolve, reject);
    };
    return q;
  };
  return { client: { from } as never, stats };
}

const load = (client: never, snapshotCap?: number) =>
  loadResults({
    supabase: client,
    orgId: ORG,
    channels: [{ id: "chanA1", name: "Alpha", connected: true, orgId: ORG }],
    selected: null,
    days: 28,
    nowMs: NOW,
    snapshotCap,
  });

describe("the snapshot reads of one page", () => {
  it("the bound is four", () => {
    expect(SNAPSHOT_CONCURRENCY).toBe(4);
  });

  it("200 videos (8 chunks) read at most four at a time, and every video is still measured", async () => {
    const { videoRows, snapshotRows } = fleet(200, 3);
    const { client, stats } = fakeClient(videoRows, snapshotRows, 1000);
    const out = await load(client);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.payload.kpis).toMatchObject({ videos: 200, measured: 200 });
      expect(out.payload.truncated.snapshots).toBe(false);
    }
    expect(stats.reads).toBe(8);
    expect(stats.peak).toBe(SNAPSHOT_CONCURRENCY);
  });

  it("chunks that split against the row cap are bounded too, and nothing is lost to the bound", async () => {
    // 25 videos x 3 readings = 75 rows a chunk against a cap of 40: every chunk splits, and its halves split again.
    const { videoRows, snapshotRows } = fleet(100, 3);
    const { client, stats } = fakeClient(videoRows, snapshotRows, 40);
    const out = await load(client, 40);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.payload.kpis).toMatchObject({ videos: 100, measured: 100 });
      expect(out.payload.truncated.snapshots).toBe(false);
      expect(out.payload.videos.every((v) => v.reading?.date === "2026-10-15")).toBe(true);
    }
    expect(stats.reads).toBe(12); // 4 chunks, each read once whole and then as two halves
    expect(stats.peak).toBe(SNAPSHOT_CONCURRENCY);
  });

  it("a page of one chunk is read as before, with no wait", async () => {
    const { videoRows, snapshotRows } = fleet(10, 2);
    const { client, stats } = fakeClient(videoRows, snapshotRows, 1000);
    const out = await load(client);
    expect(out.ok && out.payload.kpis.measured).toBe(10);
    expect(stats.reads).toBe(1);
  });
});
