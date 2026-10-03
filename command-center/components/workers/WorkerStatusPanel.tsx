"use client";

import { Panel } from "@/components/ui";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { ErrorState } from "@/components/ReadError";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { relativeTime } from "@/lib/format";
import { sortWorkers, workerView, type WorkerRow, type WorkerShown } from "@/lib/workers";

const TONE: Record<WorkerShown, "ok" | "run" | "fail" | "warn" | "idle"> = {
  starting: "run",
  running: "ok",
  failed: "fail",
  stopped: "idle",
  // Silence is never "ok": it is a warning.
  notReporting: "warn",
};

/**
 * What each background worker says about itself (migration 0045), for the
 * operator: kind, state, the age of its last heartbeat, and the detail it
 * reported (for a failure, the remedy). A failed read is the error state with
 * Retry, never an empty list or "healthy"; a heartbeat older than two minutes
 * reads "Not reporting", never "Running".
 *
 * `read`: "ok" rows were read; "missing" the table does not exist yet
 * (migration 0045 not applied); "failed" the read failed. `nowMs` is the
 * server's clock, so the ages match what the page was rendered with.
 */
export function WorkerStatusPanel({
  read,
  rows,
  nowMs,
}: {
  read: "ok" | "missing" | "failed";
  rows: WorkerRow[];
  nowMs: number;
}) {
  const { t } = useI18n();
  const w = t.workers;
  const views = sortWorkers(rows.map((r) => workerView(r, nowMs)));

  return (
    <Panel title={w.title}>
      {read === "failed" ? (
        <ErrorState compact />
      ) : read === "missing" ? (
        <p className="m-0 p-4 text-sm text-[var(--color-muted)]">{w.notEnabled}</p>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <p className="m-0 text-xs leading-relaxed text-[var(--color-muted)]">{w.subtitle}</p>
          {views.length === 0 ? (
            <p className="m-0 text-sm text-[var(--color-muted)]">{w.empty}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {views.map((v) => (
                <li
                  key={v.workerId}
                  data-worker-kind={v.kind}
                  data-worker-state={v.shown}
                  className="flex flex-col gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-semibold text-[var(--color-fg)]">{w.kinds[v.kind]}</span>
                      <span className="mono truncate text-xs text-[var(--color-muted)]">{v.workerId}</span>
                    </span>
                    <StatusLamp tone={TONE[v.shown]} label={w.states[v.shown]} live={v.shown === "running"} />
                  </div>
                  <div className="tnum flex flex-wrap gap-x-4 text-xs text-[var(--color-muted)]">
                    <span>{v.updatedAt && v.ageSeconds !== null ? fmt(w.heartbeat, { t: relativeTime(v.updatedAt) }) : w.noHeartbeat}</span>
                    {v.version && <span>{fmt(w.version, { v: v.version })}</span>}
                  </div>
                  {v.detail && (
                    <p className="m-0 break-words text-xs leading-relaxed text-[var(--color-fg)]">
                      <span className="text-[var(--color-muted)]">{w.reason}: </span>
                      {v.detail}
                    </p>
                  )}
                  {v.shown === "notReporting" && (
                    <p className="m-0 text-xs leading-relaxed text-[var(--color-warn)]">{w.hint}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 text-xs text-[var(--color-muted)]">{w.note}</p>
        </div>
      )}
    </Panel>
  );
}
