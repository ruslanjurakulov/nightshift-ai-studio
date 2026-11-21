/**
 * The Owner Console's reading of the owner's facts: the people and health blocks arrive as the database's JSON, and this
 * turns them into typed rows a page can draw. Pure, and deliberately suspicious: a key that is missing or not a number
 * reads null ("unknown"), never 0 — a renamed column or an unapplied migration must show as a gap, not as "nobody signed
 * up" or "no failures".
 */
import type { Fact } from "./facts-types";

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Json => x !== null) : []);
/** A count from the database: a finite number, else null. Postgres bigint counts may arrive as strings. */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** A block's value, or why it is missing. */
export function block(f: Fact<Json>): { ok: true; doc: Json; asOf: string } | { ok: false; why: string } {
  return f.state === "unknown" ? { ok: false, why: f.why } : { ok: true, doc: f.value, asOf: f.as_of };
}

export interface PlanCount {
  plan: string;
  count: number | null;
}
const byPlan = (v: unknown): PlanCount[] =>
  Object.entries(obj(v) ?? {})
    .map(([plan, n]) => ({ plan, count: num(n) }))
    .sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || a.plan.localeCompare(b.plan));

export interface PeopleView {
  signups: { d1: number | null; d7: number | null; d30: number | null; total: number | null; unconfirmedD30: number | null };
  signedIn: { d7: number | null; d30: number | null };
  paying: PlanCount[];
  payingTotal: number | null;
  trialing: PlanCount[];
  pastDue: number | null;
  cancelling: number | null;
  canceledD30: number | null;
  recent: Array<{ workspace: string | null; workspaceId: string | null; plan: string | null; status: string | null; at: string | null }>;
  internalExcluded: boolean;
}

export function peopleView(doc: Json): PeopleView {
  const s = obj(doc.signups) ?? {};
  const si = obj(doc.signed_in) ?? {};
  const paying = byPlan(doc.paying_by_plan);
  return {
    signups: { d1: num(s.d1), d7: num(s.d7), d30: num(s.d30), total: num(s.total), unconfirmedD30: num(s.unconfirmed_d30) },
    signedIn: { d7: num(si.d7), d30: num(si.d30) },
    paying,
    // A missing object is unknown; an empty one is a measured zero (the database answered "no paying workspace").
    payingTotal: obj(doc.paying_by_plan) === null ? null : paying.some((p) => p.count === null) ? null : paying.reduce((n, p) => n + (p.count ?? 0), 0),
    trialing: byPlan(doc.trialing_by_plan),
    pastDue: num(doc.past_due),
    cancelling: num(doc.cancelling),
    canceledD30: num(doc.canceled_d30),
    recent: arr(doc.recent_plan_changes).map((r) => ({
      workspace: str(r.workspace),
      workspaceId: str(r.workspace_id),
      plan: str(r.plan),
      status: str(r.status),
      at: str(r.at),
    })),
    internalExcluded: doc.internal_excluded === true,
  };
}

export interface ChannelHealth {
  id: string;
  name: string | null;
  status: string | null;
  lastRunAt: string | null;
  failures24h: number | null;
  failures7d: number | null;
  lastPublishedAt: string | null;
  held: number | null;
  tokenStored: boolean | null;
  credentialStatus: string | null;
}

export interface QueueView {
  queued: number | null;
  oldestQueuedAt: string | null;
  running: number | null;
  stuck: number | null;
  failed24h: number | null;
  quotaFailed24h: number | null;
}

export interface HealthView {
  channels: ChannelHealth[];
  creative: QueueView;
  render: QueueView;
  workers: Array<{ id: string; kind: string | null; state: string | null; updatedAt: string | null; stale: boolean | null }>;
  doctor: { verdict: "ok" | "fail" | "unknown"; at: string | null };
  alerts: { critical: number | null; warn: number | null; criticalPlatform: number | null };
  lookbackDays: number | null;
}

const queue = (v: unknown): QueueView => {
  const q = obj(v) ?? {};
  return {
    queued: num(q.queued),
    oldestQueuedAt: str(q.oldest_queued_at),
    running: num(q.running),
    stuck: num(q.stuck),
    failed24h: num(q.failed_24h),
    quotaFailed24h: num(q.quota_failed_24h),
  };
};

export function healthView(doc: Json): HealthView {
  const queues = obj(doc.queues) ?? {};
  const doctor = obj(doc.doctor) ?? {};
  const alerts = obj(doc.alerts_24h) ?? {};
  const verdict = doctor.verdict === "ok" || doctor.verdict === "fail" ? doctor.verdict : "unknown";
  return {
    channels: arr(doc.channels)
      .map((c) => {
        const yt = obj(c.youtube) ?? {};
        return {
          id: str(c.channel_id) ?? "",
          name: str(c.name),
          status: str(c.status),
          lastRunAt: str(c.last_run_event_at),
          failures24h: num(c.failure_events_24h),
          failures7d: num(c.failure_events_7d),
          lastPublishedAt: str(c.last_published_at),
          held: num(c.held_videos),
          tokenStored: bool(yt.token_stored),
          credentialStatus: str(yt.credential_status),
        };
      })
      .filter((c) => c.id !== ""),
    creative: queue(queues.creative),
    render: queue(queues.render),
    workers: arr(doc.workers)
      .map((w) => ({ id: str(w.worker_id) ?? "", kind: str(w.kind), state: str(w.state), updatedAt: str(w.updated_at), stale: bool(w.stale) }))
      .filter((w) => w.id !== ""),
    doctor: { verdict, at: verdict === "unknown" ? null : str(doctor.at) },
    alerts: { critical: num(alerts.critical), warn: num(alerts.warn), criticalPlatform: num(alerts.critical_platform) },
    lookbackDays: num(doc.lookback_days),
  };
}

/** A channel needs a look when it failed in the last day, holds videos for review, or its YouTube credential is not
 *  `connected` (0001: connected | not_connected | expired | error). */
export function channelNeedsLook(c: ChannelHealth): boolean {
  return (c.failures24h ?? 0) > 0 || (c.held ?? 0) > 0 || c.tokenStored === false || (c.credentialStatus !== null && c.credentialStatus !== "connected");
}
