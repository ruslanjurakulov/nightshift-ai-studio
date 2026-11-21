import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The video a channel run made, as the person may read it (RLS on `videos`, 0018 videos_auth_read). The Studio's live view links
 * its end step to that video's page, where the existing "Publish to platforms" panel lives; nothing here sends or publishes.
 *
 * Only the run's own long video counts (Lens): never its Short (main.py _publish_short: video_format 'short', parent_video_id
 * set, uploaded later), a repurpose clip (0080: held 'short' rows with a parent) or a repaired cut of another video
 * (publish_state 'repaired_awaiting_review', re-held "now" by held_video.record_held).
 * - Every run: a long video of the channel held or uploaded inside the run's window.
 * - Queue runs also name their video: render_jobs.result_slug (0189), so a second video of the channel in the window is not it.
 *
 * Null when no such row is readable yet (a run that uploaded on its first try gets its row with the nightly mirror). The view says
 * "the video's page appears after sync"; it never guesses an id.
 */
export type RunVideo = { id: string; state: "held" | "uploaded" };

const ROW = "video_id,publish_state,held_at,published_at";

type Q = {
  eq(k: string, v: unknown): Q;
  is(k: string, v: null): Q;
  or(f: string): Q;
  gte(k: string, v: string): Q;
  lte(k: string, v: string): Q;
  order(k: string, o: { ascending: boolean }): Q;
  limit(n: number): PromiseLike<{ data: unknown; error: unknown }>;
};

function longVideosOf(supabase: SupabaseClient, channelId: string): Q {
  return (supabase.from("videos").select(ROW) as unknown as Q)
    .eq("channel_id", channelId)
    .eq("video_format", "long")
    .is("parent_video_id", null)
    // A constant filter: a repaired cut of an older video is re-held "now" and must never answer for this run.
    .or("publish_state.is.null,publish_state.neq.repaired_awaiting_review");
}

function pick(rows: Record<string, unknown>[], col: "held_at" | "published_at"): { id: string; at: number; state: RunVideo["state"] }[] {
  const out: { id: string; at: number; state: RunVideo["state"] }[] = [];
  for (const raw of rows) {
    const id = typeof raw.video_id === "string" && raw.video_id.length > 0 && raw.video_id.length <= 128 ? raw.video_id : null;
    const at = Date.parse(String(raw[col] ?? ""));
    if (!id || !Number.isFinite(at)) continue;
    out.push({ id, at, state: typeof raw.published_at === "string" && raw.published_at.length > 0 ? "uploaded" : "held" });
  }
  return out;
}

export async function readRunVideo(
  supabase: SupabaseClient,
  channelId: string,
  fromIso: string,
  untilIso: string,
  slug: string | null = null,
): Promise<RunVideo | null> {
  const found: { id: string; at: number; state: RunVideo["state"] }[] = [];
  for (const col of ["held_at", "published_at"] as const) {
    let q = longVideosOf(supabase, channelId);
    // The run's window always (two plain reads, not a built or() of times), and the job's own slug when it has one: a slug is per
    // channel and topic, so a later run of the same topic reuses it, and only the window tells this run's row from that one (Lens).
    q = q.gte(col, fromIso).lte(col, untilIso);
    if (slug) q = q.eq("slug", slug);
    const r = await q.order(col, { ascending: false }).limit(3);
    if (r.error || !Array.isArray(r.data)) continue;
    found.push(...pick(r.data as Record<string, unknown>[], col));
  }
  // An uploaded row before a held one (the same run re-keyed on upload, 0189 render_job_video_id), then the newest.
  found.sort((a, b) => (a.state === b.state ? b.at - a.at : a.state === "uploaded" ? -1 : 1));
  return found[0] ? { id: found[0].id, state: found[0].state } : null;
}
