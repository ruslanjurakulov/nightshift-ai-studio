/**
 * Nightshift Memory, topic intelligence and opportunities — Phase 3.
 *
 * All of it is derived from real rows (topic_performance, feedback_signals,
 * demand_signals, videos). Nothing is stored separately and nothing is
 * invented: a memory only exists when real evidence supports it, and its
 * confidence is a transparent function of how much evidence there is.
 *
 * Statements are returned as a structured `kind` plus real values rather than
 * English prose, so the UI renders them in the active language.
 */
import type {
  DemandSignalRow,
  FeedbackSignalRow,
  TopicPerformanceRow,
  VideoRow,
} from "@/lib/types";
import {
  confidenceFromEvidence,
  signalDirection,
  signalMetric,
  type Confidence,
} from "@/lib/decisions";

/**
 * The FeedbackEngine treats ±20% around the channel average as "about
 * average" (`_BAND`), and a score of 50 is exactly average. 60 / 40 are the
 * score equivalents of that same band, so we reuse it rather than inventing a
 * new threshold.
 */
export const SCORE_ABOVE = 60;
export const SCORE_BELOW = 40;
/** A metric needs at least this many same-direction signals to count as a pattern. */
export const PATTERN_MIN_SIGNALS = 3;

export type MemoryKind =
  | "topic_outperforms"
  | "topic_underperforms"
  | "metric_consistent_up"
  | "metric_consistent_down";

export interface Memory {
  id: string;
  kind: MemoryKind;
  topic: string;
  /** The metric a pattern memory is about (VIEW_VELOCITY / ENGAGEMENT / RETENTION). */
  metric: string | null;
  /** Real count of the rows backing this memory. */
  evidenceCount: number;
  confidence: Confidence;
  createdAt: string | null;
  updatedAt: string | null;
  /** Real supporting numbers, already formatted by the caller's locale-free rules. */
  score: number | null;
  sources: string[];
}

/**
 * Build memories from real aggregates. A topic with too little evidence
 * produces no memory at all rather than a low-confidence guess.
 */
export function deriveMemories(
  topicPerformance: TopicPerformanceRow[],
  signals: FeedbackSignalRow[],
): Memory[] {
  const memories: Memory[] = [];

  const signalsByTopic = new Map<string, FeedbackSignalRow[]>();
  for (const s of signals) {
    if (!s.topic) continue;
    const arr = signalsByTopic.get(s.topic);
    if (arr) arr.push(s);
    else signalsByTopic.set(s.topic, [s]);
  }

  for (const perf of topicPerformance) {
    const confidence = confidenceFromEvidence(perf.videos_analyzed);
    if (!confidence) continue; // not enough evidence for any claim

    if (perf.score >= SCORE_ABOVE) {
      memories.push({
        id: `perf:up:${perf.topic}`,
        kind: "topic_outperforms",
        topic: perf.topic,
        metric: null,
        evidenceCount: perf.videos_analyzed,
        confidence,
        createdAt: null,
        updatedAt: perf.updated_at,
        score: perf.score,
        sources: ["topic_performance", "metrics_snapshots"],
      });
    } else if (perf.score <= SCORE_BELOW) {
      memories.push({
        id: `perf:down:${perf.topic}`,
        kind: "topic_underperforms",
        topic: perf.topic,
        metric: null,
        evidenceCount: perf.videos_analyzed,
        confidence,
        createdAt: null,
        updatedAt: perf.updated_at,
        score: perf.score,
        sources: ["topic_performance", "metrics_snapshots"],
      });
    }
  }

  // Pattern memories: a metric that repeatedly moved the same way for a topic.
  for (const [topic, rows] of signalsByTopic) {
    const byMetric = new Map<string, { up: number; down: number; dates: string[] }>();
    for (const r of rows) {
      const dir = signalDirection(r.signal ?? "");
      if (!dir) continue;
      const metric = signalMetric(r.signal);
      const entry = byMetric.get(metric) ?? { up: 0, down: 0, dates: [] };
      if (dir === "up") entry.up += 1;
      else entry.down += 1;
      entry.dates.push(r.analyzed_date);
      byMetric.set(metric, entry);
    }

    for (const [metric, entry] of byMetric) {
      const dominant = entry.up >= entry.down ? "up" : "down";
      const count = dominant === "up" ? entry.up : entry.down;
      const opposite = dominant === "up" ? entry.down : entry.up;
      // Require a clear, repeated pattern — not a single reading, and not a
      // metric that flip-flops.
      if (count < PATTERN_MIN_SIGNALS || opposite > 0) continue;
      const confidence = confidenceFromEvidence(count);
      if (!confidence) continue;
      const dates = entry.dates.slice().sort();
      memories.push({
        id: `pat:${dominant}:${topic}:${metric}`,
        kind: dominant === "up" ? "metric_consistent_up" : "metric_consistent_down",
        topic,
        metric,
        evidenceCount: count,
        confidence,
        createdAt: dates[0] ?? null,
        updatedAt: dates[dates.length - 1] ?? null,
        score: null,
        sources: ["feedback_signals"],
      });
    }
  }

  // Strongest evidence first.
  return memories.sort((a, b) => b.evidenceCount - a.evidenceCount);
}

export type TopicState = "RISING" | "STABLE" | "DECLINING" | "NEW" | "INSUFFICIENT_DATA";

export interface TopicIntel {
  topic: string;
  score: number | null;
  videosAnalyzed: number | null;
  state: TopicState;
  confidence: Confidence | null;
  signalCount: number;
  lastUsed: string | null;
  updatedAt: string | null;
  reason: string | null;
}

/**
 * A topic's trend. `topic_performance` is upserted in place, so it carries no
 * score history — the trend therefore comes from the dated `feedback_signals`,
 * comparing the newest analysis date's net direction with the one before it.
 * With fewer than two dated analyses there is no trend to report.
 */
export function topicState(
  perf: TopicPerformanceRow | null,
  signals: FeedbackSignalRow[],
): TopicState {
  if (!perf) return "INSUFFICIENT_DATA";
  if (perf.videos_analyzed < CONFIDENCE_FLOOR) return "NEW";

  const netByDate = new Map<string, number>();
  for (const s of signals) {
    const dir = signalDirection(s.signal ?? "");
    if (!dir) continue;
    netByDate.set(s.analyzed_date, (netByDate.get(s.analyzed_date) ?? 0) + (dir === "up" ? 1 : -1));
  }
  const dates = Array.from(netByDate.keys()).sort();
  if (dates.length < 2) return "STABLE";

  const latest = netByDate.get(dates[dates.length - 1]) ?? 0;
  const previous = netByDate.get(dates[dates.length - 2]) ?? 0;
  if (latest > previous) return "RISING";
  if (latest < previous) return "DECLINING";
  return "STABLE";
}

/** Mirrors the FeedbackEngine's own `_MIN_VIDEOS`. */
const CONFIDENCE_FLOOR = 2;

export function deriveTopicIntel(
  topicPerformance: TopicPerformanceRow[],
  signals: FeedbackSignalRow[],
  videos: VideoRow[],
): TopicIntel[] {
  const signalsByTopic = new Map<string, FeedbackSignalRow[]>();
  for (const s of signals) {
    if (!s.topic) continue;
    const arr = signalsByTopic.get(s.topic);
    if (arr) arr.push(s);
    else signalsByTopic.set(s.topic, [s]);
  }

  const lastUsedByTopic = new Map<string, string>();
  for (const v of videos) {
    if (!v.topic || !v.published_at) continue;
    const prev = lastUsedByTopic.get(v.topic);
    if (!prev || v.published_at > prev) lastUsedByTopic.set(v.topic, v.published_at);
  }

  return topicPerformance.map((perf) => {
    const sigs = signalsByTopic.get(perf.topic) ?? [];
    return {
      topic: perf.topic,
      score: perf.score,
      videosAnalyzed: perf.videos_analyzed,
      state: topicState(perf, sigs),
      confidence: confidenceFromEvidence(perf.videos_analyzed),
      signalCount: sigs.length,
      lastUsed: lastUsedByTopic.get(perf.topic) ?? null,
      updatedAt: perf.updated_at,
      reason: perf.reason,
    };
  });
}

export type OpportunityKind =
  | "topic_outperforming"
  | "topic_declining"
  | "audience_demand";

export interface Opportunity {
  id: string;
  kind: OpportunityKind;
  /** Topic name, or the mined phrase for an audience-demand opportunity. */
  subject: string;
  evidenceCount: number;
  confidence: Confidence | null;
  ts: string | null;
  score: number | null;
  sources: string[];
}

/** Audience demand needs to be mentioned repeatedly before it is an opportunity. */
export const DEMAND_MIN_MENTIONS = 3;

/**
 * What Nightshift can currently see worth acting on. Every opportunity carries
 * the real evidence behind it; anything without evidence simply isn't listed.
 */
export function deriveOpportunities(
  topicPerformance: TopicPerformanceRow[],
  demand: DemandSignalRow[],
): Opportunity[] {
  const out: Opportunity[] = [];

  for (const perf of topicPerformance) {
    const confidence = confidenceFromEvidence(perf.videos_analyzed);
    if (!confidence) continue;
    if (perf.score >= SCORE_ABOVE) {
      out.push({
        id: `opp:up:${perf.topic}`,
        kind: "topic_outperforming",
        subject: perf.topic,
        evidenceCount: perf.videos_analyzed,
        confidence,
        ts: perf.updated_at,
        score: perf.score,
        sources: ["topic_performance"],
      });
    } else if (perf.score <= SCORE_BELOW) {
      out.push({
        id: `opp:down:${perf.topic}`,
        kind: "topic_declining",
        subject: perf.topic,
        evidenceCount: perf.videos_analyzed,
        confidence,
        ts: perf.updated_at,
        score: perf.score,
        sources: ["topic_performance"],
      });
    }
  }

  for (const d of demand) {
    if ((d.mention_count ?? 0) < DEMAND_MIN_MENTIONS) continue;
    out.push({
      id: `opp:demand:${d.id}`,
      kind: "audience_demand",
      subject: d.topic_phrase,
      evidenceCount: d.mention_count,
      // Demand evidence is mentions, not videos — same transparent thresholds.
      confidence: confidenceFromEvidence(d.mention_count),
      ts: d.polled_date,
      score: null,
      sources: ["demand_signals"],
    });
  }

  return out.sort((a, b) => b.evidenceCount - a.evidenceCount);
}
