import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_WORST,
  cleanCurve,
  dropBarPercent,
  interpolate,
  isWorstScene,
  mapScenes,
  pctText,
  pointsText,
  summarizeSceneRetention,
  videoDuration,
  type RetentionPointInput,
  type SceneRetention,
  type SceneWindow,
} from "@/lib/sceneRetention";
import { scenesToStoryboard } from "@/lib/storyboard";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

/**
 * Scene-level retention: the YouTube curve mapped onto the Video IR's real
 * scene windows. The shared cases are the SAME file the Python twin
 * (modules/scene_retention.py) runs, so the page and the learning proposals
 * can never disagree about a scene's number — or about whether it has one.
 */

interface MappingCase {
  name: string;
  duration_s: number | null;
  points: RetentionPointInput[];
  scenes: SceneWindow[];
  expected: Array<{
    scene_id: string;
    retention_start: number | null;
    retention_end: number | null;
    drop: number | null;
    drop_per_min: number | null;
    rank: number | null;
  }>;
}

const CASES = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "..", "samples", "scene_retention_cases.json"), "utf-8"),
) as {
  mapping: MappingCase[];
  duration: Array<{ name: string; manifest: unknown; scenes: SceneWindow[] | null; expected: number | null }>;
};

function expectValue(got: number | null, want: number | null, what: string) {
  if (want === null) {
    expect(got, what).toBeNull();
  } else {
    expect(got, `${what} is unknown`).not.toBeNull();
    expect(got!, what).toBeCloseTo(want, 6);
  }
}

describe("shared cases (Python twin runs the same file)", () => {
  for (const c of CASES.mapping) {
    it(c.name, () => {
      const got = mapScenes(c.scenes, c.points, c.duration_s);
      expect(got).toHaveLength(c.expected.length);
      got.forEach((g, i) => {
        const e = c.expected[i];
        expect(g.sceneId).toBe(e.scene_id);
        expectValue(g.retentionStart, e.retention_start, `${e.scene_id}.retention_start`);
        expectValue(g.retentionEnd, e.retention_end, `${e.scene_id}.retention_end`);
        expectValue(g.drop, e.drop, `${e.scene_id}.drop`);
        expectValue(g.dropPerMin, e.drop_per_min, `${e.scene_id}.drop_per_min`);
        expect(g.rank).toBe(e.rank);
      });
    });
  }
  for (const c of CASES.duration) {
    it(`duration: ${c.name}`, () => {
      expect(videoDuration(c.manifest, c.scenes)).toBe(c.expected);
    });
  }
});

const LINEAR: RetentionPointInput[] = Array.from({ length: 11 }, (_, i) => ({
  elapsed_ratio: i / 10,
  watch_ratio: 1 - i / 20,
  measured_date: "2026-09-01",
}));

describe("interpolation", () => {
  it("never extrapolates past the measured range", () => {
    const curve = cleanCurve([0.1, 0.2, 0.3, 0.4, 0.5].map((r) => ({ elapsed_ratio: r, watch_ratio: 0.5 })));
    expect(interpolate(curve, 0.05)).toBeNull();
    expect(interpolate(curve, 0.55)).toBeNull();
    expect(interpolate(curve, 0.3)).toBe(0.5);
  });

  it("keeps the last scene's end measurable when rounding lands a hair past 100%", () => {
    const [row] = mapScenes([{ id: "s000", start_s: 50, end_s: 100.0000001 }], LINEAR, 100);
    expect(row.retentionEnd).toBeCloseTo(0.5, 6);
  });

  it("never throws on malformed rows, and reads them as unknown", () => {
    expect(mapScenes(null, null, null)).toEqual([]);
    const rows = mapScenes(
      [{ id: "s000", start_s: "soon" as unknown as number, end_s: null }, null as unknown as SceneWindow],
      LINEAR,
      100,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].drop).toBeNull();
    expect(rows[0].rank).toBeNull();
  });
});

describe("summarizeSceneRetention", () => {
  const scenes = [
    { id: "s000", name: "Hook", narration: "a", start_s: 0, end_s: 20 },
    { id: "s001", name: "Story", narration: "b", start_s: 20, end_s: 100 },
  ];
  const manifest = { audio: { duration_s: 100 } };

  it("is ok and keyed by the Storyboard's scene ids", () => {
    const sum = summarizeSceneRetention(scenes, manifest, LINEAR);
    expect(sum.status).toBe("ok");
    const board = scenesToStoryboard(scenes);
    for (const s of board.scenes) expect(sum.byId.has(s.sceneId!)).toBe(true);
  });

  it("falls back to position ids exactly as the Storyboard does", () => {
    const noIds = scenes.map((s) => ({ ...s, id: undefined }));
    const sum = summarizeSceneRetention(noIds, manifest, LINEAR);
    expect([...sum.byId.keys()]).toEqual(scenesToStoryboard(noIds).scenes.map((s) => s.sceneId));
  });

  it("says no_curve when the video has no usable curve", () => {
    expect(summarizeSceneRetention(scenes, manifest, []).status).toBe("no_curve");
    expect(summarizeSceneRetention(scenes, manifest, LINEAR.slice(0, 4)).status).toBe("no_curve");
  });

  it("says no_timing when there is a curve but no measured scene times", () => {
    const unmeasured = scenes.map((s) => ({ ...s, start_s: null, end_s: null }));
    expect(summarizeSceneRetention(unmeasured, null, LINEAR).status).toBe("no_timing");
    expect(summarizeSceneRetention(null, null, LINEAR).status).toBe("no_timing");
  });
});

function row(rank: number | null, drop: number | null, dropPerMin: number | null): SceneRetention {
  return { sceneId: "s", startS: 0, endS: 1, retentionStart: 1, retentionEnd: 1, drop, dropPerMin, rank };
}

describe("display helpers", () => {
  it("highlights only ranked scenes that actually lose viewers", () => {
    expect(isWorstScene(row(1, 0.1, 0.2))).toBe(true);
    expect(isWorstScene(row(HIGHLIGHT_WORST + 1, 0.1, 0.2))).toBe(false);
    expect(isWorstScene(row(1, -0.05, -0.1))).toBe(false); // a rising curve is not a "worst"
    expect(isWorstScene(row(null, null, null))).toBe(false);
    expect(isWorstScene(null)).toBe(false);
  });

  it("scales the bar to the steepest scene and draws nothing for unknown or gains", () => {
    const all = [row(1, 0.2, 0.4), row(2, 0.1, 0.2), row(null, null, null), row(3, -0.1, -0.2)];
    expect(dropBarPercent(all[0], all)).toBe(100);
    expect(dropBarPercent(all[1], all)).toBe(50);
    expect(dropBarPercent(all[2], all)).toBeNull();
    expect(dropBarPercent(all[3], all)).toBeNull();
  });

  it("formats unknown as a dash, never as 0", () => {
    expect(pctText(null)).toBe("—");
    expect(pctText(0.874)).toBe("87%");
    expect(pointsText(null)).toBe("—");
    expect(pointsText(0.07)).toBe("−7.0");
    expect(pointsText(-0.012)).toBe("+1.2");
    expect(pointsText(0)).toBe("0.0");
  });
});

describe("i18n", () => {
  it("has the same scene-retention keys in en, ru and uz", () => {
    const keys = (d: Record<string, unknown>) => Object.keys(d).filter((k) => k.startsWith("storyboardRetention")).sort();
    const want = keys(en.videoDetail);
    expect(want.length).toBeGreaterThan(0);
    expect(keys(ru.videoDetail)).toEqual(want);
    expect(keys(uz.videoDetail)).toEqual(want);
    for (const d of [en, ru, uz]) {
      expect(d.videoDetail.storyboardRetentionPoints).toContain("{v}");
      expect(d.videoDetail.storyboardRetentionPerMin).toContain("{v}");
      expect(d.videoDetail.storyboardRetentionWorst).toContain("{n}");
    }
  });
});
