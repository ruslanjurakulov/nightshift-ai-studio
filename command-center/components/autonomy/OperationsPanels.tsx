"use client";

import { relativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { EmptyState, Panel } from "@/components/ui";
import type { ContentQueueRow, PipelineRunRow } from "@/lib/types";

const STATUS_COLOR: Record<string, string> = {
  queued: "var(--color-primary)",
  published: "var(--color-ok)",
  skipped: "var(--color-muted)",
};

/**
 * The bot's own operational state, mirrored into Supabase by the intelligence
 * poll: ContentPlanner's queue and PipelineStateMachine's runs. Read-only —
 * nothing here writes back, and `human_approved` is shown as the audit-trail
 * flag it is, not as a publishing gate.
 */
export function OperationsPanels({
  queue,
  runs,
  tablesMissing,
}: {
  queue: ContentQueueRow[];
  runs: PipelineRunRow[];
  tablesMissing: boolean;
}) {
  const { t } = useI18n();

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title={t.auto.queueTitle}>
        {tablesMissing ? (
          <EmptyState>{t.auto.schemaMissing}</EmptyState>
        ) : queue.length === 0 ? (
          <EmptyState>{t.auto.noQueue}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                  <th className="px-4 py-2 font-semibold">{t.auto.qTopic}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.qStatus}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.qSource}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.qAdded}</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((q) => (
                  <tr key={q.entry_id} className="border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-panel-2)]">
                    <td className="px-4 py-2 text-[var(--color-fg)]">
                      <div className="truncate">{q.topic}</div>
                      {q.rationale && (
                        <div className="mono truncate text-[10px] text-[var(--color-muted)]">{q.rationale}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.22em]" style={{ color: STATUS_COLOR[q.status] ?? "var(--color-muted)" }}>
                      {q.status}
                    </td>
                    <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">{q.source ?? t.common.dash}</td>
                    <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">{relativeTime(q.added_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-[var(--color-border)] px-4 py-2 mono text-[10px] leading-relaxed text-[var(--color-muted)]">
          {t.auto.opsNote}
        </p>
      </Panel>

      <Panel title={t.auto.runsTitle}>
        {tablesMissing ? (
          <EmptyState>{t.auto.schemaMissing}</EmptyState>
        ) : runs.length === 0 ? (
          <EmptyState>{t.auto.noRuns}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                  <th className="px-4 py-2 font-semibold">{t.auto.rRun}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.rStage}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.rApproved}</th>
                  <th className="px-4 py-2 font-semibold">{t.auto.rUpdated}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.run_id} className="border-b border-[var(--color-border)]/50 transition-colors hover:bg-[var(--color-panel-2)]">
                    <td className="px-4 py-2">
                      <div className="truncate text-[var(--color-fg)]">{r.topic}</div>
                      <div className="mono truncate text-[10px] text-[var(--color-muted)]">{r.run_id}</div>
                    </td>
                    <td className="px-4 py-2 mono text-[11px] text-[var(--color-primary)]">{r.current_stage}</td>
                    <td className="px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.22em]" style={{ color: r.human_approved ? "var(--color-ok)" : "var(--color-muted)" }}>
                      {r.human_approved ? t.auto.rApprovedYes : t.auto.rApprovedNo}
                      {r.approved_by && <span className="ml-1 normal-case text-[var(--color-muted)]">({r.approved_by})</span>}
                    </td>
                    <td className="px-4 py-2 mono text-[11px] text-[var(--color-muted)]">
                      {r.updated_at ? relativeTime(r.updated_at) : t.common.dash}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
