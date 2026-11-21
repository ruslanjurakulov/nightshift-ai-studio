import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_EVENTS = 300;
/** A dispatch older than this is not a run the live view follows (the workflow stops long before). */
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** How far after the dispatch a run's events are read: past the workflow's own time limit, with room for a queued runner. */
const SPAN_MS = 3 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * GET ?channel=<uuid>&since=<ISO>: one channel video run on the GitHub Actions backend, for the Studio's live view. That backend gives
 * no run id back and the pipeline's events carry none, so the run is this channel's events recorded from the moment it was dispatched
 * (/api/agent/run answers `dispatched_at`). The view says so in those words. Read-only, with the person's own session (RLS:
 * only their channels; another workspace's channel reads as no events at all). It reads only the stage words and the upload's
 * privacy, never the rest of an event's metadata. Nothing here starts, retries or spends anything.
 */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "session_expired" }, { status: 401, headers: NO_STORE });
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel") ?? "";
  const sinceRaw = url.searchParams.get("since") ?? "";
  const sinceMs = Date.parse(sinceRaw);
  const nowMs = Date.now();
  if (!UUID.test(channel) || !Number.isFinite(sinceMs) || sinceMs > nowMs + 60_000 || nowMs - sinceMs > MAX_AGE_MS) {
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
  return NextResponse.json({ job: null, window: { since, now: new Date(nowMs).toISOString() }, events }, { headers: NO_STORE });
}
