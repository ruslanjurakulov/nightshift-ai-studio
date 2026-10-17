"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ownerClock } from "@/lib/owner-time";
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
  const { t, locale } = useI18n();
  const router = useRouter();
  const w = t.workers;
  // The ages are as of the server's clock; ask the server again every minute while the tab is visible, and the moment it
  // becomes visible again (a phone coming back from the background), so they do not keep saying "12 seconds ago".
  useEffect(() => {
    const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
    const id = setInterval(() => {
      if (visible()) router.refresh();
    }, 60_000);
    const onVisible = () => {
      if (visible()) router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);
  const views = sortWorkers(rows.map((r) => workerView(r, nowMs)));

  return (
    <section className="g2-section" aria-labelledby="workers-title">
      <h2 id="workers-title" className="g2-h2">{w.title}</h2>
      {read === "failed" ? (
        <ErrorState compact />
      ) : read === "missing" ? (
        <p className="g2-none">{w.notEnabled}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="g2-note">{w.subtitle}</p>
          <p className="g2-note tnum" data-as-of="">{fmt(t.ownerTruth.asOf, { t: ownerClock(nowMs) })}</p>
          {views.length === 0 ? (
            <p className="g2-none">{w.empty}</p>
          ) : (
            <ul className="g2-rows">
              {views.map((v) => (
                <li
                  key={v.workerId}
                  data-worker-kind={v.kind}
                  data-worker-state={v.shown}
                  className="g2-worker"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                    <span className="flex min-w-0 flex-col">
                      <span className="g2-strong">{w.kinds[v.kind]}</span>
                      <span className="mono truncate text-[13px] text-[var(--color-muted)]">{v.workerId}</span>
                    </span>
                    <StatusLamp tone={TONE[v.shown]} label={w.states[v.shown]} live={v.shown === "running"} />
                  </div>
                  <div className="g2-evidence tnum" style={{ marginTop: 0 }}>
                    <span>{v.updatedAt && v.ageSeconds !== null ? fmt(w.heartbeat, { t: relativeTime(v.updatedAt, locale, nowMs) }) : w.noHeartbeat}</span>
                    {v.version && <span>{fmt(w.version, { v: v.version })}</span>}
                  </div>
                  {v.detail && (
                    <p className="m-0 break-words text-[0.9375rem] leading-relaxed text-[var(--color-fg)]">
                      <span className="text-[var(--color-muted)]">{w.reason}: </span>
                      {v.detail}
                    </p>
                  )}
                  {v.shown === "notReporting" && <p className="g2-warn m-0">{w.hint}</p>}
                </li>
              ))}
            </ul>
          )}
          <p className="g2-note">{w.note}</p>
        </div>
      )}
    </section>
  );
}
