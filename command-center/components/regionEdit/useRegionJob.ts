"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isFinalPhase, toRunView, type RunView } from "@/lib/regionEdit/run";

export type RegionJobState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; view: RunView; stale: boolean }
  | { status: "error"; code: string };

const POLL_MS = 2500;
const SLOW_POLL_MS = 6000;

/**
 * One region edit's progress, read from /api/creative/jobs/[id] (RLS: the organization's own jobs) until it is final. The
 * page can be refreshed mid-job: the job id is the only thing needed to find it again. A failed read keeps the last view, marks it
 * `stale` (the screen then says the status could not be read, it does not pretend to know) and goes on trying more slowly.
 * Nothing is written here.
 */
export function useRegionJob(jobId: string | null): RegionJobState {
  const [state, setState] = useState<RegionJobState>({ status: "idle" });
  const last = useRef<RunView | null>(null);

  const read = useCallback(async (id: string, signal: AbortSignal): Promise<RunView | "gone" | "failed"> => {
    try {
      const res = await fetch(`/api/creative/jobs/${encodeURIComponent(id)}`, { cache: "no-store", signal });
      if (res.status === 404) return "gone";
      if (!res.ok) return "failed";
      const body = (await res.json().catch(() => null)) as { job?: unknown } | null;
      const view = toRunView(body?.job);
      return view ?? "failed";
    } catch {
      return "failed";
    }
  }, []);

  useEffect(() => {
    if (!jobId) {
      last.current = null;
      setState({ status: "idle" });
      return;
    }
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    last.current = null;
    setState({ status: "loading" });
    const tick = async () => {
      const got = await read(jobId, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (got === "gone") return setState({ status: "error", code: "not_found" });
      if (got === "failed") {
        failures += 1;
        if (last.current) setState({ status: "ready", view: last.current, stale: true });
        else if (failures >= 3) setState({ status: "error", code: "failed" });
        timer = setTimeout(tick, failures >= 3 ? SLOW_POLL_MS : POLL_MS);
        return;
      }
      failures = 0;
      last.current = got;
      setState({ status: "ready", view: got, stale: false });
      if (!isFinalPhase(got.phase)) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [jobId, read]);

  return state;
}
