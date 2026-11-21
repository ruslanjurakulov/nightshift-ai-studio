import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { toQueueJob } from "@/lib/runBackend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_EVENTS = 300;
/** Events recorded a little after the job's row closed still belong to it (the uploader writes, then the worker finishes). */
const TAIL_MS = 2 * 60 * 1000;

/**
 * GET: one channel video run (a render_jobs row, the queue backend's "Run now") as the Studio's live view reads it
 * (lib/studio/liveGraph.ts runGraph). Read-only, with the person's own session: RLS gives only their channels' rows, and another
 * workspace's run reads exactly like a missing one.
 *
 * The pipeline's events (system_events) carry no run id. What this returns is the channel's events recorded between the job's start
 * and its end (or now), and the view says so in those words. One render runs at a time per channel, so these are this run's. The
 * failure is the job's closed error code only (the operator text and log tail stay the operator's, as on the events route).
 * Nothing here starts, retries or spends anything.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "session_expired" }, { status: 401, headers: NO_STORE });
  const { id } = await params;
  if (!/^[1-9][0-9]{0,15}$/.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_available" }, { status: 503, headers: NO_STORE });

  const jr = await supabase
    .from("render_jobs")
    .select("id,kind,status,attempts,channel_id,created_at,started_at,heartbeat_at,finished_at,error")
    .eq("id", Number(id))
    .maybeSingle();
  if (jr.error) return NextResponse.json({ error: "failed" }, { status: 502, headers: NO_STORE });
  if (!jr.data) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const row = jr.data as Record<string, unknown>;
  const job = toQueueJob(row);
  const channelId = typeof row.channel_id === "string" ? row.channel_id : null;

  // Before it started there is nothing of this run to read; null events is "not readable", [] is "none recorded yet".
  let events: unknown[] | null = [];
  const from = job.started_at ?? null;
  if (from && channelId) {
    const until = job.finished_at ? new Date(Date.parse(job.finished_at) + TAIL_MS).toISOString() : null;
    events = null;
    // privacy is the one metadata key the view needs; a read that cannot take it still gives the stages.
    for (const columns of ["ts,event,status,agent,privacy:metadata->>privacy", "ts,event,status,agent"]) {
      let q = supabase.from("system_events").select(columns).eq("channel_id", channelId).gte("ts", from);
      if (until) q = q.lte("ts", until);
      const er = await q.order("ts", { ascending: true }).limit(MAX_EVENTS);
      if (!er.error && Array.isArray(er.data)) {
        events = er.data;
        break;
      }
    }
  }

  return NextResponse.json(
    {
      job: { id: job.id, status: job.status, startedAt: job.started_at, finishedAt: job.finished_at, error: job.errorCode },
      events,
    },
    { headers: NO_STORE },
  );
}
