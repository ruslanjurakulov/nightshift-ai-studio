import { describe, expect, it } from "vitest";
import { priceEnvVar, providerOf, unitEconomics, type LedgerRow } from "@/lib/unitEconomics";

const NOW = Date.parse("2026-09-24T00:00:00Z");
const day = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

/** A fully priced video: script tokens + narration, `usd` split across both. */
function pricedVideo(slug: string, usd: number, ago = 1, channel = "ch1"): LedgerRow[] {
  return [
    { slug, video_id: "", channel_id: channel, unit: "gemini_input_tokens", quantity: 10_000, stage: "script", estimated_usd: usd * 0.25, recorded_at: day(ago) },
    { slug, video_id: "", channel_id: channel, unit: "tts_characters", quantity: 9_000, stage: "voice", estimated_usd: usd * 0.75, recorded_at: day(ago) },
  ];
}

describe("unitEconomics — medians over fully priced videos", () => {
  it("computes median and p90 cost per video with linear interpolation", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((usd, i) => pricedVideo(`v${i}`, usd, 1 + i * 0.1));
    const ue = unitEconomics(rows, { now: NOW });
    expect(ue.sampleSize).toBe(10);
    expect(ue.pricedVideos).toBe(10);
    expect(ue.partialVideos).toBe(0);
    expect(ue.medianPerVideo).toBeCloseTo(5.5);
    expect(ue.p90PerVideo).toBeCloseTo(9.1);
  });

  it("ranks cost drivers by USD with their share of the priced cost", () => {
    const ue = unitEconomics([...pricedVideo("a", 2), ...pricedVideo("b", 4)], { now: NOW });
    expect(ue.drivers.map((d) => d.unit)).toEqual(["tts_characters", "gemini_input_tokens"]);
    expect(ue.drivers[0].usd).toBeCloseTo(4.5);
    expect(ue.drivers[0].usdPerVideo).toBeCloseTo(2.25);
    expect(ue.drivers[0].share).toBeCloseTo(0.75);
  });

  it("splits generated media by the provider named in the stage", () => {
    const rows: LedgerRow[] = [
      ...pricedVideo("a", 1),
      { slug: "a", channel_id: "ch1", unit: "video_gen_clips", quantity: 4, stage: "broll:minimax", estimated_usd: 2, recorded_at: day(1) },
      { slug: "a", channel_id: "ch1", unit: "video_gen_clips", quantity: 1, stage: "broll:kling", estimated_usd: 0.5, recorded_at: day(1) },
    ];
    const ue = unitEconomics(rows, { now: NOW });
    expect(ue.drivers[0].key).toBe("video_gen_clips:minimax");
    expect(ue.drivers.find((d) => d.provider === "kling")?.usd).toBeCloseTo(0.5);
    expect(providerOf("image:leonardo")).toBe("leonardo");
    expect(providerOf("script")).toBeNull();
  });
});

describe("unitEconomics — partial pricing is excluded, never zero-filled", () => {
  const partial: LedgerRow[] = [
    { slug: "p", channel_id: "ch1", unit: "gemini_input_tokens", quantity: 10_000, stage: "script", estimated_usd: 0.01, recorded_at: day(1) },
    { slug: "p", channel_id: "ch1", unit: "render_seconds", quantity: 600, stage: "render", estimated_usd: null, recorded_at: day(1) },
  ];

  it("leaves a video with any unpriced entry out of the USD median and says so", () => {
    const ue = unitEconomics([...pricedVideo("a", 3), ...pricedVideo("b", 5), ...partial], { now: NOW });
    expect(ue.sampleSize).toBe(3);
    expect(ue.pricedVideos).toBe(2);
    expect(ue.partialVideos).toBe(1);
    // Median of 3 and 5 only — the partial video's $0.01 floor would drag it down.
    expect(ue.medianPerVideo).toBeCloseTo(4);
    const p = ue.videos.find((v) => v.slug === "p")!;
    expect(p.usd).toBeNull();
    expect(p.pricedUsd).toBeCloseTo(0.01);
    expect(p.unpricedUnits).toEqual(["render_seconds"]);
  });

  it("names the exact env var the bot reads for each unpriced unit", () => {
    const ue = unitEconomics(partial, { now: NOW });
    expect(ue.unpriced).toEqual([
      { unit: "render_seconds", envVar: "CHRONOS_PRICE_RENDER_SECONDS", videos: 1, quantity: 600 },
    ]);
    expect(priceEnvVar("tts_characters")).toBe("CHRONOS_PRICE_TTS_CHARACTERS");
  });

  it("reports unknown (null), not $0, when every video is partial", () => {
    const ue = unitEconomics(partial, { now: NOW });
    expect(ue.medianPerVideo).toBeNull();
    expect(ue.p90PerVideo).toBeNull();
    expect(ue.drivers).toEqual([]);
    expect(ue.breakdown.find((d) => d.unit === "render_seconds")?.usd).toBeNull();
  });
});

describe("unitEconomics — cost per finished minute", () => {
  it("uses only priced videos with a known length", () => {
    const rows = [...pricedVideo("a", 6), ...pricedVideo("b", 10), ...pricedVideo("c", 1)];
    const ue = unitEconomics(rows, {
      now: NOW,
      durations: [
        { slug: "a", channel_id: "ch1", duration_s: 360 }, // 6 min → $1/min
        { slug: "b", channel_id: "ch1", duration_s: 300 }, // 5 min → $2/min
        { slug: "c", channel_id: "ch1", duration_s: null }, // unknown length: left out
      ],
    });
    expect(ue.minuteSample).toBe(2);
    expect(ue.medianPerMinute).toBeCloseTo(1.5);
    expect(ue.videos.find((v) => v.slug === "c")?.usdPerMinute).toBeNull();
  });

  it("does not borrow another channel's video length for the same slug", () => {
    const ue = unitEconomics(pricedVideo("a", 6), {
      now: NOW,
      durations: [{ slug: "a", channel_id: "other", duration_s: 360 }],
    });
    expect(ue.medianPerMinute).toBeNull();
  });
});

describe("unitEconomics — sampling and grouping", () => {
  it("returns nulls and zero counts for no data", () => {
    const ue = unitEconomics([], { now: NOW });
    expect(ue.sampleSize).toBe(0);
    expect(ue.medianPerVideo).toBeNull();
    expect(ue.medianPerMinute).toBeNull();
    expect(ue.unpriced).toEqual([]);
  });

  it("keeps a held run and its later repair together under the slug", () => {
    const rows: LedgerRow[] = [
      { slug: "s", video_id: "", channel_id: "ch1", unit: "tts_characters", quantity: 100, stage: "voice", estimated_usd: 1, recorded_at: day(2) },
      { slug: "s", video_id: null, channel_id: "ch1", unit: "render_seconds", quantity: 50, stage: "repair_render", estimated_usd: 0.5, recorded_at: day(1) },
    ];
    const ue = unitEconomics(rows, { now: NOW });
    expect(ue.sampleSize).toBe(1);
    expect(ue.videos[0].usd).toBeCloseTo(1.5);
  });

  it("applies the day window and the most-recent-N cap", () => {
    const rows = [
      ...pricedVideo("old", 100, 45),
      ...[1, 2, 3, 4].flatMap((n) => pricedVideo(`n${n}`, n, n)),
    ];
    const ue = unitEconomics(rows, { now: NOW, windowDays: 30, maxVideos: 3 });
    expect(ue.videos.map((v) => v.slug)).toEqual(["n1", "n2", "n3"]);
    expect(ue.medianPerVideo).toBeCloseTo(2);
  });

  it("counts rows that cannot be tied to a video instead of inventing one", () => {
    const ue = unitEconomics(
      [{ unit: "tts_characters", quantity: 5, stage: "voice", estimated_usd: 0.1, recorded_at: day(1) }],
      { now: NOW },
    );
    expect(ue.sampleSize).toBe(0);
    expect(ue.unattributedRows).toBe(1);
  });
});
