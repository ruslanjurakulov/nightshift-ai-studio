"use client";

import { LiveLamp } from "@/components/motion/LiveLamp";
import { useI18n } from "@/lib/i18n/context";

export type JobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

const MAP: Record<JobStatus, "run" | "ok" | "fail" | "idle"> = {
  QUEUED: "idle",
  RUNNING: "run",
  COMPLETED: "ok",
  FAILED: "fail",
};

/**
 * A status lamp for a derived job, mapping the job status to a UI tone. Live:
 * when a job's state changes while the list is open, its lamp strikes once
 * (components/motion/LiveLamp); at rest it is StatusLamp exactly.
 */
export function JobStatusLamp({ status }: { status: JobStatus }) {
  const { t } = useI18n();
  const label: Record<JobStatus, string> = {
    QUEUED: t.status.queued,
    RUNNING: t.status.running,
    COMPLETED: t.status.completed,
    FAILED: t.status.failed,
  };
  return <LiveLamp tone={MAP[status]} label={label[status]} live={status === "RUNNING"} />;
}
