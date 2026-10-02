"use client";

import { StatusLamp } from "@/components/ui/StatusLamp";
import { useI18n } from "@/lib/i18n/context";

export type JobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

const MAP: Record<JobStatus, "run" | "ok" | "fail" | "idle"> = {
  QUEUED: "idle",
  RUNNING: "run",
  COMPLETED: "ok",
  FAILED: "fail",
};

/** A status lamp for a derived job, mapping the job status to a UI tone. */
export function JobStatusLamp({ status }: { status: JobStatus }) {
  const { t } = useI18n();
  const label: Record<JobStatus, string> = {
    QUEUED: t.status.queued,
    RUNNING: t.status.running,
    COMPLETED: t.status.completed,
    FAILED: t.status.failed,
  };
  return <StatusLamp tone={MAP[status]} label={label[status]} live={status === "RUNNING"} />;
}
