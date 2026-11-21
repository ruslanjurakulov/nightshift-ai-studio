import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { dispatchedRunStatus } from "@/lib/server/github-runs";
import { RUN_STATUS_RATE, takeWebRate } from "@/lib/server/web-rate";
import { readRunHold } from "@/lib/server/run-hold";
import { readRunVideo } from "@/lib/server/run-video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_EVENTS = 300;
/** A dispatch older than this is not a run the live view follows (the workflow stops long before). */
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** How far after the dispatch a run's events are read: past the workflow's own time limit, with room for a queued runner. */
const SPAN_MS = 3 * 60 * 60 * 1000;
/** channels.channel_id is a slug (0001, render_jobs_channel_id_check), not a uuid. */
const CHANNEL = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * GET ?channel=<uuid>&since=<ISO>: one channel video run on the GitHub Actions backend, for the Studio's live view. That backend gives
 * no run id back and the pipeline's events carry none, so the run is this channel's events recorded from the moment it was dispatched
 * (/api/agent/run answers `dispatched_at`). The view says so in those words. Read-only, with the person's own session (RLS:
 * only their channels; another workspace's channel reads as no events at all). It reads only the stage words and the upload's
 * privacy, never the rest of an event's metadata. Nothing here starts, retries or spends anything.
 *
 * The pipeline's events reach Supabase when they are synced, so stages can lag the run. Two facts are live and answer next to them:
 * - `workflow`: GitHub's own status of this channel's dispatched job, asked server-side with the app's token (never sent to the
 *   browser, nor any URL, id or log of GitHub's), and only for a channel this person can see through RLS;
 * - `hold`: the credit hold (`&hold=<credit_ref>`, as /api/agent/run answered it), read through RLS like the rest.
 * Either is null when it is not known.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "session_expired" }, { status: 401, headers: NO_STORE });
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel") ?? "";
  const sinceRaw = url.searchParams.get("since") ?? "";
  const sinceMs = Date.parse(sinceRaw);
  const nowMs = Date.now();
  if (!CHANNEL.test(channel) || !Number.isFinite(sinceMs) || sinceMs > nowMs + 60_000 || nowMs - sinceMs > MAX_AGE_MS) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_available" }, { status: 503, headers: NO_STORE });

  const since = new Date(sinceMs).toISOString();
  const until = new Date(sinceMs + SPAN_MS).toISOString();
  let events: unknown[] | null = null;
  for (const columns of ["ts,event,status,agent,privacy:metadata->>privacy", "ts,event,status,agent"]) {
    const er = await supabase
      .from("system_events")
      .select(columns)
      .eq("channel_id", channel)
      .gte("ts", since)
      .lte("ts", until)
      .order("ts", { ascending: true })
      .limit(MAX_EVENTS);
    if (!er.error && Array.isArray(er.data)) {
      events = er.data;
      break;
    }
  }
  // GitHub is asked with the app's token: only for a channel RLS shows this person, so another workspace's channel id learns nothing.
  const visible = await supabase.from("channels").select("channel_id").eq("channel_id", channel).maybeSingle();
  const workflow =
    !visible.error && visible.data
      ? await dispatchedRunStatus(channel, sinceMs, async () => (await takeWebRate(user.id, RUN_STATUS_RATE)) === "ok")
      : null;
  const hold = await readRunHold(supabase, url.searchParams.get("hold"));
  const video = await readRunVideo(supabase, channel, since, until);
  return NextResponse.json({ job: null, window: { since, now: new Date(nowMs).toISOString() }, events, workflow, hold, video }, { headers: NO_STORE });
}
