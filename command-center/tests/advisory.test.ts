import { describe, expect, it } from "vitest";
import {
  deriveAdvisory,
  parseDurability,
  parsePublishTiming,
  parseRepackage,
  parseSpendForecast,
  parseVidiqResearch,
  parseSponsorship,
} from "@/lib/advisory";
import type { SystemEventRow } from "@/lib/types";

function ev(event: string, ts: string, metadata: Record<string, unknown> | null): SystemEventRow {
  return {
    event_key: `${event}:${ts}`,
    channel_id: null,
    event,
    ts,
    video_id: null,
    job_id: null,
    agent: null,
    status: "completed",
    duration_ms: null,
    metadata,
  };
}

describe("parseSpendForecast", () => {
  it("returns null with no event", () => {
    expect(parseSpendForecast(null)).toBeNull();
  });

  it("reads the projection and ceiling", () => {
    const s = parseSpendForecast(
      ev("budget.forecast", "2026-09-13T00:00:00", {
        channel_id: "chronos",
        spent_usd: 12.5,
        elapsed_days: 13,
        days_in_month: 30,
        projected_usd: 28.8,
        ceiling_usd: 25,
        projected_exceeds: true,
        has_unpriced: false,
      }),
    );
    expect(s?.spentUsd).toBe(12.5);
    expect(s?.projectedUsd).toBe(28.8);
    expect(s?.ceilingUsd).toBe(25);
    expect(s?.projectedExceeds).toBe(true);
    expect(s?.hasUnpriced).toBe(false);
  });

  it("keeps an uncomputable projection as null, never zero", () => {
    const s = parseSpendForecast(
      ev("budget.forecast", "2026-09-13T00:00:00", {
        spent_usd: 0,
        projected_usd: null,
        projected_exceeds: false,
        has_unpriced: true,
      }),
    );
    expect(s?.projectedUsd).toBeNull();
    expect(s?.spentUsd).toBe(0);
    expect(s?.hasUnpriced).toBe(true);
    // An unknown projection is never treated as exceeding.
    expect(s?.projectedExceeds).toBe(false);
  });

  it("only flags exceeds on an explicit true", () => {
    const s = parseSpendForecast(
      ev("budget.forecast", "t", { projected_exceeds: "yes" as unknown }),
    );
    expect(s?.projectedExceeds).toBe(false);
  });
});

describe("parsePublishTiming", () => {
  it("has no recommendation when hour or weekday is missing", () => {
    const s = parsePublishTiming(
      ev("publish.timing", "t", { best_hour_utc: null, best_weekday: null, samples: 2 }),
    );
    expect(s?.hasRecommendation).toBe(false);
    expect(s?.bestHourUtc).toBeNull();
  });

  it("reads a full recommendation", () => {
    const s = parsePublishTiming(
      ev("publish.timing", "t", {
        best_hour_utc: 17,
        best_weekday: 5,
        best_weekday_name: "Saturday",
        samples: 24,
        timezone: "UTC",
      }),
    );
    expect(s?.hasRecommendation).toBe(true);
    expect(s?.bestHourUtc).toBe(17);
    expect(s?.bestWeekdayName).toBe("Saturday");
    expect(s?.samples).toBe(24);
  });

  it("hour 0 is a real hour, not missing", () => {
    const s = parsePublishTiming(
      ev("publish.timing", "t", { best_hour_utc: 0, best_weekday: 0 }),
    );
    expect(s?.bestHourUtc).toBe(0);
    expect(s?.hasRecommendation).toBe(true);
  });
});

describe("parseRepackage", () => {
  it("reads count and the worst offender", () => {
    const s = parseRepackage(
      ev("repackage.suggested", "t", {
        count: 3,
        video_ids: ["a", "b", "c"],
        worst: {
          video_id: "a",
          title: "Old Rome",
          age_days: 40,
          views: 900,
          impressions: 20000,
          ctr: 0.02,
          channel_median_ctr: 0.05,
          reason: "ctr 0.02 well below channel median 0.05",
        },
      }),
    );
    expect(s?.count).toBe(3);
    expect(s?.worst?.videoId).toBe("a");
    expect(s?.worst?.ctr).toBe(0.02);
    expect(s?.worst?.channelMedianCtr).toBe(0.05);
  });

  it("count 0 with no worst is a real 'nothing flagged'", () => {
    const s = parseRepackage(ev("repackage.suggested", "t", { count: 0, worst: null }));
    expect(s?.count).toBe(0);
    expect(s?.worst).toBeNull();
  });
});

describe("parseDurability", () => {
  it("keeps 'unknown' distinct from 'not mirrored'", () => {
    const unknown = parseDurability(
      ev("durability.check", "t", { local_videos: 10, mirror_configured: false, mirrored: null }),
    );
    expect(unknown?.mirrored).toBeNull();
    const gap = parseDurability(
      ev("durability.check", "t", {
        local_videos: 10,
        remote_videos: 7,
        mirror_configured: true,
        mirrored: false,
        gap: 3,
      }),
    );
    expect(gap?.mirrored).toBe(false);
    expect(gap?.gap).toBe(3);
  });
});

describe("deriveAdvisory", () => {
  it("returns all-null for an empty stream", () => {
    const a = deriveAdvisory([]);
    expect(a.vidiq).toBeNull();
    expect(a.spend).toBeNull();
    expect(a.timing).toBeNull();
    expect(a.repackage).toBeNull();
    expect(a.durability).toBeNull();
    expect(a.sponsorship).toBeNull();
  });

  it("picks the genuinely latest of each kind regardless of list order", () => {
    const events: SystemEventRow[] = [
      ev("budget.forecast", "2026-09-10T00:00:00", { projected_usd: 10 }),
      ev("budget.forecast", "2026-09-13T00:00:00", { projected_usd: 30 }),
      ev("budget.forecast", "2026-09-11T00:00:00", { projected_usd: 20 }),
      ev("publish.timing", "2026-09-12T00:00:00", { best_hour_utc: 9, best_weekday: 1 }),
    ];
    const a = deriveAdvisory(events);
    expect(a.spend?.projectedUsd).toBe(30); // the 13th, not the first in the array
    expect(a.timing?.bestHourUtc).toBe(9);
    expect(a.repackage).toBeNull();
    expect(a.durability).toBeNull();
  });

  it("tolerates a missing/!object metadata blob", () => {
    const a = deriveAdvisory([ev("budget.forecast", "t", null)]);
    expect(a.spend).not.toBeNull();
    expect(a.spend?.projectedUsd).toBeNull();
  });
});

describe("parseVidiqResearch", () => {
  it("returns null with no event", () => {
    expect(parseVidiqResearch(null)).toBeNull();
  });

  it("reads the ranked head and best term, keeping unknown opportunity null", () => {
    const r = parseVidiqResearch(
      ev("vidiq.research", "t", {
        keywords_scored: 3,
        best: "roman empire",
        top: [
          { term: "roman empire", opportunity: 0.72 },
          { term: "roman roads", opportunity: 0.09 },
          { term: "bad", opportunity: null },
          { not_a_term: true },
        ],
      }),
    );
    expect(r?.keywordsScored).toBe(3);
    expect(r?.best).toBe("roman empire");
    // rows without a term are dropped; a null opportunity is kept as null
    expect(r?.top.map((k) => k.term)).toEqual(["roman empire", "roman roads", "bad"]);
    expect(r?.top[2].opportunity).toBeNull();
  });
});

describe("parseSponsorship", () => {
  it("returns null with no event", () => {
    expect(parseSponsorship(null)).toBeNull();
  });

  it("reads a priced slot in USD", () => {
    const s = parseSponsorship(
      ev("sponsorship.estimate", "t", {
        average_views: 2000,
        measured_videos: 4,
        cpm_usd: 25,
        price_usd: 50,
        currency: "USD",
        reason: "…",
      }),
    );
    expect(s?.priceUsd).toBe(50);
    expect(s?.averageViews).toBe(2000);
    expect(s?.cpmUsd).toBe(25);
    expect(s?.currency).toBe("USD");
    expect(s?.hasPrice).toBe(true);
  });

  it("keeps an unset rate as no price, never $0", () => {
    const s = parseSponsorship(
      ev("sponsorship.estimate", "t", {
        average_views: 2000,
        measured_videos: 4,
        cpm_usd: null,
        price_usd: null,
        currency: "USD",
      }),
    );
    expect(s?.priceUsd).toBeNull();
    expect(s?.hasPrice).toBe(false);
    expect(s?.averageViews).toBe(2000); // reach still reported
  });
});
