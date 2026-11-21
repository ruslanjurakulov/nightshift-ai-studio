/**
 * Real-data intelligence derivations shared across the "operations center"
 * features. Every function reads only rows the backend actually produced
 * (system_events, videos, metrics_snapshots, feedback_signals). Nothing here
 * invents state — absence is reported as "idle" / empty / N/A by the callers.
 */
import type { FeedbackSignalRow, MetricsSnapshotRow, SystemEventRow, VideoRow } from "@/lib/types";
import { statusTone, storedMs } from "@/lib/format";

export type EventCategory = "system" | "ai" | "video" | "analytics" | "error";

/** One primary category per event, from its name/status. Used by the live
 *  stream filters — a real classification of a real event, never a label we
 *  attach to invented activity. */
export function categorize(e: SystemEventRow): EventCategory {
  const ev = (e.event ?? "").toLowerCase();
  if (statusTone(e.status) === "fail" || ev.endsWith(".failed") || ev.includes("error")) return "error";
  if (ev.startsWith("feedback") || ev.startsWith("analytics") || ev.includes("metrics")) return "analytics";
  if (ev.startsWith("topic") || ev.startsWith("script") || ev.startsWith("research") || ev.startsWith("demand") || ev.startsWith("intelligence")) return "ai";
  if (
    ev.startsWith("video") ||
    ev.startsWith("upload") ||
    ev.startsWith("render") ||
    ev.startsWith("voice") ||
    ev.startsWith("media") ||
    ev.startsWith("thumbnail")
  )
    return "video";
  return "system";
}

export type CoreState =
  | "idle"
  | "observing"
  | "analyzing"
  | "learning"
  | "deciding"
  | "generating"
  | "publishing"
  | "measuring"
  | "error"
  | "disconnected";

const ACTIVE_MS = 5 * 60 * 1000;

/**
 * The Nightshift Core's state, from the newest real event and the realtime
 * connection. Between polls the system genuinely is idle, so idle is the
 * honest resting state — not a placeholder.
 */
export function deriveCoreState(events: SystemEventRow[], connected: boolean): CoreState {
  if (!connected) return "disconnected";
  const e = events[0];
  if (!e) return "idle";
  if (statusTone(e.status) === "fail" || (e.event ?? "").endsWith(".failed")) return "error";

  const fresh = Date.now() - (storedMs(e.ts) ?? 0) < ACTIVE_MS;
  if (!fresh) return "idle";

  const ev = (e.event ?? "").toLowerCase();
  if (ev.startsWith("feedback")) return "learning";
  if (ev.startsWith("topic")) return "deciding";
  if (ev.startsWith("video.published") || ev.startsWith("upload")) return "publishing";
  if (ev.startsWith("script") || ev.startsWith("voice") || ev.startsWith("media") || ev.startsWith("render") || ev.startsWith("thumbnail") || ev.startsWith("research")) return "generating";
  if (ev.startsWith("analytics") || ev.includes("metrics")) return "measuring";
  if (ev.startsWith("system.heartbeat") || ev.startsWith("intelligence")) return "observing";
  if (statusTone(e.status) === "run") return "generating";
  return "idle";
}

export type SubsystemKey = "youtube" | "supabase" | "ai" | "realtime" | "scheduler" | "storage";
export type HealthTone = "ok" | "warn" | "fail" | "idle";

export interface Subsystem {
  key: SubsystemKey;
  tone: HealthTone;
  /** "operational" | "degraded" | "offline" | "unknown" — mapped to i18n by the view. */
  state: "operational" | "degraded" | "offline" | "unknown";
  lastSuccess: string | null;
}

const RECENT_MS = 3 * 24 * 60 * 60 * 1000;
const SCHED_MS = 24 * 60 * 60 * 1000; // a poll is expected at least daily

function latest(events: SystemEventRow[], match: (e: SystemEventRow) => boolean): string | null {
  const hit = events.find(match);
  return hit?.ts ?? null;
}

function healthFrom(okTs: string | null, failTs: string | null): Subsystem["state"] & string {
  if (okTs && Date.now() - (storedMs(okTs) ?? 0) < RECENT_MS) return "operational";
  if (failTs) return "degraded";
  if (okTs) return "unknown";
  return "unknown";
}

const TONE_FOR: Record<Subsystem["state"], HealthTone> = {
  operational: "ok",
  degraded: "warn",
  offline: "fail",
  unknown: "idle",
};

/** Subsystem statuses from real event presence/recency + live signals. A
 *  subsystem with no signal is UNKNOWN, never green-by-default. */
export function subsystemHealth(events: SystemEventRow[], dbOk: boolean, connected: boolean): Subsystem[] {
  const okYt = latest(events, (e) => e.event === "upload.completed" || e.event === "video.published");
  const failYt = latest(events, (e) => e.event === "upload.failed");
  const okAi = latest(events, (e) => e.event === "script.completed" || e.event === "topic.selected");
  const failAi = latest(events, (e) => e.event === "agent.failed");
  const okHeartbeat = latest(events, (e) => e.event === "system.heartbeat");

  const ytState = healthFrom(okYt, failYt);
  const aiState = healthFrom(okAi, failAi);
  const schedState: Subsystem["state"] =
    okHeartbeat && Date.now() - (storedMs(okHeartbeat) ?? 0) < SCHED_MS ? "operational" : okHeartbeat ? "unknown" : "unknown";

  const subs: Subsystem[] = [
    { key: "supabase", state: dbOk ? "operational" : "offline", tone: dbOk ? "ok" : "fail", lastSuccess: dbOk ? new Date().toISOString() : null },
    { key: "realtime", state: connected ? "operational" : "degraded", tone: connected ? "ok" : "warn", lastSuccess: connected ? new Date().toISOString() : null },
    { key: "youtube", state: ytState, tone: TONE_FOR[ytState], lastSuccess: okYt },
    { key: "ai", state: aiState, tone: TONE_FOR[aiState], lastSuccess: okAi },
    { key: "scheduler", state: schedState, tone: TONE_FOR[schedState], lastSuccess: okHeartbeat },
    // No dedicated storage signal exists in the event stream — honest UNKNOWN.
    { key: "storage", state: "unknown", tone: "idle", lastSuccess: null },
  ];
  return subs;
}

/** Overall banner: operational unless something is offline/degraded. */
export function overallStatus(subs: Subsystem[]): "operational" | "degraded" | "offline" {
  if (subs.some((s) => s.state === "offline")) return "offline";
  if (subs.some((s) => s.state === "degraded")) return "degraded";
  return "operational";
}

export const PIPELINE_ORDER = [
  "topic",
  "research",
  "script",
  "voice",
  "media",
  "thumbnail",
  "render",
  "upload",
  "publish",
] as const;

export type PipelineStageKey = (typeof PIPELINE_ORDER)[number];

/**
 * Infer the next pipeline stage strictly from a real in-flight video: find the
 * most recent event that maps to a stage and return the following stage. When
 * nothing is in progress, returns null → the view shows N/A. This is derived
 * from real state, not a fabricated schedule.
 */
export function inferNextStage(events: SystemEventRow[]): { key: PipelineStageKey; after: PipelineStageKey } | null {
  const stageOf = (ev: string): PipelineStageKey | null => {
    const e = ev.toLowerCase();
    if (e.startsWith("video.published")) return "publish";
    for (const s of PIPELINE_ORDER) if (e.startsWith(s + ".")) return s;
    return null;
  };
  for (const e of events) {
    // events are newest-first
    if (e.event.endsWith(".completed") || e.event === "video.published" || statusTone(e.status) === "run") {
      const s = stageOf(e.event);
      if (!s) continue;
      const idx = PIPELINE_ORDER.indexOf(s);
      if (idx >= 0 && idx < PIPELINE_ORDER.length - 1) {
        return { key: PIPELINE_ORDER[idx + 1], after: s };
      }
      return null; // last stage reached
    }
  }
  return null;
}

function isSameUtcDay(iso: string | null | undefined, now = new Date()): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

export interface Mission {
  publishedToday: number;
  analyticsToday: number;
  learningToday: number;
}

/** Today's real activity counts. No targets exist in the backend, so the view
 *  shows these counts and marks any goal/percentage as N/A. */
export function dailyMission(
  videos: VideoRow[],
  snapshots: MetricsSnapshotRow[],
  signals: FeedbackSignalRow[],
): Mission {
  return {
    publishedToday: videos.filter((v) => isSameUtcDay(v.published_at)).length,
    analyticsToday: snapshots.filter((s) => isSameUtcDay(s.snapshot_date)).length,
    learningToday: signals.filter((s) => isSameUtcDay(s.analyzed_date)).length,
  };
}

export type NotificationKind = "published" | "error" | "learning" | "anomaly" | "storyboard";

export interface Notification {
  id: string;
  kind: NotificationKind;
  ts: string;
  /** A real, human-readable subject taken from the event/signal itself. */
  subject: string;
}

/**
 * Build meaningful notifications from real rows only: published videos,
 * failures, learning signals, and below-baseline (LOW_*) performance
 * anomalies. Newest first, capped.
 */
export function buildNotifications(events: SystemEventRow[], signals: FeedbackSignalRow[], limit = 20): Notification[] {
  const out: Notification[] = [];
  for (const e of events) {
    if (e.event === "video.published" || e.event === "upload.completed") {
      out.push({ id: `ev:${e.event_key}`, kind: "published", ts: e.ts, subject: e.video_id ?? e.event });
    } else if (e.event === "storyboard.ready") {
      // A run stopped before its render and waits for a person (migration 0057).
      const slug = (e.metadata as { slug?: unknown } | null)?.slug;
      out.push({ id: `ev:${e.event_key}`, kind: "storyboard", ts: e.ts, subject: typeof slug === "string" && slug ? slug : e.event });
    } else if (statusTone(e.status) === "fail" || e.event.endsWith(".failed")) {
      out.push({ id: `ev:${e.event_key}`, kind: "error", ts: e.ts, subject: `${e.agent ?? "system"} · ${e.event}` });
    }
  }
  for (const s of signals) {
    if (s.signal?.startsWith("LOW_")) {
      out.push({ id: `sig:${s.video_id}:${s.signal}:${s.analyzed_date}`, kind: "anomaly", ts: s.analyzed_date, subject: `${s.topic ?? s.video_id} · ${s.signal}` });
    } else if (s.signal?.startsWith("HIGH_")) {
      out.push({ id: `sig:${s.video_id}:${s.signal}:${s.analyzed_date}`, kind: "learning", ts: s.analyzed_date, subject: `${s.topic ?? s.video_id} · ${s.signal}` });
    }
  }
  return out
    .sort((a, b) => new Date(b.ts).getTime() - (storedMs(a.ts) ?? 0))
    .slice(0, limit);
}
