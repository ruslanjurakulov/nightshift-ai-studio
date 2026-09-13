import { describe, expect, it } from "vitest";
import {
  aggregateRetention,
  summariseCosts,
  variantPerformance,
  MIN_PER_VARIANT,
} from "@/lib/measurement";
import type {
  MetricsSnapshotRow,
  RetentionPointRow,
  VideoCostRow,
  VideoRow,
} from "@/lib/types";

let costSeq = 0;
function cost(over: Partial<VideoCostRow> & { unit: string; quantity: number }): VideoCostRow {
  costSeq += 1;
  return {
    id: costSeq,
    // `?? ` would swallow an explicit null, which is exactly the pre-upload
    // case one of these tests is about.
    video_id: "video_id" in over ? over.video_id! : "v1",
    channel_id: over.channel_id ?? "default",
    slug: over.slug ?? null,
    unit: over.unit,
    quantity: over.quantity,
    stage: over.stage ?? null,
    estimated_usd: over.estimated_usd ?? null,
    recorded_at: over.recorded_at ?? "2026-01-01T00:00:00Z",
  };
}

function video(over: Partial<VideoRow> & { video_id: string }): VideoRow {
  return {
    video_id: over.video_id,
    channel_id: over.channel_id ?? "default",
    topic: null,
    title: over.title ?? over.video_id,
    slug: null,
    published_at: over.published_at ?? "2026-01-01T00:00:00Z",
    privacy: null,
    category_id: null,
    local_path: null,
    thumbnail_variant: over.thumbnail_variant ?? null,
    title_variant: over.title_variant ?? null,
    video_format: over.video_format ?? "long",
    parent_video_id: over.parent_video_id ?? null,
    preview_path: null,
    script_text: null,
    review_state: "pending",
  };
}

function snap(
  over: Partial<MetricsSnapshotRow> & { video_id: string; snapshot_date: string },
): MetricsSnapshotRow {
  return {
    video_id: over.video_id,
    snapshot_date: over.snapshot_date,
    views: over.views ?? 100,
    likes: null,
    comment_count: null,
    watch_time_minutes: null,
    average_view_duration_seconds: null,
    impressions: over.impressions ?? null,
    impression_ctr: over.impression_ctr ?? null,
  };
}

function point(video_id: string, elapsed: number, watch: number | null): RetentionPointRow {
  return {
    video_id,
    elapsed_ratio: elapsed,
    watch_ratio: watch,
    measured_date: "2026-01-02",
  };
}

/** Five points is the floor for one usable curve. */
function curveFor(video_id: string, watches: number[]): RetentionPointRow[] {
  return watches.map((w, i) => point(video_id, i / (watches.length - 1), w));
}

describe("summariseCosts", () => {
  it("reports no total for a video with any unpriced unit, and names that unit", () => {
    const summary = summariseCosts([
      cost({ unit: "tts_characters", quantity: 4000, estimated_usd: 0.06 }),
      cost({ unit: "render_seconds", quantity: 120, estimated_usd: null }),
    ]);
    expect(summary.videos).toHaveLength(1);
    // Not 0.06: a partial total would understate the real cost.
    expect(summary.videos[0].usd).toBeNull();
    expect(summary.videos[0].unpricedUnits).toEqual(["render_seconds"]);
    expect(summary.totalUsd).toBeNull();
    expect(summary.unpricedUnits).toEqual(["render_seconds"]);
  });

  it("sums only fully priced videos and still counts the rest as measured", () => {
    const summary = summariseCosts([
      cost({ video_id: "a", unit: "tts_characters", quantity: 1, estimated_usd: 1 }),
      cost({ video_id: "a", unit: "render_seconds", quantity: 1, estimated_usd: 0.5 }),
      cost({ video_id: "b", unit: "render_seconds", quantity: 1, estimated_usd: null }),
    ]);
    expect(summary.totalUsd).toBeCloseTo(1.5);
    expect(summary.pricedVideos).toBe(1);
    expect(summary.measuredVideos).toBe(2);
    expect(summary.meanUsd).toBeCloseTo(1.5);
  });

  it("always reports quantities, priced or not", () => {
    const summary = summariseCosts([
      cost({ video_id: "a", unit: "render_seconds", quantity: 30 }),
      cost({ video_id: "b", unit: "render_seconds", quantity: 12 }),
    ]);
    expect(summary.quantityByUnit.render_seconds).toBe(42);
  });

  it("keeps pre-upload rows apart by slug rather than merging them", () => {
    const summary = summariseCosts([
      cost({ video_id: null, slug: "run-one", unit: "render_seconds", quantity: 1 }),
      cost({ video_id: null, slug: "run-two", unit: "render_seconds", quantity: 1 }),
    ]);
    expect(summary.measuredVideos).toBe(2);
  });
});

describe("variantPerformance", () => {
  function arm(variant: "A" | "B", ctrs: (number | null)[]) {
    const videos: VideoRow[] = [];
    const snapshots: MetricsSnapshotRow[] = [];
    ctrs.forEach((ctr, i) => {
      const id = `${variant}${i}`;
      videos.push(video({ video_id: id, thumbnail_variant: variant }));
      snapshots.push(
        snap({ video_id: id, snapshot_date: "2026-01-02", impression_ctr: ctr, impressions: 1000 }),
      );
    });
    return { videos, snapshots };
  }

  it("refuses a verdict below the per-arm evidence floor", () => {
    const a = arm("A", [0.1, 0.1]);
    const b = arm("B", [0.05, 0.05]);
    const result = variantPerformance(
      [...a.videos, ...b.videos],
      [...a.snapshots, ...b.snapshots],
    );
    // A is twice as good, and it still does not get to be the winner on 2 videos.
    expect(result.winner).toBeNull();
    expect(result.reason).toBe("needs_more_videos");
  });

  it("calls a winner once both arms clear the floor and the gap clears the lift", () => {
    const a = arm("A", Array(MIN_PER_VARIANT).fill(0.1));
    const b = arm("B", Array(MIN_PER_VARIANT).fill(0.05));
    const result = variantPerformance(
      [...a.videos, ...b.videos],
      [...a.snapshots, ...b.snapshots],
    );
    expect(result.winner).toBe("A");
    expect(result.reason).toBe("decided");
    expect(result.lift).toBeCloseTo(1);
  });

  it("treats a gap under the lift floor as a tie, not a win", () => {
    const a = arm("A", Array(MIN_PER_VARIANT).fill(0.102));
    const b = arm("B", Array(MIN_PER_VARIANT).fill(0.1));
    const result = variantPerformance(
      [...a.videos, ...b.videos],
      [...a.snapshots, ...b.snapshots],
    );
    expect(result.winner).toBeNull();
    expect(result.reason).toBe("under_lift_floor");
  });

  it("excludes an unmeasured video instead of averaging it in as zero CTR", () => {
    const a = arm("A", [...Array(MIN_PER_VARIANT).fill(0.1), null]);
    const b = arm("B", Array(MIN_PER_VARIANT).fill(0.05));
    const result = variantPerformance(
      [...a.videos, ...b.videos],
      [...a.snapshots, ...b.snapshots],
    );
    expect(result.a.videos).toBe(MIN_PER_VARIANT);
    // Unchanged by the unmeasured video — a null CTR is unknown, not a zero.
    expect(result.a.meanCtr).toBeCloseTo(0.1);
  });

  it("ignores videos published before the experiment existed", () => {
    const result = variantPerformance(
      [video({ video_id: "old", thumbnail_variant: null })],
      [snap({ video_id: "old", snapshot_date: "2026-01-02", impression_ctr: 0.5 })],
    );
    expect(result.a.videos).toBe(0);
    expect(result.b.videos).toBe(0);
  });

  it("uses only the newest snapshot per video", () => {
    const videos = [video({ video_id: "v", thumbnail_variant: "A" })];
    const snapshots = [
      snap({ video_id: "v", snapshot_date: "2026-01-01", impression_ctr: 0.9 }),
      snap({ video_id: "v", snapshot_date: "2026-01-05", impression_ctr: 0.2 }),
    ];
    expect(variantPerformance(videos, snapshots).a.meanCtr).toBeCloseTo(0.2);
  });

  // Roadmap #58: the reader is N-arm. A/B always appear; C/D only when shipped.
  function armN(variant: string, ctrs: (number | null)[]) {
    const videos: VideoRow[] = [];
    const snapshots: MetricsSnapshotRow[] = [];
    ctrs.forEach((ctr, i) => {
      const id = `${variant}${i}`;
      videos.push(video({ video_id: id, thumbnail_variant: variant }));
      snapshots.push(
        snap({ video_id: id, snapshot_date: "2026-01-02", impression_ctr: ctr, impressions: 1000 }),
      );
    });
    return { videos, snapshots };
  }

  it("keeps only A and B in arms when no wider variant shipped", () => {
    const a = armN("A", Array(MIN_PER_VARIANT).fill(0.1));
    const b = armN("B", Array(MIN_PER_VARIANT).fill(0.08));
    const result = variantPerformance([...a.videos, ...b.videos], [...a.snapshots, ...b.snapshots]);
    expect(result.arms.map((x) => x.variant).sort()).toEqual(["A", "B"]);
  });

  it("ranks a widened C arm as the winner when it clears the lift", () => {
    const a = armN("A", Array(MIN_PER_VARIANT).fill(0.1));
    const b = armN("B", Array(MIN_PER_VARIANT).fill(0.09));
    const c = armN("C", Array(MIN_PER_VARIANT).fill(0.2));
    const result = variantPerformance(
      [...a.videos, ...b.videos, ...c.videos],
      [...a.snapshots, ...b.snapshots, ...c.snapshots],
    );
    expect(result.winner).toBe("C");
    expect(result.reason).toBe("decided");
    // The winner leads the arms list, and C is present as a real arm.
    expect(result.arms[0].variant).toBe("C");
    expect(result.arms.map((x) => x.variant).sort()).toEqual(["A", "B", "C"]);
  });

  it("needs at least two measured arms, not just one strong one", () => {
    const a = armN("A", Array(MIN_PER_VARIANT).fill(0.2));
    const b = armN("B", [0.05]); // under the floor
    const result = variantPerformance([...a.videos, ...b.videos], [...a.snapshots, ...b.snapshots]);
    expect(result.winner).toBeNull();
    expect(result.reason).toBe("needs_more_videos");
  });
});

describe("aggregateRetention", () => {
  it("drops curves with too few points to describe anything", () => {
    const curve = aggregateRetention([point("v", 0, 1), point("v", 0.5, 0.4)]);
    expect(curve.videos).toBe(0);
    expect(curve.enough).toBe(false);
    expect(curve.points).toHaveLength(0);
  });

  it("averages usable curves and flags when there are too few to be a pattern", () => {
    const curve = aggregateRetention([
      ...curveFor("a", [1, 0.8, 0.6, 0.5, 0.4]),
      ...curveFor("b", [1, 0.6, 0.4, 0.3, 0.2]),
    ]);
    expect(curve.videos).toBe(2);
    expect(curve.enough).toBe(false); // MIN_CURVES is 3
    expect(curve.points[1].watch).toBeCloseTo(0.7);
  });

  it("finds the hook and the largest cliff once there are enough curves", () => {
    // Flat until 50%, then a 40-point fall — the cliff is at 0.5, not at the end.
    const shape = [1, 0.95, 0.9, 0.5, 0.45, 0.4, 0.35];
    const curve = aggregateRetention([
      ...curveFor("a", shape),
      ...curveFor("b", shape),
      ...curveFor("c", shape),
    ]);
    expect(curve.enough).toBe(true);
    expect(curve.cliffAt).toBeCloseTo(2 / 6);
    expect(curve.cliffDrop).toBeCloseTo(0.4);
    expect(curve.hookRetention).toBeCloseTo(1); // only the 0.0 point is within the hook window
  });

  it("names no cliff when retention decays evenly", () => {
    const shape = [1, 0.98, 0.96, 0.94, 0.92, 0.9];
    const curve = aggregateRetention([
      ...curveFor("a", shape),
      ...curveFor("b", shape),
      ...curveFor("c", shape),
    ]);
    expect(curve.cliffAt).toBeNull();
    expect(curve.cliffDrop).toBeNull();
  });

  it("skips points that were never measured", () => {
    const rows = curveFor("a", [1, 0.8, 0.6, 0.5, 0.4]);
    rows[2].watch_ratio = null;
    const curve = aggregateRetention(rows);
    // Four measured points is under MIN_POINTS, so the whole curve is unusable.
    expect(curve.videos).toBe(0);
  });
});
