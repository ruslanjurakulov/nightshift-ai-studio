import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { EmptyState, StatCard } from "@/components/ui";
import { Section } from "@/components/g3/Section";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelScope } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import { fmt } from "@/lib/i18n";
import type { SystemEventRow } from "@/lib/types";
import { JobStatusLamp, type JobStatus } from "@/components/jobs/JobStatusLamp";
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
    <div className="rhythm ns-open stagger-enter">
      <PageHeader icon="jobs" title={t.jobs.title} subtitle={t.jobs.subtitle} />

      <div className="g3-figures">
        <StatCard label={t.jobs.jobs} value={<AnimatedNumber value={jobs.length} />} sub={t.jobs.jobsSub} />
        <StatCard label={t.jobs.running} value={<AnimatedNumber value={running} />} tone={running ? "run" : "idle"} sub={running ? t.jobs.inProgress : t.jobs.noneActive} />
        <StatCard label={t.jobs.failed} value={<AnimatedNumber value={failed} />} tone={failed ? "fail" : "ok"} sub={failed ? t.jobs.needsAttention : t.jobs.none} />
        <StatCard label={t.jobs.completed} value={<AnimatedNumber value={completed} />} tone="ok" sub={t.jobs.finishedOk} />
      </div>

      <Section title={t.jobs.panel} desk>
        {dbError ? (
          <EmptyState>{t.jobs.dbErr}</EmptyState>
        ) : jobs.length === 0 ? (
          <EmptyState>{t.jobs.empty}</EmptyState>
        ) : (
          <>
            <table className="g3-table g3-jobs">
              <thead>
                <tr>
                  <th scope="col">{t.jobs.thJob}</th>
                  <th scope="col">{t.jobs.thAgents}</th>
                  <th scope="col">{t.jobs.thLatest}</th>
                  <th scope="col">{t.jobs.thStarted}</th>
                  <th scope="col">{t.jobs.thCompleted}</th>
                  <th scope="col">{t.jobs.thDuration}</th>
                  <th scope="col">{t.jobs.thStatus}</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={`${j.keyedBy}-${j.id}`}>
                    <td className="g3-cell-main" data-label={t.jobs.thJob}>
                      <div className="flex min-w-0 items-center gap-1">
                        <span className="mono min-w-0 truncate text-sm text-[var(--color-fg)]">{j.id}</span>
                        <CopyButton value={j.id} label={j.id} />
                      </div>
                      <div className="g3-sub">{j.keyedBy === "job_id" ? t.jobs.byJobId : t.jobs.byVideo}</div>
                    </td>
                    <td data-label={t.jobs.thAgents}>
                      <div className="tnum text-sm text-[var(--color-primary)]">
                        {j.agents.length ? j.agents.join(", ") : t.common.system}
                      </div>
                      <div className="tnum g3-sub">{fmt(t.jobs.eventsN, { n: j.events })}</div>
                    </td>
                    <td className="tnum g3-sub" data-label={t.jobs.thLatest}>{j.latestEvent}</td>
                    <td className="tnum g3-sub" data-label={t.jobs.thStarted}>{relativeTime(j.startedAt)}</td>
                    <td className="tnum g3-sub" data-label={t.jobs.thCompleted}>
                      {j.completedAt ? relativeTime(j.completedAt) : t.common.dash}
                    </td>
                    <td className="tnum g3-sub" data-label={t.jobs.thDuration}>{durationLabel(j.durationMs)}</td>
                    <td className="g3-cell-status" data-label={t.jobs.thStatus}>
                      <JobStatusLamp status={j.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="g3-sub tnum">{t.jobs.readOnly}</p>
          </>
        )}
      </Section>
    </div>
  );
}
