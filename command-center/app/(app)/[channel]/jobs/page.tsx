import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, EmptyState, StatCard } from "@/components/ui";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelScope } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { fmt } from "@/lib/i18n";
import type { SystemEventRow } from "@/lib/types";
import { JobStatusPill, type JobStatus } from "@/components/jobs/JobStatusPill";
import { CopyButton } from "@/components/feedback/CopyButton";
import { relativeTime, statusTone, storedMs } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface DerivedJob {
  id: string;
  keyedBy: "job_id" | "video_id";
  status: JobStatus;
  agents: string[];
  events: number;
  latestEvent: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

function jobStatusFrom(tone: ReturnType<typeof statusTone>): JobStatus {
  switch (tone) {
    case "run":
      return "RUNNING";
    case "fail":
      return "FAILED";
    case "ok":
      return "COMPLETED";
    default:
      return "QUEUED";
  }
}

function deriveJobs(events: SystemEventRow[]): DerivedJob[] {
  // Group by job_id when present; otherwise treat a video's run as one job
  // keyed by video_id. Events with neither key aren't jobs (they're system
  // passes) and are left out here.
  const groups = new Map<string, { keyedBy: "job_id" | "video_id"; rows: SystemEventRow[] }>();
  for (const e of events) {
    let key: string | null = null;
    let keyedBy: "job_id" | "video_id" = "job_id";
    if (e.job_id) {
      key = `job:${e.job_id}`;
      keyedBy = "job_id";
    } else if (e.video_id) {
      key = `vid:${e.video_id}`;
      keyedBy = "video_id";
    }
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.rows.push(e);
    else groups.set(key, { keyedBy, rows: [e] });
  }

  const jobs: DerivedJob[] = [];
  for (const { keyedBy, rows } of groups.values()) {
    // rows are newest-first (query order).
    const latest = rows[0];
    const times = rows
      .map((r) => (storedMs(r.ts) ?? 0))
      .filter((t) => !Number.isNaN(t));
    const earliestTs = times.length ? new Date(Math.min(...times)).toISOString() : null;
    const latestTs = times.length ? new Date(Math.max(...times)).toISOString() : null;
    const tone = statusTone(latest.status);
    const status = jobStatusFrom(tone);

    // Duration: prefer an explicit duration_ms on the latest event; else the
    // wall-clock span of the job's events when it's finished.
    let durationMs: number | null = latest.duration_ms ?? null;
    if (durationMs === null && (status === "COMPLETED" || status === "FAILED") && earliestTs && latestTs) {
      const span = new Date(latestTs).getTime() - (storedMs(earliestTs) ?? 0);
      durationMs = span > 0 ? span : null;
    }

    jobs.push({
      id: keyedBy === "job_id" ? (latest.job_id as string) : (latest.video_id as string),
      keyedBy,
      status,
      agents: Array.from(new Set(rows.map((r) => r.agent).filter((a): a is string => Boolean(a)))),
      events: rows.length,
      latestEvent: latest.event,
      startedAt: earliestTs,
      completedAt: status === "COMPLETED" || status === "FAILED" ? latestTs : null,
      durationMs,
    });
  }

  // Active (running) first, then failed, then by most recent activity.
  const rank: Record<JobStatus, number> = { RUNNING: 0, FAILED: 1, QUEUED: 2, COMPLETED: 3 };
  return jobs.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime();
  });
}

function durationLabel(ms: number | null): string {
  if (ms === null) return "N/A";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export default async function JobsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope channel-owned queries to the selected channel (view control;
  // RLS still decides what may be read at all).
  const scope = await getChannelScope();

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  let dbError = false;

  if (supabase) {
    const ev = await scopeQuery(
        supabase.from("system_events").select("*"),
        scope, { nullIsGlobal: true },
      )
      .order("ts", { ascending: false })
      .limit(500);
    if (ev.error) dbError = true;
    events = (ev.data as SystemEventRow[]) ?? [];
  }

  const jobs = deriveJobs(events);
  const running = jobs.filter((j) => j.status === "RUNNING").length;
  const failed = jobs.filter((j) => j.status === "FAILED").length;
  const completed = jobs.filter((j) => j.status === "COMPLETED").length;

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="jobs" title={t.jobs.title} subtitle={t.jobs.subtitle} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t.jobs.jobs} value={<AnimatedNumber value={jobs.length} />} sub={t.jobs.jobsSub} />
        <StatCard label={t.jobs.running} value={<AnimatedNumber value={running} />} tone={running ? "run" : "idle"} sub={running ? t.jobs.inProgress : t.jobs.noneActive} />
        <StatCard label={t.jobs.failed} value={<AnimatedNumber value={failed} />} tone={failed ? "fail" : "ok"} sub={failed ? t.jobs.needsAttention : t.jobs.none} />
        <StatCard label={t.jobs.completed} value={<AnimatedNumber value={completed} />} tone="ok" sub={t.jobs.finishedOk} />
      </div>

      <Panel title={t.jobs.panel}>
        {dbError ? (
          <EmptyState>{t.jobs.dbErr}</EmptyState>
        ) : jobs.length === 0 ? (
          <EmptyState>{t.jobs.empty}</EmptyState>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                    <th className="px-4 py-2 font-semibold">{t.jobs.thJob}</th>
                    <th className="px-4 py-2 font-semibold">{t.jobs.thAgents}</th>
                    <th className="px-4 py-2 font-semibold">{t.jobs.thLatest}</th>
                    <th className="px-4 py-2 font-semibold">{t.jobs.thStarted}</th>
                    <th className="px-4 py-2 font-semibold">{t.jobs.thCompleted}</th>
                    <th className="px-4 py-2 font-semibold">{t.jobs.thDuration}</th>
                    <th className="px-4 py-2 font-semibold">{t.jobs.thStatus}</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={`${j.keyedBy}-${j.id}`} className="border-b border-[var(--color-border)]/50 align-top transition-colors hover:bg-[var(--color-panel-2)]">
                      <td className="px-4 py-2">
                        <div className="flex min-w-0 items-center gap-1">
                          <span className="mono min-w-0 truncate text-[12px] text-[var(--color-fg)]">{j.id}</span>
                          <CopyButton value={j.id} label={j.id} />
                        </div>
                        <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                          {j.keyedBy === "job_id" ? t.jobs.byJobId : t.jobs.byVideo}
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <div className="mono text-[11px] text-[var(--color-primary)]">
                          {j.agents.length ? j.agents.join(", ") : t.common.system}
                        </div>
                        <div className="mono text-[10px] text-[var(--color-muted)]">{fmt(t.jobs.eventsN, { n: j.events })}</div>
                      </td>
                      <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">{j.latestEvent}</td>
                      <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">{relativeTime(j.startedAt)}</td>
                      <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">
                        {j.completedAt ? relativeTime(j.completedAt) : t.common.dash}
                      </td>
                      <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">{durationLabel(j.durationMs)}</td>
                      <td className="px-4 py-2">
                        <JobStatusPill status={j.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-[var(--color-border)] px-4 py-2 mono text-[10px] text-[var(--color-muted)]">
              {t.jobs.readOnly}
            </p>
          </>
        )}
      </Panel>
    </div>
  );
}
