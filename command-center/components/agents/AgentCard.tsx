"use client";

import { StatusLamp } from "@/components/ui/StatusLamp";
import { relativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";

export interface AgentSummary {
  agent: string;
  /** Display status derived from the newest event's statusTone. */
  status: "RUNNING" | "IDLE" | "FAILED";
  tone: "run" | "ok" | "fail" | "idle";
  currentTask: string;
  lastActivity: string | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  durationMs: number | null;
  eventCount: number;
}

function durationLabel(ms: number | null): string {
  if (ms === null || ms === undefined) return "N/A";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One agent's derived state. All fields come from the `system_events` stream —
 * there is no agents table, so status/task/timestamps are read off the agent's
 * most recent events. Missing signals render N/A rather than being invented.
 */
export function AgentCard({ agent }: { agent: AgentSummary }) {
  const { t } = useI18n();
  const accent =
    agent.tone === "run"
      ? "var(--color-primary)"
      : agent.tone === "fail"
        ? "var(--color-fail)"
        : agent.tone === "ok"
          ? "var(--color-ok)"
          : "var(--color-idle)";

  const statusLabel =
    agent.status === "RUNNING" ? t.status.running : agent.status === "FAILED" ? t.status.failed : t.status.idle;

  return (
    <div className="panel flex flex-col gap-3 p-4 transition-transform duration-200 hover:-translate-y-0.5 hover:border-[var(--color-primary-dim)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="mono truncate text-sm font-bold text-[var(--color-primary)]">
            {agent.agent}
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            {fmt(t.agents.recentEvents, { n: agent.eventCount })}
          </div>
        </div>
        <StatusLamp tone={agent.tone} label={statusLabel} live={agent.status === "RUNNING"} />
      </div>

      <div className="rounded-md border-l-2 px-3 py-2" style={{ borderColor: accent, background: "var(--color-panel-2)" }}>
        <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
          {t.agents.currentTask}
        </div>
        <div className="mono mt-0.5 truncate text-sm text-[var(--color-fg)]">{agent.currentTask}</div>
        <div className="mono mt-0.5 text-[11px] text-[var(--color-muted)]">
          {agent.durationMs !== null ? fmt(t.agents.took, { d: durationLabel(agent.durationMs) }) : ""}
          {agent.lastActivity ? relativeTime(agent.lastActivity) : t.common.na}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2">
        <div>
          <dt className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            {t.agents.lastSuccess}
          </dt>
          <dd className="mono mt-0.5 text-[11px]" style={{ color: agent.lastSuccess ? "var(--color-ok)" : "var(--color-muted)" }}>
            {agent.lastSuccess ? relativeTime(agent.lastSuccess) : t.common.na}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
            {t.agents.lastFailure}
          </dt>
          <dd className="mono mt-0.5 text-[11px]" style={{ color: agent.lastFailure ? "var(--color-fail)" : "var(--color-muted)" }}>
            {agent.lastFailure ? relativeTime(agent.lastFailure) : t.common.na}
          </dd>
        </div>
      </dl>
    </div>
  );
}
