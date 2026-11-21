import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { toQueueJob } from "@/lib/runBackend";
import { readRunHold } from "@/lib/server/run-hold";
import { readRunVideo, type RunVideo } from "@/lib/server/run-video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_EVENTS = 300;
/** Events recorded a little after the job's row closed still belong to it (the uploader writes, then the worker finishes). */
const TAIL_MS = 2 * 60 * 1000;
/** No run is read for longer than this after it started (the workflow and the worker stop well before). */
const SPAN_MS = 3 * 60 * 60 * 1000;

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
  // 15 digits at most: a 16-digit number is no longer exact in Number(), and would read another id.
  if (!/^[1-9][0-9]{0,14}$/.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_available" }, { status: 503, headers: NO_STORE });

  const jr = await supabase
    .from("render_jobs")
    .select("id,kind,status,attempts,channel_id,created_at,started_at,heartbeat_at,finished_at,error")
    .eq("id", Number(id))
    .maybeSingle();
  // credit_ref is read apart: a database without 0020 must still show the run.
  const refRead = jr.data ? await supabase.from("render_jobs").select("credit_ref").eq("id", Number(id)).maybeSingle() : null;
  // The video the run made, by its own slug (0189 result_slug, written by the worker); a database without 0189 reads none.
  const slugRead = jr.data ? await supabase.from("render_jobs").select("result_slug").eq("id", Number(id)).maybeSingle() : null;
  const resultSlug =
    slugRead && !slugRead.error && typeof (slugRead.data as { result_slug?: unknown } | null)?.result_slug === "string"
      ? (slugRead.data as { result_slug: string }).result_slug
      : null;
  const creditRef = refRead && !refRead.error && typeof (refRead.data as { credit_ref?: unknown } | null)?.credit_ref === "string" ? ((refRead.data as { credit_ref: string }).credit_ref) : null;
  if (jr.error) return NextResponse.json({ error: "failed" }, { status: 502, headers: NO_STORE });
  if (!jr.data) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const row = jr.data as Record<string, unknown>;
  const job = toQueueJob(row);
  const channelId = typeof row.channel_id === "string" ? row.channel_id : null;

  // Before it started there is nothing of this run to read; null events is "not readable", [] is "none recorded yet".
  let events: unknown[] | null = [];
  let video: RunVideo | null = null;
  const from = job.started_at ?? null;
  if (from && channelId) {
    // A job stuck in "running" (a worker that died) would otherwise take every later event of the channel as its own.
    const cap = Date.parse(from) + SPAN_MS;
    const end = job.finished_at ? Math.min(Date.parse(job.finished_at) + TAIL_MS, cap) : cap;
    const until = new Date(end).toISOString();
    events = null;
    // privacy is the one metadata key the view needs; a read that cannot take it still gives the stages.
    for (const columns of ["ts,event,status,agent,privacy:metadata->>privacy", "ts,event,status,agent"]) {
      const er = await supabase
        .from("system_events")
        .select(columns)
        .eq("channel_id", channelId)
        .gte("ts", from)
        .lte("ts", until)
        .order("ts", { ascending: true })
        .limit(MAX_EVENTS);
      if (!er.error && Array.isArray(er.data)) {
        events = er.data;
        break;
      }
    }
    video = await readRunVideo(supabase, channelId, from, until, resultSlug);
  }

  return NextResponse.json(
    {
      job: { id: job.id, status: job.status, startedAt: job.started_at, finishedAt: job.finished_at, error: job.errorCode },
      events,
      // The read stops at MAX_EVENTS in time order: the newest of a very long run would be missing, and the Activity panel says so.
      events_cut: Array.isArray(events) && events.length >= MAX_EVENTS,
      hold: await readRunHold(supabase, creditRef),
      video,
    },
    { headers: NO_STORE },
  );
}
