import { describe, expect, it } from "vitest";
import {
  deriveAdvisory,
  parseDurability,
  parsePublishTiming,
  parseRepackage,
  parseSpendForecast,
  parseVidiqResearch,
  parseSponsorship,
  parseRevenueTracked,
  parseNicheRpm,
  parseQuotaAllocation,
  parseSpendOverview,
  parseDirectorPlan,
  parseAgentPlan,
  parseElementsApplied,
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
    expect(a.nicheRpm).toBeNull();
    expect(a.quota).toBeNull();
    expect(a.spendOverview).toBeNull();
    expect(a.director).toBeNull();
    expect(a.agent).toBeNull();
    expect(a.elements).toBeNull();
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
    expect(a.revenue).toBeNull();
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

describe("parseRevenueTracked", () => {
  it("returns null with no event", () => {
    expect(parseRevenueTracked(null)).toBeNull();
  });

  it("reads USD totals and top earners, keeping hasRevenue honest", () => {
    const r = parseRevenueTracked(
      ev("revenue.tracked", "t", {
        total_usd: 15,
        channel_rpm_usd: 3.75,
        measured_count: 2,
        video_count: 3,
        currency: "USD",
        top_earners: [
          { video_id: "a", revenue_usd: 12, views: 1000, rpm_usd: 12 },
          { video_id: "b", revenue_usd: 3, views: 3000, rpm_usd: 1 },
          { not_a_row: true },
        ],
      }),
    );
    expect(r?.totalUsd).toBe(15);
    expect(r?.channelRpmUsd).toBe(3.75);
    expect(r?.measuredCount).toBe(2);
    expect(r?.videoCount).toBe(3);
    expect(r?.currency).toBe("USD");
    expect(r?.hasRevenue).toBe(true);
    expect(r?.top.map((v) => v.videoId)).toEqual(["a", "b"]);
  });

  it("treats a null total as 'not measured', never $0", () => {
    const r = parseRevenueTracked(
      ev("revenue.tracked", "t", { total_usd: null, measured_count: 0, video_count: 5, currency: "USD" }),
    );
    expect(r?.totalUsd).toBeNull();
    expect(r?.hasRevenue).toBe(false);
    expect(r?.top).toEqual([]);
  });
});

describe("parseNicheRpm", () => {
  it("returns null with no event", () => {
    expect(parseNicheRpm(null)).toBeNull();
  });

  it("reads the ranked niches with their tiers and best niche", () => {
    const r = parseNicheRpm(
      ev("niche.rpm", "t", {
        best_niche: "finance",
        measured_count: 2,
        niche_count: 2,
        niches: [
          { niche: "finance", tier: 2, video_count: 3, avg_views: 5000, rpm_usd: 4.2, score: 0.9 },
          { niche: "history", tier: 1, video_count: 3, avg_views: 1000, rpm_usd: null, score: 0.4 },
          { not_a_niche: true },
        ],
      }),
    );
    expect(r?.bestNiche).toBe("finance");
    expect(r?.nicheCount).toBe(2);
    expect(r?.niches.map((n) => n.niche)).toEqual(["finance", "history"]); // junk row dropped
    expect(r?.niches[0].tier).toBe(2);
    expect(r?.niches[0].rpmUsd).toBe(4.2);
    expect(r?.niches[1].rpmUsd).toBeNull(); // engagement-only niche, no fabricated 0
  });

  it("keeps 'no recommendation' honest", () => {
    const r = parseNicheRpm(ev("niche.rpm", "t", { best_niche: null, niche_count: 1, niches: [] }));
    expect(r?.bestNiche).toBeNull();
    expect(r?.niches).toEqual([]);
  });
});

describe("parseQuotaAllocation", () => {
  it("returns null with no event", () => {
    expect(parseQuotaAllocation(null)).toBeNull();
  });

  it("reads slots and shares, keeping an unmeasured share null", () => {
    const q = parseQuotaAllocation(
      ev("quota.allocated", "t", {
        total_slots: 10,
        channel_count: 3,
        channels: [
          { channel_id: "a", name: "Alpha", slots: 6, score: 100, share: 0.8 },
          { channel_id: "b", name: "Beta", slots: 3, score: 25, share: 0.2 },
          { channel_id: "c", name: "Gamma", slots: 1, score: 0, share: null },
          { not_a_channel: true },
        ],
      }),
    );
    expect(q?.totalSlots).toBe(10);
    expect(q?.channelCount).toBe(3);
    expect(q?.channels.map((c) => c.channelId)).toEqual(["a", "b", "c"]); // junk row dropped
    expect(q?.channels[0].name).toBe("Alpha");
    expect(q?.channels[2].share).toBeNull(); // unknown, never a fabricated 0
  });

  it("falls back to the id when a channel has no name", () => {
    const q = parseQuotaAllocation(
      ev("quota.allocated", "t", { total_slots: 1, channels: [{ channel_id: "solo", slots: 1 }] }),
    );
    expect(q?.channels[0].name).toBe("solo");
  });
});

describe("parseSpendOverview", () => {
  it("returns null with no event", () => {
    expect(parseSpendOverview(null)).toBeNull();
  });

  it("reads totals and per-channel spend, keeping unknowns null", () => {
    const s = parseSpendOverview(
      ev("spend.overview", "t", {
        total_spent_usd: 5,
        total_projected_usd: 12,
        channel_count: 2,
        any_unpriced: true,
        channels: [
          { channel_id: "a", name: "Alpha", spent_usd: 3, videos_remaining: 8, avg_cost_usd: 1 },
          { channel_id: "b", name: "Beta", spent_usd: null, videos_remaining: null },
          { no_id: true },
        ],
      }),
    );
    expect(s?.totalSpentUsd).toBe(5);
    expect(s?.totalProjectedUsd).toBe(12);
    expect(s?.anyUnpriced).toBe(true);
    expect(s?.channels.map((c) => c.channelId)).toEqual(["a", "b"]); // junk row dropped
    expect(s?.channels[0].videosRemaining).toBe(8);
    expect(s?.channels[1].spentUsd).toBeNull(); // unknown, never 0
  });

  it("treats an all-unpriced total as null, never $0", () => {
    const s = parseSpendOverview(
      ev("spend.overview", "t", { total_spent_usd: null, channel_count: 1, channels: [{ channel_id: "a" }] }),
    );
    expect(s?.totalSpentUsd).toBeNull();
    expect(s?.channels[0].name).toBe("a");
  });
});

describe("parseDirectorPlan", () => {
  it("returns null for no event", () => {
    expect(parseDirectorPlan(null)).toBeNull();
  });

  it("parses scene count and shot rows", () => {
    const p = parseDirectorPlan(
      ev("director.plan", "t", {
        scenes: 3,
        shots: [
          { scene: 1, name: "hook", shot: "reveal opening", camera: "slow push-in", mood: "tense" },
          { scene: 2, name: "body", shot: "establishing", camera: "gentle dolly", mood: "cinematic" },
          "junk",
        ],
      }),
    );
    expect(p?.scenes).toBe(3);
    expect(p?.shots).toHaveLength(2); // junk row dropped
    expect(p?.shots[0].shot).toBe("reveal opening");
    expect(p?.shots[0].camera).toBe("slow push-in");
  });

  it("keeps unknown scene count null, never 0", () => {
    const p = parseDirectorPlan(ev("director.plan", "t", { shots: [] }));
    expect(p?.scenes).toBeNull();
    expect(p?.shots).toEqual([]);
  });
});

describe("parseElementsApplied", () => {
  it("returns null for no event", () => {
    expect(parseElementsApplied(null)).toBeNull();
  });

  it("reads defined count, applied names, and scenes touched", () => {
    const e = parseElementsApplied(
      ev("elements.applied", "t", {
        defined: 3,
        by_kind: { character: 2, location: 1 },
        applied: ["Chronos", "Ancient Library", 5],
        scenes_touched: 2,
      }),
    );
    expect(e?.defined).toBe(3);
    expect(e?.scenesTouched).toBe(2);
    // non-string entries dropped
    expect(e?.applied).toEqual(["Chronos", "Ancient Library"]);
  });

  it("keeps defined 0 as a real 'none defined'", () => {
    const e = parseElementsApplied(ev("elements.applied", "t", { defined: 0, applied: [] }));
    expect(e?.defined).toBe(0);
    expect(e?.applied).toEqual([]);
  });
});

describe("parseAgentPlan", () => {
  it("returns null for no event", () => {
    expect(parseAgentPlan(null)).toBeNull();
  });

  it("reads the topic, rationale, providers and keywords", () => {
    const p = parseAgentPlan(
      ev("agent.plan", "t", {
        topic: "The lost city of Petra",
        rationale: "high velocity across 3 trackers",
        source: "both",
        score: 0.82,
        keywords: ["petra", "city", 7],
        video_provider: "higgsfield",
        voice_provider: "elevenlabs",
      }),
    );
    expect(p?.topic).toBe("The lost city of Petra");
    expect(p?.source).toBe("both");
    expect(p?.score).toBe(0.82);
    expect(p?.videoProvider).toBe("higgsfield");
    expect(p?.keywords).toEqual(["petra", "city"]); // non-string dropped
  });

  it("keeps an unknown score null, never 0", () => {
    const p = parseAgentPlan(ev("agent.plan", "t", { topic: "X" }));
    expect(p?.score).toBeNull();
    expect(p?.keywords).toEqual([]);
  });
});
