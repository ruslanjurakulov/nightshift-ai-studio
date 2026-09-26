import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createClient } from "@/lib/supabase/server";
import { getChannelSelection } from "@/lib/channels-server";
import { isScoped, scopeQuery } from "@/lib/channels";
import type { SystemEventRow } from "@/lib/types";
import { resolveRunBackend, toQueueJob, type QueueJob } from "@/lib/runBackend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recent pipeline events for the selected channel — the Create page polls this
 * after it dispatches a run, so the operator watches the run move through its
 * stages (research → script → audio → media → render → publish) instead of
 * guessing. Read-only, auth-gated; nothing here spends or publishes. It reads
 * exactly the system_events the Jobs and lifecycle views already read.
 *
 * In queue mode (NIGHTSHIFT_RUN_BACKEND=queue) it also returns the channel's
 * latest render_jobs rows, so the operator sees "queued → running → failed"
 * before the pipeline has emitted its first event — a job waiting for a worker
 * would otherwise look exactly like a run that never started. `jobs` is null
 * when there is no single channel or the table does not exist (0017 not
 * applied): unknown, not "no jobs".
 */
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ events: [] });

  const selection = await getChannelSelection();
  const res = await scopeQuery(
    supabase.from("system_events").select("ts,agent,event,status,video_id"),
    selection,
    { nullIsGlobal: true },
  )
    .order("ts", { ascending: false })
    .limit(40);

  const rows = (res.data as Pick<SystemEventRow, "ts" | "agent" | "event" | "status" | "video_id">[] | null) ?? [];

  const backend = resolveRunBackend({ NIGHTSHIFT_RUN_BACKEND: process.env.NIGHTSHIFT_RUN_BACKEND });
  let jobs: QueueJob[] | null = null;
  if (backend === "queue" && isScoped(selection)) {
    const jr = await supabase
      .from("render_jobs")
      .select("id,kind,status,attempts,created_at,started_at,heartbeat_at,finished_at,error")
      .eq("channel_id", selection)
      .order("created_at", { ascending: false })
      .limit(5);
    if (!jr.error && Array.isArray(jr.data)) jobs = jr.data.map((r) => toQueueJob(r as Record<string, unknown>));
  }
  return NextResponse.json({ events: rows, backend, jobs });
}
