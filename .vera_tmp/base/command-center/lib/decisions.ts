/**
 * Decision derivations — Phase 3 intelligence layer.
 *
 * Everything here is derived from rows the backend already produces. There is
 * no separate "decisions" table and none is needed: a real decision is the
 * `topic.selected` event main.py emits (agent `topic_manager`, metadata
 * `{topic}`), and its basis is the `topic_performance` row plus the
 * `feedback_signals` the FeedbackEngine wrote for that topic.
 *
 * Honesty rules encoded here:
 *  - A decision with no scored topic has `score: null` and is not explainable.
 *  - Confidence is a transparent function of evidence count (see CONFIDENCE_*),
 *    never a fabricated percentage.
 *  - Outcome is read from the events that actually followed the decision; when
 *    the stream cannot say, it is UNKNOWN rather than a guess.
 */
import type {
  FeedbackSignalRow,
  SystemEventRow,
  TopicPerformanceRow,
} from "@/lib/types";
import { storedMs } from "@/lib/format";

export type Confidence = "LOW" | "MEDIUM" | "HIGH";

/**
 * Evidence thresholds. The FeedbackEngine itself refuses to score below 2
 * videos (`_MIN_VIDEOS`), so 2 is the floor for any confidence at all.
 * These are deliberately coarse — they describe how much evidence exists,
 * not a statistical certainty.
 */
export const CONFIDENCE_MIN_EVIDENCE = 2;
export const CONFIDENCE_MEDIUM_EVIDENCE = 4;
export const CONFIDENCE_HIGH_EVIDENCE = 8;

/** Confidence from a real evidence count, or null when there isn't enough. */
export function confidenceFromEvidence(videos: number | null | undefined): Confidence | null {
  if (videos == null || videos < CONFIDENCE_MIN_EVIDENCE) return null;
  if (videos >= CONFIDENCE_HIGH_EVIDENCE) return "HIGH";
  if (videos >= CONFIDENCE_MEDIUM_EVIDENCE) return "MEDIUM";
  return "LOW";
}

export type SignalDirection = "up" | "down";

export interface DecisionSignal {
  signal: string;
  direction: SignalDirection;
  value: number | null;
  baseline: number | null;
  detail: string | null;
  videoId: string;
  analyzedDate: string;
}

/** Split a FeedbackEngine signal name into its direction. HIGH_/LOW_ prefixes
 *  are the engine's own vocabulary (feedback_engine._record_signals). */
export function signalDirection(signal: string): SignalDirection | null {
  if (signal.startsWith("HIGH_")) return "up";
  if (signal.startsWith("LOW_")) return "down";
  return null;
}

/** The metric a signal is about, e.g. HIGH_VIEW_VELOCITY -> VIEW_VELOCITY. */
export function signalMetric(signal: string): string {
  return signal.replace(/^HIGH_/, "").replace(/^LOW_/, "");
}

export function toDecisionSignal(row: FeedbackSignalRow): DecisionSignal | null {
  const direction = signalDirection(row.signal ?? "");
  if (!direction) return null;
  return {
    signal: row.signal,
    direction,
    value: row.metric_value,
    baseline: row.channel_baseline,
    detail: row.detail,
    videoId: row.video_id,
    analyzedDate: row.analyzed_date,
  };
}

export type DecisionOutcome = "PUBLISHED" | "FAILED" | "IN_PROGRESS" | "UNKNOWN";

export interface Decision {
  /** The real event_key of the topic.selected event — a stable decision id. */
  id: string;
  ts: string;
  /** Currently the only decision type the backend emits. */
  type: "topic.selected";
  agent: string | null;
  topic: string | null;
  /** From topic_performance; null when the topic has never been scored. */
  score: number | null;
  reason: string | null;
  videosAnalyzed: number | null;
  confidence: Confidence | null;
  signals: DecisionSignal[];
  outcome: DecisionOutcome;
  /** False when neither a reason nor any signal exists to explain it. */
  explainable: boolean;
}

const IN_PROGRESS_MS = 6 * 60 * 60 * 1000;

/** Read the topic out of a topic.selected event's metadata. */
export function decisionTopic(e: SystemEventRow): string | null {
  const raw = e.metadata?.["topic"];
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function isFailure(e: SystemEventRow): boolean {
  return (e.status ?? "").toLowerCase() === "failed" || e.event.endsWith(".failed");
}

/**
 * What actually happened after a decision, read from the events between it and
 * the next decision. This is a timeline reading, not a causal claim: it reports
 * the run that followed, and says UNKNOWN when the stream doesn't show one.
 */
export function deriveOutcome(
  decisionTs: string,
  nextDecisionTs: string | null,
  events: SystemEventRow[],
  now: number = Date.now(),
): DecisionOutcome {
  const start = (storedMs(decisionTs) ?? 0);
  const end = nextDecisionTs ? (storedMs(nextDecisionTs) ?? 0) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(start)) return "UNKNOWN";

  let sawFailure = false;
  let sawActivity = false;
  for (const e of events) {
    const t = (storedMs(e.ts) ?? 0);
    if (Number.isNaN(t) || t < start || t >= end) continue;
    sawActivity = true;
    if (e.event === "video.published" || e.event === "upload.completed") return "PUBLISHED";
    if (isFailure(e)) sawFailure = true;
  }
  if (sawFailure) return "FAILED";
  // Only the newest decision can still be running, and only for a while.
  if (end === Number.POSITIVE_INFINITY && now - start < IN_PROGRESS_MS) return "IN_PROGRESS";
  return sawActivity ? "UNKNOWN" : "UNKNOWN";
}

/**
 * Build the decision list from real rows. `events` must be newest-first (the
 * order every Command Center query already uses).
 */
export function deriveDecisions(
  events: SystemEventRow[],
  topicPerformance: TopicPerformanceRow[],
  signals: FeedbackSignalRow[],
  now: number = Date.now(),
): Decision[] {
  const perfByTopic = new Map<string, TopicPerformanceRow>();
  for (const p of topicPerformance) perfByTopic.set(p.topic, p);

  const signalsByTopic = new Map<string, DecisionSignal[]>();
  for (const s of signals) {
    if (!s.topic) continue;
    const ds = toDecisionSignal(s);
    if (!ds) continue;
    const arr = signalsByTopic.get(s.topic);
    if (arr) arr.push(ds);
    else signalsByTopic.set(s.topic, [ds]);
  }

  const decisionEvents = events.filter((e) => e.event === "topic.selected");

  return decisionEvents.map((e, i) => {
    // decisionEvents are newest-first, so the *next* decision chronologically
    // is the previous index.
    const nextTs = i > 0 ? decisionEvents[i - 1].ts : null;
    const topic = decisionTopic(e);
    const perf = topic ? perfByTopic.get(topic) ?? null : null;
    const sigs = topic ? signalsByTopic.get(topic) ?? [] : [];
    const videosAnalyzed = perf?.videos_analyzed ?? null;

    return {
      id: e.event_key,
      ts: e.ts,
      type: "topic.selected" as const,
      agent: e.agent,
      topic,
      score: perf?.score ?? null,
      reason: perf?.reason ?? null,
      videosAnalyzed,
      confidence: confidenceFromEvidence(videosAnalyzed),
      signals: sigs,
      outcome: deriveOutcome(e.ts, nextTs, events, now),
      explainable: Boolean(perf?.reason) || sigs.length > 0,
    };
  });
}

/** One step of the end-to-end intelligence trace for a video. */
export interface TraceStep {
  key:
    | "decision"
    | "generation"
    | "published"
    | "metrics"
    | "signals"
    | "score";
  at: string | null;
  done: boolean;
  /** A real detail drawn from the underlying row, or null when absent. */
  detail: string | null;
}

/**
 * The chain that answers "how did this video's result change what Nightshift does
 * next?" — decision -> generation -> publish -> metrics -> learning signals ->
 * topic score. Each step is `done` only when a real row/event backs it.
 */
export function buildTrace(
  videoId: string,
  topic: string | null,
  events: SystemEventRow[],
  snapshotCount: number,
  videoSignals: FeedbackSignalRow[],
  topicPerf: TopicPerformanceRow | null,
): TraceStep[] {
  const first = (name: string) =>
    events.find((e) => e.event === name && (e.video_id === videoId || e.video_id == null)) ?? null;

  const decision = topic
    ? events.find((e) => e.event === "topic.selected" && decisionTopic(e) === topic) ?? null
    : null;
  const generation = first("script.completed") ?? first("render.completed");
  const published = events.find(
    (e) => (e.event === "video.published" || e.event === "upload.completed") && e.video_id === videoId,
  ) ?? null;

  const latestSignalDate = videoSignals.length
    ? videoSignals
        .map((s) => s.analyzed_date)
        .sort()
        .slice(-1)[0]
    : null;

  return [
    {
      key: "decision",
      at: decision?.ts ?? null,
      done: Boolean(decision),
      detail: topic,
    },
    {
      key: "generation",
      at: generation?.ts ?? null,
      done: Boolean(generation),
      detail: generation?.event ?? null,
    },
    {
      key: "published",
      at: published?.ts ?? null,
      done: Boolean(published),
      detail: published ? videoId : null,
    },
    {
      key: "metrics",
      at: null,
      done: snapshotCount > 0,
      detail: snapshotCount > 0 ? `${snapshotCount}` : null,
    },
    {
      key: "signals",
      at: latestSignalDate,
      done: videoSignals.length > 0,
      detail: videoSignals.length > 0 ? `${videoSignals.length}` : null,
    },
    {
      key: "score",
      at: topicPerf?.updated_at ?? null,
      done: Boolean(topicPerf),
      detail: topicPerf ? topicPerf.score.toFixed(0) : null,
    },
  ];
}

/** One row of "where did this number come from". */
export interface LineageRow {
  label: string;
  value: string;
  /** The real table/computation the value came from. */
  source: string;
}

/**
 * Data lineage for a topic score. The formula is the FeedbackEngine's own:
 * score = clamp(50 * mean(topic_avg / channel_avg), 0, 100), where the ratios
 * are recorded verbatim in `reason`. Returns [] when the topic isn't scored.
 */
export function scoreLineage(perf: TopicPerformanceRow | null, signalCount: number): LineageRow[] {
  if (!perf) return [];
  const rows: LineageRow[] = [
    { label: "score", value: perf.score.toFixed(1), source: "topic_performance.score" },
    {
      label: "formula",
      value: "clamp(50 x mean(topic_avg / channel_avg), 0, 100)",
      source: "feedback_engine._score_topics",
    },
    { label: "ratios", value: perf.reason ?? "N/A", source: "topic_performance.reason" },
    {
      label: "videos analyzed",
      value: String(perf.videos_analyzed),
      source: "videos + metrics_snapshots",
    },
  ];
  if (perf.avg_views_per_day != null) {
    rows.push({
      label: "avg views/day",
      value: perf.avg_views_per_day.toFixed(2),
      source: "metrics_snapshots (views / days since publish)",
    });
  }
  rows.push({
    label: "learning signals",
    value: String(signalCount),
    source: "feedback_signals",
  });
  rows.push({ label: "last updated", value: perf.updated_at, source: "topic_performance.updated_at" });
  return rows;
}
