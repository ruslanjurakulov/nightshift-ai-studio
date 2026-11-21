import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createClient } from "@/lib/supabase/server";
import { getChannelScope } from "@/lib/channels-server";
import { isScoped, scopeQuery } from "@/lib/channels";
import type { SystemEventRow } from "@/lib/types";
import { isOperator } from "@/lib/auth/org-roles";
import { forCustomer, resolveRunBackend, toQueueJob, withCreditsReturned, type QueueJob } from "@/lib/runBackend";

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

  const scope = await getChannelScope();
  const { selection } = scope;
  const res = await scopeQuery(
    supabase.from("system_events").select("ts,agent,event,status,video_id"),
    scope,
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
    if (!jr.error && Array.isArray(jr.data)) {
      jobs = jr.data.map((r) => toQueueJob(r as Record<string, unknown>));
      jobs = await markCreditsReturned(supabase, jobs);
      // The log tail names vendors and operator remedies: it is the operator's. A customer gets the code (a plain
      // sentence on the page) and whether their credits came back.
      if (!(await isOperator())) jobs = jobs.map(forCustomer);
    }
  }
  return NextResponse.json({ events: rows, backend, jobs });
}

/**
 * Best effort, read with the caller's own session: which FAILED jobs had their hold released. Any read that fails
 * leaves the jobs as they were (creditsReturned null = not known), never a guess.
 */
async function markCreditsReturned(
  supabase: NonNullable<Awaited<ReturnType<typeof createClient>>>,
  jobs: QueueJob[],
): Promise<QueueJob[]> {
  const failed = jobs.filter((j) => j.status === "failed").map((j) => j.id);
  if (failed.length === 0) return jobs;
  try {
    const refs = await supabase.from("render_jobs").select("id,credit_ref").in("id", failed);
    if (refs.error || !Array.isArray(refs.data)) return jobs;
    const held = (refs.data as { id: number; credit_ref: string | null }[]).filter((r) => r.credit_ref);
    if (held.length === 0) return jobs;
    const res = await supabase
      .from("credit_reservations")
      .select("job_id,status")
      .in("job_id", held.map((r) => r.credit_ref as string));
    if (res.error || !Array.isArray(res.data)) return jobs;
    return withCreditsReturned(jobs, held, res.data as { job_id: string; status: string }[]);
  } catch {
    return jobs;
  }
}
