import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { Panel, EmptyState, StatCard } from "@/components/ui";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { statusTone } from "@/lib/format";
import { getDictionary } from "@/lib/i18n/server";
import { PageHeader } from "@/components/PageHeader";
import { getChannelContext } from "@/lib/channels-server";
import { isScoped, scopeQuery } from "@/lib/channels";
import { isRunNowConfigured } from "@/lib/server/run-backend";
import type { SystemEventRow } from "@/lib/types";
import { AgentCard, type AgentSummary } from "@/components/agents/AgentCard";
import { ScheduleEditor } from "@/components/agents/ScheduleEditor";
import { CastEditor } from "@/components/agents/CastEditor";
import { VoiceEditor } from "@/components/agents/VoiceEditor";
import { RunNowButton } from "@/components/agents/RunNowButton";
import { resolveCurrentOrgRole } from "@/lib/auth/org-roles";
import { atLeast } from "@/lib/auth/roles";

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
  const { selection, channels, scope } = await getChannelContext();
  // The schedule editor and "Run now" both act on one channel; "All channels"
  // has no single target, so they render disabled with a hint rather than
  // guessing or fanning out on one click.
  const scopedChannel = isScoped(selection)
    ? channels.find((c) => c.channel_id === selection)
    : undefined;

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

  // Run now is an owner/admin action in the channel's organization.
  const canRun = atLeast(await resolveCurrentOrgRole(), "admin");
  const agents = deriveAgents(events);
  const running = agents.filter((a) => a.status === "RUNNING").length;
  const failed = agents.filter((a) => a.status === "FAILED").length;

  return (
    <div className="rhythm stagger-enter">
      <PageHeader icon="agents" title={t.agents.title} subtitle={t.agents.subtitle} />

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

      <VoiceEditor
        channelId={scopedChannel?.channel_id ?? null}
        agentConfig={scopedChannel?.agent_config ?? null}
      />

      <CastEditor
        channelId={scopedChannel?.channel_id ?? null}
        agentConfig={scopedChannel?.agent_config ?? null}
      />

      <RunNowButton
        channelId={scopedChannel?.channel_id ?? null}
        githubConfigured={isRunNowConfigured}
        canRun={canRun}
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
