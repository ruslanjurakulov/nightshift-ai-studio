import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The video a channel run made, as the person may read it (RLS on `videos`): the newest row of the channel that was held
 * (held_video.py writes it the moment a run is held) or uploaded inside the run's window. The Studio's live view links its end
 * step to that video's page, where the existing "Publish to platforms" panel lives; nothing here sends or publishes.
 *
 * Null when no such row is readable yet: a run that uploaded on its first try gets its row with the nightly mirror. The view says
 * "the video's page appears after sync"; it never guesses an id.
 */
export type RunVideo = { id: string; state: "held" | "uploaded" };

const ROW = "video_id,publish_state,held_at,published_at";

export async function readRunVideo(supabase: SupabaseClient, channelId: string, fromIso: string, untilIso: string): Promise<RunVideo | null> {
  const found: { id: string; at: number; state: RunVideo["state"] }[] = [];
  // Two plain reads, not an or() filter: the bounds are ours, but a string built into a filter is a habit not to start.
  for (const col of ["held_at", "published_at"] as const) {
    const r = await supabase.from("videos").select(ROW).eq("channel_id", channelId).gte(col, fromIso).lte(col, untilIso).order(col, { ascending: false }).limit(3);
    if (r.error || !Array.isArray(r.data)) continue;
    for (const raw of r.data as Record<string, unknown>[]) {
      const id = typeof raw.video_id === "string" && raw.video_id.length > 0 && raw.video_id.length <= 128 ? raw.video_id : null;
      const at = Date.parse(String(raw[col] ?? ""));
      if (!id || !Number.isFinite(at)) continue;
      const uploaded = typeof raw.published_at === "string" && raw.published_at.length > 0;
      found.push({ id, at, state: uploaded ? "uploaded" : "held" });
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found[0] ? { id: found[0].id, state: found[0].state } : null;
}
