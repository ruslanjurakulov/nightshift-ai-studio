"use client";

import { relativeTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n/context";
import { EmptyState, Panel } from "@/components/ui";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { DataList } from "@/components/g4/DataList";
import type { ContentQueueRow, PipelineRunRow } from "@/lib/types";

const STATUS_LAMP: Record<string, LampTone> = {
  queued: "run",
  published: "ok",
  skipped: "idle",
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
  const { t, locale } = useI18n();

  return (
    <div className="g4-cols">
      <Panel title={t.auto.queueTitle}>
        {tablesMissing ? (
          <EmptyState>{t.auto.schemaMissing}</EmptyState>
        ) : queue.length === 0 ? (
          <EmptyState>{t.auto.noQueue}</EmptyState>
        ) : (
          <DataList
            caption={t.auto.queueTitle}
            rows={queue}
            rowKey={(q) => q.entry_id}
            columns={[
              {
                key: "topic",
                label: t.auto.qTopic,
                render: (q) => (
                  <>
                    <div>{q.topic}</div>
                    {q.rationale && <div className="tnum g4-small g4-muted">{q.rationale}</div>}
                  </>
                ),
              },
              { key: "status", label: t.auto.qStatus, render: (q) => <StatusLamp tone={STATUS_LAMP[q.status] ?? "idle"} label={q.status} /> },
              { key: "source", label: t.auto.qSource, render: (q) => <span className="tnum g4-muted">{q.source ?? t.common.dash}</span> },
              { key: "added", label: t.auto.qAdded, nowrap: true, render: (q) => <span className="tnum g4-muted">{relativeTime(q.added_at, locale)}</span> },
            ]}
          />
        )}
        <p className="g4-note tnum mt-4">{t.auto.opsNote}</p>
      </Panel>

      <Panel title={t.auto.runsTitle}>
        {tablesMissing ? (
          <EmptyState>{t.auto.schemaMissing}</EmptyState>
        ) : runs.length === 0 ? (
          <EmptyState>{t.auto.noRuns}</EmptyState>
        ) : (
          <DataList
            caption={t.auto.runsTitle}
            rows={runs}
            rowKey={(r) => r.run_id}
            columns={[
              {
                key: "run",
                label: t.auto.rRun,
                render: (r) => (
                  <>
                    <div>{r.topic}</div>
                    <div className="mono g4-small g4-muted">{r.run_id}</div>
                  </>
                ),
              },
              { key: "stage", label: t.auto.rStage, render: (r) => <span className="tnum" style={{ color: "var(--ns-act-ink)" }}>{r.current_stage}</span> },
              {
                key: "approved",
                label: t.auto.rApproved,
                render: (r) => (
                  <>
                    <StatusLamp tone={r.human_approved ? "ok" : "idle"} label={r.human_approved ? t.auto.rApprovedYes : t.auto.rApprovedNo} />
                    {r.approved_by && <span className="g4-muted g4-small">({r.approved_by})</span>}
                  </>
                ),
              },
              { key: "updated", label: t.auto.rUpdated, nowrap: true, render: (r) => <span className="tnum g4-muted">{r.updated_at ? relativeTime(r.updated_at, locale) : t.common.dash}</span> },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}
