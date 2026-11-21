import { describe, expect, it } from "vitest";
import { experimentEffect, experimentStatus, hookExperiment, thumbnailExperiment } from "@/lib/experiments";
import { MIN_PER_VARIANT, hookPerformance, variantPerformance } from "@/lib/measurement";
import type { MetricsSnapshotRow, VideoRow } from "@/lib/types";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

function rows(
  field: "thumbnail_variant" | "hook_variant",
  metric: "impression_ctr" | "average_view_duration_seconds",
  arms: Record<string, { n: number; value: number | null }>,
): { videos: VideoRow[]; snaps: MetricsSnapshotRow[] } {
  const videos: VideoRow[] = [];
  const snaps: MetricsSnapshotRow[] = [];
  for (const [arm, { n, value }] of Object.entries(arms)) {
    for (let i = 0; i < n; i++) {
      const id = `${field}-${arm}${i}`;
      videos.push({ video_id: id, [field]: arm } as unknown as VideoRow);
      snaps.push({ video_id: id, snapshot_date: "2026-09-01", [metric]: value, impressions: 100 } as unknown as MetricsSnapshotRow);
    }
  }
  return { videos, snaps };
}

const thumb = (arms: Record<string, { n: number; value: number | null }>) => {
  const { videos, snaps } = rows("thumbnail_variant", "impression_ctr", arms);
  return thumbnailExperiment(variantPerformance(videos, snaps));
};
const hook = (arms: Record<string, { n: number; value: number | null }>) => {
  const { videos, snaps } = rows("hook_variant", "average_view_duration_seconds", arms);
  return hookExperiment(hookPerformance(videos, snaps));
};

describe("thumbnail experiment", () => {
  it("is running below the minimum sample, with no winner or effect", () => {
    const e = thumb({ A: { n: MIN_PER_VARIANT, value: 0.02 }, B: { n: MIN_PER_VARIANT - 1, value: 0.09 } });
    expect(e.status).toBe("running");
    expect(e.winner).toBeNull();
    expect(e.effect).toBeNull();
    expect(e.variants.map((v) => `${v.label}:${v.samples}`)).toEqual([`A:${MIN_PER_VARIANT}`, `B:${MIN_PER_VARIANT - 1}`]);
  });

  it("is inconclusive — not a guessed winner — under the lift floor", () => {
    const e = thumb({ A: { n: MIN_PER_VARIANT, value: 0.05 }, B: { n: MIN_PER_VARIANT, value: 0.052 } });
    expect(e.status).toBe("inconclusive");
    expect(e.winner).toBeNull();
    expect(e.effect).toBeCloseTo(0.04, 6);
  });

  it("is decided exactly when the existing rule names a winner", () => {
    const e = thumb({ A: { n: MIN_PER_VARIANT, value: 0.04 }, B: { n: MIN_PER_VARIANT, value: 0.06 } });
    expect(e.status).toBe("decided");
    expect(e.winner).toBe("B");
    expect(e.effect).toBeCloseTo(0.5, 6);
    // Stable A,B order even though the result lists the winner first.
    expect(e.variants.map((v) => v.label)).toEqual(["A", "B"]);
  });

  it("does not count an unmeasured video as a sample", () => {
    const e = thumb({ A: { n: MIN_PER_VARIANT, value: null }, B: { n: MIN_PER_VARIANT, value: 0.06 } });
    expect(e.samples).toBe(MIN_PER_VARIANT);
    expect(e.status).toBe("running");
  });
});

describe("hook experiment", () => {
  it("covers running, inconclusive and decided", () => {
    expect(hook({ A: { n: 1, value: 100 }, B: { n: MIN_PER_VARIANT, value: 150 } }).status).toBe("running");
    expect(hook({ A: { n: MIN_PER_VARIANT, value: 100 }, B: { n: MIN_PER_VARIANT, value: 105 } }).status).toBe("inconclusive");
    const d = hook({ A: { n: MIN_PER_VARIANT, value: 100 }, B: { n: MIN_PER_VARIANT, value: 150 } });
    expect(d.status).toBe("decided");
    expect(d.winner).toBe("B");
    expect(d.metric).toBe("average_view_duration_seconds");
  });
});

describe("status / effect primitives", () => {
  it("never claims an effect from a zero runner-up", () => {
    const v = [
      { label: "A", samples: MIN_PER_VARIANT, value: 0 },
      { label: "B", samples: MIN_PER_VARIANT, value: 0.06 },
    ];
    expect(experimentStatus(v, null)).toBe("inconclusive");
    expect(experimentEffect(v)).toBeNull();
  });
});

describe("i18n", () => {
  it("has the experiment keys in en/ru/uz", () => {
    const keys = (o: object) => Object.keys(o).filter((k) => k.startsWith("exp")).sort();
    expect(keys(ru.measure)).toEqual(keys(en.measure));
    expect(keys(uz.measure)).toEqual(keys(en.measure));
    expect(keys(en.measure).length).toBeGreaterThan(0);
  });
});
