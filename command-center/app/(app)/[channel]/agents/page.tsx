import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, EmptyState, StatCard } from "@/components/ui";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { statusTone } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { getChannelContext } from "@/lib/channels-server";
import { isScoped, scopeQuery } from "@/lib/channels";
import type { SystemEventRow } from "@/lib/types";
import { AgentCard, type AgentSummary } from "@/components/agents/AgentCard";
import { ScheduleEditor } from "@/components/agents/ScheduleEditor";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function deriveAgents(events: SystemEventRow[]): AgentSummary[] {
  // Events arrive newest-first. Bucket them per agent, preserving that order.
  const byAgent = new Map<string, SystemEventRow[]>();
  for (const e of events) {
    if (!e.agent) continue;
    const list = byAgent.get(e.agent);
    if (list) list.push(e);
    else byAgent.set(e.agent, [e]);
  }

  const summaries: AgentSummary[] = [];
  for (const [agent, rows] of byAgent) {
    const latest = rows[0];
    const tone = statusTone(latest.status);
    const status: AgentSummary["status"] =
      tone === "run" ? "RUNNING" : tone === "fail" ? "FAILED" : "IDLE";
    // A completed newest event = healthy-but-idle (green); a truly unknown
    // status stays grey idle.
    const displayTone: AgentSummary["tone"] =
      tone === "run" ? "run" : tone === "fail" ? "fail" : tone === "ok" ? "ok" : "idle";

    const lastSuccess = rows.find((r) => statusTone(r.status) === "ok")?.ts ?? null;
    const lastFailure = rows.find((r) => statusTone(r.status) === "fail")?.ts ?? null;

    summaries.push({
      agent,
      status,
      tone: displayTone,
      currentTask: latest.event,
      lastActivity: latest.ts,
      lastSuccess,
      lastFailure,
      durationMs: latest.duration_ms,
      eventCount: rows.length,
    });
  }

  // Running first, then failed, then the rest by most recent activity.
  const rank = { RUNNING: 0, FAILED: 1, IDLE: 2 } as const;
  return summaries.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return new Date(b.lastActivity ?? 0).getTime() - new Date(a.lastActivity ?? 0).getTime();
  });
}

export default async function AgentsPage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const { t } = await getDictionary();
  // Scope channel-owned queries to the selected channel (view control;
  // RLS still decides what may be read at all).
  const { selection, channels } = await getChannelContext();
  // The schedule editor writes to one channel; "All channels" has no single
  // target, so it renders disabled with a hint rather than guessing.
  const scopedChannel = isScoped(selection)
    ? channels.find((c) => c.channel_id === selection)
    : undefined;

  const supabase = await createClient();
  let events: SystemEventRow[] = [];
  let dbError = false;

  if (supabase) {
    const ev = await scopeQuery(
        supabase.from("system_events").select("*"),
        selection, { nullIsGlobal: true },
      )
      .order("ts", { ascending: false })
      .limit(500);
    if (ev.error) dbError = true;
    events = (ev.data as SystemEventRow[]) ?? [];
  }

  const agents = deriveAgents(events);
  const running = agents.filter((a) => a.status === "RUNNING").length;
  const failed = agents.filter((a) => a.status === "FAILED").length;

  return (
    <div className="rhythm stagger-enter">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="t-hero">{t.agents.title}</h1>
          <p className="t-lead mt-4">{t.agents.subtitle}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t.agents.seen} value={<AnimatedNumber value={agents.length} />} sub={t.agents.seenSub} />
        <StatCard label={t.agents.running} value={<AnimatedNumber value={running} />} tone={running ? "run" : "idle"} sub={running ? t.agents.activeNow : t.agents.noneActive} />
        <StatCard label={t.agents.failed} value={<AnimatedNumber value={failed} />} tone={failed ? "fail" : "ok"} sub={failed ? t.agents.latestFailed : t.agents.noneFailing} />
        <StatCard label={t.agents.scanned} value={<AnimatedNumber value={events.length} />} sub={t.agents.scannedSub} />
      </div>

      <ScheduleEditor
        channelId={scopedChannel?.channel_id ?? null}
        schedule={scopedChannel?.schedule_config ?? null}
      />

      <Panel title={t.agents.roster}>
        {dbError ? (
          <EmptyState>{t.agents.dbErr}</EmptyState>
        ) : agents.length === 0 ? (
          <EmptyState>{t.agents.empty}</EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((a) => (
              <AgentCard key={a.agent} agent={a} />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
