import { describe, expect, it } from "vitest";
import {
  buildTrace,
  confidenceFromEvidence,
  deriveDecisions,
  deriveOutcome,
  scoreLineage,
  signalDirection,
  signalMetric,
} from "@/lib/decisions";
import {
  DEMAND_MIN_MENTIONS,
  PATTERN_MIN_SIGNALS,
  deriveMemories,
  deriveOpportunities,
  deriveTopicIntel,
  topicState,
} from "@/lib/memory";
import { categorize, deriveCoreState } from "@/lib/intelligence";
import type {
  DemandSignalRow,
  FeedbackSignalRow,
  SystemEventRow,
  TopicPerformanceRow,
  VideoRow,
} from "@/lib/types";

// -- row factories ---------------------------------------------------------

let seq = 0;
function ev(over: Partial<SystemEventRow> & { event: string; ts: string }): SystemEventRow {
  seq += 1;
  return {
    event_key: over.event_key ?? `k${seq}`,
    event: over.event,
    ts: over.ts,
    video_id: over.video_id ?? null,
    job_id: over.job_id ?? null,
    agent: over.agent ?? null,
    status: over.status ?? null,
    duration_ms: over.duration_ms ?? null,
    metadata: over.metadata ?? null,
    channel_id: over.channel_id ?? null,
  };
}

function perf(over: Partial<TopicPerformanceRow> & { topic: string; score: number }): TopicPerformanceRow {
  return {
    topic: over.topic,
    score: over.score,
    videos_analyzed: over.videos_analyzed ?? 4,
    avg_views_per_day: over.avg_views_per_day ?? null,
    reason: over.reason ?? null,
    updated_at: over.updated_at ?? "2026-09-01",
  };
}

function sig(over: Partial<FeedbackSignalRow> & { signal: string }): FeedbackSignalRow {
  return {
    video_id: over.video_id ?? "v1",
    channel_id: over.channel_id ?? "default",
    topic: over.topic ?? "Ancient Mysteries",
    signal: over.signal,
    metric_value: over.metric_value ?? 10,
    channel_baseline: over.channel_baseline ?? 5,
    detail: over.detail ?? "2.00x channel average",
    analyzed_date: over.analyzed_date ?? "2026-09-01",
  };
}

// -- confidence ------------------------------------------------------------

describe("confidenceFromEvidence", () => {
  it("returns null below the engine's own 2-video floor", () => {
    expect(confidenceFromEvidence(0)).toBeNull();
    expect(confidenceFromEvidence(1)).toBeNull();
    expect(confidenceFromEvidence(null)).toBeNull();
    expect(confidenceFromEvidence(undefined)).toBeNull();
  });

  it("scales with real evidence count", () => {
    expect(confidenceFromEvidence(2)).toBe("LOW");
    expect(confidenceFromEvidence(3)).toBe("LOW");
    expect(confidenceFromEvidence(4)).toBe("MEDIUM");
    expect(confidenceFromEvidence(7)).toBe("MEDIUM");
    expect(confidenceFromEvidence(8)).toBe("HIGH");
    expect(confidenceFromEvidence(50)).toBe("HIGH");
  });
});

describe("signal parsing", () => {
  it("reads direction from the engine's HIGH_/LOW_ vocabulary", () => {
    expect(signalDirection("HIGH_RETENTION")).toBe("up");
    expect(signalDirection("LOW_ENGAGEMENT")).toBe("down");
    expect(signalDirection("SOMETHING_ELSE")).toBeNull();
  });

  it("extracts the metric name", () => {
    expect(signalMetric("HIGH_VIEW_VELOCITY")).toBe("VIEW_VELOCITY");
    expect(signalMetric("LOW_RETENTION")).toBe("RETENTION");
  });
});

// -- decision outcome ------------------------------------------------------

describe("deriveOutcome", () => {
  const now = Date.parse("2026-09-02T00:00:00Z");

  it("reports PUBLISHED when a publish event followed the decision", () => {
    const events = [ev({ event: "video.published", ts: "2026-09-01T11:00:00Z", video_id: "v1" })];
    expect(deriveOutcome("2026-09-01T10:00:00Z", null, events, now)).toBe("PUBLISHED");
  });

  it("reports FAILED when only a failure followed", () => {
    const events = [ev({ event: "upload.failed", ts: "2026-09-01T11:00:00Z", status: "failed" })];
    expect(deriveOutcome("2026-09-01T10:00:00Z", null, events, now)).toBe("FAILED");
  });

  it("only counts events inside the decision's own window", () => {
    // The publish happened after the NEXT decision, so it is not this one's.
    const events = [ev({ event: "video.published", ts: "2026-09-01T13:00:00Z" })];
    expect(deriveOutcome("2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", events, now)).toBe("UNKNOWN");
  });

  it("reports IN_PROGRESS only for a recent newest decision", () => {
    const recent = "2026-09-01T23:00:00Z";
    expect(deriveOutcome(recent, null, [], now)).toBe("IN_PROGRESS");
    // Same decision, but long past the in-progress window.
    expect(deriveOutcome("2026-08-01T00:00:00Z", null, [], now)).toBe("UNKNOWN");
  });
});

// -- decisions -------------------------------------------------------------

describe("deriveDecisions", () => {
  const now = Date.parse("2026-09-02T00:00:00Z");

  it("returns nothing when no topic.selected event exists", () => {
    const events = [ev({ event: "system.heartbeat", ts: "2026-09-01T10:00:00Z" })];
    expect(deriveDecisions(events, [], [], now)).toEqual([]);
  });

  it("joins a decision to its real score, reason and signals", () => {
    const events = [
      ev({
        event: "topic.selected",
        ts: "2026-09-01T10:00:00Z",
        agent: "topic_manager",
        metadata: { topic: "Ancient Mysteries" },
      }),
    ];
    const [d] = deriveDecisions(
      events,
      [perf({ topic: "Ancient Mysteries", score: 87, videos_analyzed: 9, reason: "9 video(s); retention 1.4x channel avg" })],
      [sig({ signal: "HIGH_RETENTION" })],
      now,
    );
    expect(d.topic).toBe("Ancient Mysteries");
    expect(d.score).toBe(87);
    expect(d.confidence).toBe("HIGH");
    expect(d.signals).toHaveLength(1);
    expect(d.signals[0].direction).toBe("up");
    expect(d.explainable).toBe(true);
    expect(d.id).toBe(events[0].event_key);
  });

  it("is honest when the topic was never scored", () => {
    const events = [
      ev({ event: "topic.selected", ts: "2026-09-01T10:00:00Z", metadata: { topic: "Brand New" } }),
    ];
    const [d] = deriveDecisions(events, [], [], now);
    expect(d.score).toBeNull();
    expect(d.reason).toBeNull();
    expect(d.confidence).toBeNull();
    expect(d.explainable).toBe(false);
  });

  it("handles a decision event with no topic metadata", () => {
    const events = [ev({ event: "topic.selected", ts: "2026-09-01T10:00:00Z" })];
    const [d] = deriveDecisions(events, [], [], now);
    expect(d.topic).toBeNull();
    expect(d.explainable).toBe(false);
  });
});

// -- trace -----------------------------------------------------------------

describe("buildTrace", () => {
  it("marks a step done only when a real row backs it", () => {
    const steps = buildTrace("v1", "Ancient Mysteries", [], 0, [], null);
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(steps.map((s) => s.key)).toEqual([
      "decision",
      "generation",
      "published",
      "metrics",
      "signals",
      "score",
    ]);
  });

  it("completes the chain from real events, snapshots, signals and score", () => {
    const events = [
      ev({ event: "topic.selected", ts: "2026-09-01T10:00:00Z", metadata: { topic: "Ancient Mysteries" } }),
      ev({ event: "script.completed", ts: "2026-09-01T10:30:00Z", video_id: "v1" }),
      ev({ event: "video.published", ts: "2026-09-01T11:00:00Z", video_id: "v1" }),
    ];
    const steps = buildTrace(
      "v1",
      "Ancient Mysteries",
      events,
      3,
      [sig({ signal: "HIGH_RETENTION", analyzed_date: "2026-09-02" })],
      perf({ topic: "Ancient Mysteries", score: 72 }),
    );
    expect(steps.every((s) => s.done)).toBe(true);
    expect(steps.find((s) => s.key === "metrics")?.detail).toBe("3");
    expect(steps.find((s) => s.key === "score")?.detail).toBe("72");
  });
});

// -- lineage ---------------------------------------------------------------

describe("scoreLineage", () => {
  it("is empty for an unscored topic", () => {
    expect(scoreLineage(null, 0)).toEqual([]);
  });

  it("names the real source of every number", () => {
    const rows = scoreLineage(perf({ topic: "T", score: 61.5, reason: "4 video(s); engagement 1.2x channel avg" }), 5);
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("score");
    expect(labels).toContain("formula");
    expect(labels).toContain("ratios");
    expect(rows.every((r) => r.source.length > 0)).toBe(true);
  });
});

// -- memory ----------------------------------------------------------------

describe("deriveMemories", () => {
  it("creates no memory without enough evidence", () => {
    expect(deriveMemories([perf({ topic: "T", score: 95, videos_analyzed: 1 })], [])).toEqual([]);
  });

  it("remembers a topic that really outperforms, with its evidence", () => {
    const [m] = deriveMemories([perf({ topic: "T", score: 80, videos_analyzed: 9 })], []);
    expect(m.kind).toBe("topic_outperforms");
    expect(m.evidenceCount).toBe(9);
    expect(m.confidence).toBe("HIGH");
    expect(m.sources).toContain("topic_performance");
  });

  it("remembers a topic that really underperforms", () => {
    const [m] = deriveMemories([perf({ topic: "T", score: 30, videos_analyzed: 4 })], []);
    expect(m.kind).toBe("topic_underperforms");
    expect(m.confidence).toBe("MEDIUM");
  });

  it("ignores a topic sitting inside the average band", () => {
    expect(deriveMemories([perf({ topic: "T", score: 50, videos_analyzed: 9 })], [])).toEqual([]);
  });

  it("needs a repeated, consistent pattern before remembering one", () => {
    const twice = [sig({ signal: "HIGH_RETENTION" }), sig({ signal: "HIGH_RETENTION" })];
    expect(deriveMemories([], twice)).toEqual([]);

    const enough = Array.from({ length: PATTERN_MIN_SIGNALS }, (_, i) =>
      sig({ signal: "HIGH_RETENTION", analyzed_date: `2026-09-0${i + 1}` }),
    );
    const [m] = deriveMemories([], enough);
    expect(m.kind).toBe("metric_consistent_up");
    expect(m.metric).toBe("RETENTION");
    expect(m.evidenceCount).toBe(PATTERN_MIN_SIGNALS);
  });

  it("refuses a pattern that flip-flops", () => {
    const mixed = [
      sig({ signal: "HIGH_RETENTION" }),
      sig({ signal: "HIGH_RETENTION" }),
      sig({ signal: "HIGH_RETENTION" }),
      sig({ signal: "LOW_RETENTION" }),
    ];
    expect(deriveMemories([], mixed).filter((m) => m.metric === "RETENTION")).toEqual([]);
  });
});

// -- topic intelligence ----------------------------------------------------

describe("topicState", () => {
  it("is INSUFFICIENT_DATA without a scored topic", () => {
    expect(topicState(null, [])).toBe("INSUFFICIENT_DATA");
  });

  it("is NEW when barely any video backs the score", () => {
    expect(topicState(perf({ topic: "T", score: 70, videos_analyzed: 1 }), [])).toBe("NEW");
  });

  it("is STABLE with only one dated analysis — no trend to report", () => {
    const p = perf({ topic: "T", score: 70, videos_analyzed: 5 });
    expect(topicState(p, [sig({ signal: "HIGH_RETENTION", analyzed_date: "2026-09-01" })])).toBe("STABLE");
  });

  it("detects a real rise and fall across dated analyses", () => {
    const p = perf({ topic: "T", score: 70, videos_analyzed: 5 });
    const rising = [
      sig({ signal: "LOW_RETENTION", analyzed_date: "2026-09-01" }),
      sig({ signal: "HIGH_RETENTION", analyzed_date: "2026-09-02" }),
    ];
    expect(topicState(p, rising)).toBe("RISING");

    const declining = [
      sig({ signal: "HIGH_RETENTION", analyzed_date: "2026-09-01" }),
      sig({ signal: "LOW_RETENTION", analyzed_date: "2026-09-02" }),
    ];
    expect(topicState(p, declining)).toBe("DECLINING");
  });
});

describe("deriveTopicIntel", () => {
  it("reports last-used from real published videos", () => {
    const videos: VideoRow[] = [
      {
        video_id: "v1",
        channel_id: "default",
        topic: "T",
        title: null,
        slug: null,
        published_at: "2026-08-30T00:00:00Z",
        privacy: null,
        category_id: null,
        local_path: null,
        thumbnail_variant: null,
        title_variant: null,
        hook_variant: null,
        video_format: "long",
        parent_video_id: null,
        preview_path: null,
        script_text: null,
        review_state: "pending",
      },
    ];
    const [t] = deriveTopicIntel([perf({ topic: "T", score: 70, videos_analyzed: 5 })], [], videos);
    expect(t.lastUsed).toBe("2026-08-30T00:00:00Z");
    expect(t.confidence).toBe("MEDIUM");
  });
});

// -- opportunities ---------------------------------------------------------

describe("deriveOpportunities", () => {
  function demand(over: Partial<DemandSignalRow> & { id: number; mention_count: number }): DemandSignalRow {
    return {
      id: over.id,
      channel_id: over.channel_id ?? "default",
      topic_phrase: over.topic_phrase ?? "genghis khan",
      mention_count: over.mention_count,
      example_comment_ids: null,
      polled_date: over.polled_date ?? "2026-09-01",
    };
  }

  it("is empty without evidence", () => {
    expect(deriveOpportunities([], [])).toEqual([]);
    expect(deriveOpportunities([perf({ topic: "T", score: 90, videos_analyzed: 1 })], [])).toEqual([]);
  });

  it("surfaces over- and under-performing topics with their evidence", () => {
    const opps = deriveOpportunities(
      [
        perf({ topic: "Up", score: 80, videos_analyzed: 8 }),
        perf({ topic: "Down", score: 20, videos_analyzed: 4 }),
        perf({ topic: "Average", score: 50, videos_analyzed: 8 }),
      ],
      [],
    );
    expect(opps.map((o) => o.kind).sort()).toEqual(["topic_declining", "topic_outperforming"]);
  });

  it("requires repeated mentions before audience demand is an opportunity", () => {
    expect(deriveOpportunities([], [demand({ id: 1, mention_count: DEMAND_MIN_MENTIONS - 1 })])).toEqual([]);
    const [o] = deriveOpportunities([], [demand({ id: 2, mention_count: DEMAND_MIN_MENTIONS })]);
    expect(o.kind).toBe("audience_demand");
    expect(o.evidenceCount).toBe(DEMAND_MIN_MENTIONS);
  });
});

// -- existing helpers still honest ----------------------------------------

describe("event categorization and core state", () => {
  it("classifies real event names", () => {
    expect(categorize(ev({ event: "system.heartbeat", ts: "2026-09-01T00:00:00Z" }))).toBe("system");
    expect(categorize(ev({ event: "topic.selected", ts: "2026-09-01T00:00:00Z" }))).toBe("ai");
    expect(categorize(ev({ event: "video.published", ts: "2026-09-01T00:00:00Z" }))).toBe("video");
    expect(categorize(ev({ event: "feedback.generated", ts: "2026-09-01T00:00:00Z" }))).toBe("analytics");
    expect(categorize(ev({ event: "upload.failed", ts: "2026-09-01T00:00:00Z", status: "failed" }))).toBe("error");
  });

  it("is disconnected when realtime is down and idle when nothing is fresh", () => {
    expect(deriveCoreState([], false)).toBe("disconnected");
    expect(deriveCoreState([], true)).toBe("idle");
    const stale = [ev({ event: "system.heartbeat", ts: "2020-01-01T00:00:00Z" })];
    expect(deriveCoreState(stale, true)).toBe("idle");
  });
});
