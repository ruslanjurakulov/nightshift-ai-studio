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

  const statusLabel =
    agent.status === "RUNNING" ? t.status.running : agent.status === "FAILED" ? t.status.failed : t.status.idle;

  // A row of the roster: name and lamp, what it did last, when it last worked and last broke.
  return (
    <li>
      <div className="min-w-0">
        <div className="tnum truncate font-semibold" style={{ color: "var(--ns-act-ink)" }}>
          {agent.agent}
        </div>
        <div className="g4-small g4-muted">{fmt(t.agents.recentEvents, { n: agent.eventCount })}</div>
      </div>
      <StatusLamp tone={agent.tone} label={statusLabel} live={agent.status === "RUNNING"} />

      <div className="g4-agent-task">
        <div className="g4-small g4-muted">{t.agents.currentTask}</div>
        <div className="tnum truncate text-[var(--color-fg)]">{agent.currentTask}</div>
        <div className="tnum g4-small g4-muted">
          {agent.durationMs !== null ? fmt(t.agents.took, { d: durationLabel(agent.durationMs) }) : ""}
          {agent.lastActivity ? relativeTime(agent.lastActivity) : t.common.na}
        </div>
      </div>

      <dl className="g4-agent-facts">
        <div>
          <dt className="g4-small g4-muted">{t.agents.lastSuccess}</dt>
          <dd className="tnum m-0" style={{ color: agent.lastSuccess ? "var(--color-ok)" : "var(--color-muted)" }}>
            {agent.lastSuccess ? relativeTime(agent.lastSuccess) : t.common.na}
          </dd>
        </div>
        <div>
          <dt className="g4-small g4-muted">{t.agents.lastFailure}</dt>
          <dd className="tnum m-0" style={{ color: agent.lastFailure ? "var(--color-fail)" : "var(--color-muted)" }}>
            {agent.lastFailure ? relativeTime(agent.lastFailure) : t.common.na}
          </dd>
        </div>
      </dl>
    </li>
  );
}
