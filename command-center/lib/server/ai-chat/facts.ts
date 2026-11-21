import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelFacts } from "@/lib/ai-chat/prompt";
import { plain } from "@/lib/ai-chat/logic";

/**
 * The channel's own facts for one turn, read AS THE PERSON (RLS: a viewer of the channel's workspace), so the model can only ever be
 * shown rows the person could open themselves. Three sources the pipeline already fills: the channel's recent videos with their latest
 * snapshot, competitors' fastest titles of the last two weeks, and what the audience asks for in comments (demand_signals, mined by
 * the worker; raw comments never reach the model).
 *
 * Rule 5: a source that fails to read makes the whole answer "unknown", never "none" — "no data" is a measurement, and a failed read
 * did not measure anything.
 */
export async function readChannelFacts(supabase: SupabaseClient, channelId: string, name: string): Promise<ChannelFacts> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const [vids, comp, asks] = await Promise.all([
    supabase.from("videos").select("video_id,title,published_at").eq("channel_id", channelId).not("title", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false }).limit(10),
    supabase.from("competitor_snapshots").select("title,view_velocity,polled_date").eq("chronos_channel_id", channelId)
      .gte("polled_date", since).order("view_velocity", { ascending: false, nullsFirst: false }).limit(20),
    supabase.from("demand_signals").select("topic_phrase,mention_count,polled_date").eq("channel_id", channelId)
      .order("polled_date", { ascending: false }).limit(30),
  ]);
  const base: ChannelFacts = { state: "unknown", name: plain(name, 80), ownRecent: [], competitorTop: [], audienceAsks: [] };
  if (vids.error || comp.error || asks.error) return base;

  const videos = (vids.data ?? []) as { video_id: string; title: string | null }[];
  let snaps: { video_id: string; views: number | null; average_view_duration_seconds: number | null; snapshot_date: string }[] = [];
  if (videos.length) {
    const m = await supabase.from("metrics_snapshots").select("video_id,views,average_view_duration_seconds,snapshot_date")
      .in("video_id", videos.map((v) => v.video_id)).order("snapshot_date", { ascending: false }).limit(200);
    if (m.error) return base;
    snaps = (m.data ?? []) as typeof snaps;
  }
  const latest = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) if (!latest.has(s.video_id)) latest.set(s.video_id, s);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

  const seen = new Set<string>();
  const competitorTop: ChannelFacts["competitorTop"] = [];
  for (const r of (comp.data ?? []) as { title: string | null; view_velocity: number | null }[]) {
    const title = plain(r.title, 120);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    competitorTop.push({ title, viewsPerDay: n(r.view_velocity) });
    if (competitorTop.length >= 5) break;
  }
  const askSeen = new Set<string>();
  const audienceAsks: ChannelFacts["audienceAsks"] = [];
  for (const r of (asks.data ?? []) as { topic_phrase: string | null; mention_count: number | null }[]) {
    const topic = plain(r.topic_phrase, 80);
    if (!topic || askSeen.has(topic.toLowerCase())) continue;
    askSeen.add(topic.toLowerCase());
    audienceAsks.push({ topic, mentions: n(r.mention_count) ?? 0 });
    if (audienceAsks.length >= 8) break;
  }
  const ownRecent = videos.flatMap((v) => {
    const title = plain(v.title, 120);
    if (!title) return [];
    const s = latest.get(v.video_id);
    return [{ title, views: n(s?.views), avgViewSeconds: n(s?.average_view_duration_seconds) }];
  });
  const any = ownRecent.length + competitorTop.length + audienceAsks.length > 0;
  return { ...base, state: any ? "data" : "none", ownRecent, competitorTop, audienceAsks };
}
