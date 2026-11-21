/**
 * Autonomy derivations — Phase 4.
 *
 * Like the Phase 3 layer this is read-only and derived from rows the backend
 * already mirrors into Supabase. It deliberately does **not** invent an
 * autonomy control surface the backend would ignore.
 *
 * What this deployment can and cannot do is reported truthfully:
 *  - The scheduled intelligence poll really does analyse, score and learn on
 *    its own — that is genuine autonomy, and the evidence is the heartbeat.
 *  - Publishing is **unconditional**: `tools/approve_run.py` records approval
 *    for the audit trail, but `main.py` is not gated on it. Reporting that
 *    honestly is the point of the posture view.
 *  - Autonomy mode, emergency stop and operational limits have no mechanism
 *    in the backend at all, so they are NOT CONFIGURED rather than a toggle
 *    that changes nothing.
 */
import type { MetricsSnapshotRow, SystemEventRow, VideoRow } from "@/lib/types";
import { parseStoredTime, statusTone, storedMs } from "@/lib/format";

/** How a capability actually behaves in this deployment. */
export type CapabilityState =
  | "automatic"
  | "records_only"
  | "unconditional"
  | "not_configured";

export interface PostureItem {
  key:
    | "analytics"
    | "learning"
    | "scoring"
    | "monitoring"
    | "publishing"
    | "approval"
    | "autonomyMode"
    | "emergencyStop"
    | "limits";
  state: CapabilityState;
  /** A real timestamp backing the claim, when one exists. */
  evidenceTs: string | null;
}

const AUTOMATIC_WINDOW_MS = 48 * 60 * 60 * 1000;

function latest(events: SystemEventRow[], match: (e: SystemEventRow) => boolean): string | null {
  return events.find(match)?.ts ?? null;
}

/**
 * The real autonomy posture. The "automatic" claims are only made when a real
 * event proves the scheduled work ran recently; everything the backend has no
 * mechanism for is reported as NOT CONFIGURED.
 */
export function autonomyPosture(events: SystemEventRow[], now: number = Date.now()): PostureItem[] {
  const heartbeat = latest(events, (e) => e.event === "system.heartbeat");
  const feedback = latest(events, (e) => e.event === "feedback.generated" || e.event === "feedback.applied");
  const recent = (ts: string | null) => Boolean(ts && now - (storedMs(ts) ?? 0) < AUTOMATIC_WINDOW_MS);

  return [
    { key: "analytics", state: recent(heartbeat) ? "automatic" : "not_configured", evidenceTs: heartbeat },
    { key: "learning", state: recent(feedback) ? "automatic" : "not_configured", evidenceTs: feedback },
    { key: "scoring", state: recent(feedback) ? "automatic" : "not_configured", evidenceTs: feedback },
    { key: "monitoring", state: recent(heartbeat) ? "automatic" : "not_configured", evidenceTs: heartbeat },
    // main.py uploads without consulting the approval flag — stated plainly.
    { key: "publishing", state: "unconditional", evidenceTs: null },
    // tools/approve_run.py exists but is record-keeping only.
    { key: "approval", state: "records_only", evidenceTs: null },
    { key: "autonomyMode", state: "not_configured", evidenceTs: null },
    { key: "emergencyStop", state: "not_configured", evidenceTs: null },
    { key: "limits", state: "not_configured", evidenceTs: null },
  ];
}

export interface AutonomousAction {
  id: string;
  ts: string;
  agent: string;
  event: string;
  status: string | null;
  videoId: string | null;
  durationMs: number | null;
  outcome: "ok" | "failed" | "running" | "unknown";
}

/**
 * Actions Nightshift took on its own, straight from the agent-attributed event
 * stream. Events with no agent are infrastructure noise and are left out.
 */
export function autonomousActions(events: SystemEventRow[], limit = 100): AutonomousAction[] {
  const out: AutonomousAction[] = [];
  for (const e of events) {
    if (!e.agent) continue;
    const tone = statusTone(e.status);
    out.push({
      id: e.event_key,
      ts: e.ts,
      agent: e.agent,
      event: e.event,
      status: e.status,
      videoId: e.video_id,
      durationMs: e.duration_ms,
      outcome: tone === "ok" ? "ok" : tone === "fail" ? "failed" : tone === "run" ? "running" : "unknown",
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface AutonomyHealth {
  successful: number;
  failed: number;
  running: number;
  /** Human interventions are not recorded anywhere yet — null, not zero. */
  humanInterventions: number | null;
  windowHours: number;
}

/** Transparent counts over a real window — never collapsed into a single
 *  invented percentage. */
export function autonomyHealth(events: SystemEventRow[], windowHours = 24, now: number = Date.now()): AutonomyHealth {
  const cutoff = now - windowHours * 60 * 60 * 1000;
  let successful = 0;
  let failed = 0;
  let running = 0;
  for (const e of events) {
    const t = (storedMs(e.ts) ?? 0);
    if (Number.isNaN(t) || t < cutoff) continue;
    if (!e.agent) continue;
    const tone = statusTone(e.status);
    if (tone === "ok") successful += 1;
    else if (tone === "fail") failed += 1;
    else if (tone === "run") running += 1;
  }
  return { successful, failed, running, humanInterventions: null, windowHours };
}

export type GateKey = "script" | "voice" | "media" | "thumbnail" | "render" | "upload";

export interface GateItem {
  key: GateKey;
  ok: boolean;
  at: string | null;
}

export interface QualityGate {
  items: GateItem[];
  /** True only when every stage really completed and nothing failed. */
  ready: boolean;
  failures: number;
}

const GATE_EVENTS: Record<GateKey, string[]> = {
  script: ["script.completed"],
  voice: ["voice.completed"],
  media: ["media.completed"],
  thumbnail: ["thumbnail.completed"],
  render: ["render.completed"],
  upload: ["upload.completed", "video.published"],
};

/**
 * Read-only content quality gate for one video: which stages actually
 * completed, from that video's own events. It reports; it does not gate — the
 * publish path is untouched.
 */
export function qualityGate(videoEvents: SystemEventRow[]): QualityGate {
  const items: GateItem[] = (Object.keys(GATE_EVENTS) as GateKey[]).map((key) => {
    const hit = videoEvents.find((e) => GATE_EVENTS[key].includes(e.event)) ?? null;
    return { key, ok: Boolean(hit), at: hit?.ts ?? null };
  });
  const failures = videoEvents.filter((e) => e.event.endsWith(".failed") || statusTone(e.status) === "fail").length;
  return { items, ready: items.every((i) => i.ok) && failures === 0, failures };
}

export interface FailureGroup {
  agent: string;
  event: string;
  count: number;
  lastTs: string;
  /** Only a cause the backend actually recorded in metadata.error. */
  cause: string | null;
}

/** What keeps going wrong, grouped from real failure events. A cause is shown
 *  only when the backend recorded one — never guessed. */
export function failureLearning(events: SystemEventRow[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const e of events) {
    const isFail = e.event.endsWith(".failed") || statusTone(e.status) === "fail";
    if (!isFail) continue;
    const agent = e.agent ?? "system";
    const key = `${agent}:${e.event}`;
    const rawCause = e.metadata?.["error"];
    const cause = typeof rawCause === "string" && rawCause.trim() ? rawCause : null;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if ((storedMs(e.ts) ?? 0) > (storedMs(existing.lastTs) ?? 0)) {
        existing.lastTs = e.ts;
        if (cause) existing.cause = cause;
      }
    } else {
      groups.set(key, { agent, event: e.event, count: 1, lastTs: e.ts, cause });
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

/** Minimum published videos with metrics before a publishing window is worth
 *  reporting at all. Below this the answer is INSUFFICIENT DATA. */
export const WINDOW_MIN_VIDEOS = 5;

export interface PublishingWindow {
  /** 0 = Sunday … 6 = Saturday, in UTC. */
  weekday: number;
  hour: number;
  evidence: number;
  meanViewsPerDay: number;
}

/**
 * The best *observed* publishing window for this channel — never a universal
 * "best time to post". Returns null below the evidence floor.
 */
export function publishingWindow(
  videos: VideoRow[],
  snapshots: MetricsSnapshotRow[],
): PublishingWindow | null {
  const latestByVideo = new Map<string, MetricsSnapshotRow>();
  for (const s of snapshots) {
    const prev = latestByVideo.get(s.video_id);
    if (!prev || (s.snapshot_date ?? "") >= (prev.snapshot_date ?? "")) latestByVideo.set(s.video_id, s);
  }

  interface Bucket { weekday: number; hour: number; total: number; n: number }
  const buckets = new Map<string, Bucket>();
  let measured = 0;

  for (const v of videos) {
    if (!v.published_at) continue;
    const m = latestByVideo.get(v.video_id);
    if (!m || m.views == null) continue;
    const published = parseStoredTime(v.published_at);
    const measuredAt = m.snapshot_date ? parseStoredTime(m.snapshot_date) : null;
    // parseStoredTime already returns null for anything unparseable, so the
    // NaN checks this replaces are now the null checks.
    if (!published || !measuredAt) continue;
    const days = Math.max(1, Math.floor((measuredAt.getTime() - published.getTime()) / 86400000));
    const vpd = m.views / days;
    measured += 1;

    const weekday = published.getUTCDay();
    const hour = published.getUTCHours();
    const key = `${weekday}:${hour}`;
    const b = buckets.get(key) ?? { weekday, hour, total: 0, n: 0 };
    b.total += vpd;
    b.n += 1;
    buckets.set(key, b);
  }

  if (measured < WINDOW_MIN_VIDEOS || buckets.size === 0) return null;

  let best: Bucket | null = null;
  let bestMean = -1;
  for (const b of buckets.values()) {
    const mean = b.total / b.n;
    if (mean > bestMean) {
      bestMean = mean;
      best = b;
    }
  }
  if (!best) return null;
  return { weekday: best.weekday, hour: best.hour, evidence: best.n, meanViewsPerDay: bestMean };
}

/** Normalize a topic for duplicate comparison. */
export function normalizeTopic(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export interface DuplicateGroup {
  topic: string;
  videoIds: string[];
  count: number;
}

/**
 * Topics this channel already covered more than once — real repetition in the
 * published library, not a prediction about a future idea.
 */
export function duplicateTopics(videos: VideoRow[]): DuplicateGroup[] {
  const byNorm = new Map<string, { topic: string; ids: string[] }>();
  for (const v of videos) {
    if (!v.topic) continue;
    const norm = normalizeTopic(v.topic);
    if (!norm) continue;
    const entry = byNorm.get(norm) ?? { topic: v.topic, ids: [] };
    entry.ids.push(v.video_id);
    byNorm.set(norm, entry);
  }
  return Array.from(byNorm.values())
    .filter((e) => e.ids.length > 1)
    .map((e) => ({ topic: e.topic, videoIds: e.ids, count: e.ids.length }))
    .sort((a, b) => b.count - a.count);
}
