import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelFacts } from "@/lib/brain/prompt";
import { plain } from "@/lib/brain/logic";

/**
 * The channel's research for one turn, read AS THE PERSON (RLS / member-scoped SECURITY DEFINER readers), so the model is only ever
 * shown what the person could open themselves.
 *
 * First S10's readers (docs/studio/RESEARCH_TOOLS.md, migration 0199): research_own_channel, research_competitors_view,
 * research_comment_themes. Their envelope {status, fetched_at, source, data} is kept; every string in `data` is made plain and
 * bounded, and comment text stays under `untrusted_text`. When those readers are not applied yet (PGRST202), Nightshift's own records
 * stand in: the channel's recent videos with their latest snapshot, competitors' fastest titles, and demand_signals (topics the worker
 * mined from comments; raw comments never reach the model).
 *
 * Rule 5: a reader that fails is "unknown", never "none" — "no data" is a measurement, and a failed read measured nothing. A reader's
 * own status (no_data, not_connected, refreshing, budget_exhausted, not_enabled) is passed on as it is.
 */

const READERS = ["research_own_channel", "research_competitors_view", "research_comment_themes"] as const;
const MAX_DATA_BYTES = 6_000;

/** Every string plain and bounded, depth and breadth bounded: research data is someone else's text. */
function clean(v: unknown, depth = 0): unknown {
  if (depth > 4) return null;
  if (typeof v === "string") return plain(v, 300);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clean(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) out[plain(k, 40)] = clean(x, depth + 1);
    return out;
  }
  return null;
}

function bounded(v: unknown): unknown {
  const c = clean(v);
  const s = JSON.stringify(c);
  return s && s.length > MAX_DATA_BYTES ? { truncated: true } : c;
}

export async function readChannelFacts(supabase: SupabaseClient, channelId: string | null, name: string): Promise<ChannelFacts> {
  const base: ChannelFacts = { state: "unknown", source: null, name: plain(name, 80), statuses: {}, ownRecent: [], competitorTop: [], audienceAsks: [] };
  if (!channelId) return { ...base, state: "none" };

  const answers = await Promise.all(
    READERS.map((fn) => supabase.rpc(fn, fn === "research_comment_themes" ? { p_channel: channelId, p_days: 28 } : { p_channel: channelId })),
  );
  const missing = answers.every((a) => a.error && (a.error.code === "PGRST202" || a.error.code === "42883"));
  if (!missing) {
    const research: Record<string, unknown> = {};
    let any = false;
    let failed = false;
    READERS.forEach((fn, i) => {
      const a = answers[i];
      if (a.error) {
        failed = true;
        base.statuses[fn] = "unknown";
        return;
      }
      const env = (a.data ?? {}) as Record<string, unknown>;
      const status = typeof env.status === "string" ? plain(env.status, 30) : "unknown";
      base.statuses[fn] = status;
      if (status === "ok") any = true;
      research[fn] = { status, source: plain(env.source, 20) || null, fetched_at: plain(env.fetched_at, 40) || null, data: bounded(env.data) };
    });
    // The readers' own shapes, cleaned: the model reads them as data (S10 owns their fields).
    return { ...base, state: any ? "data" : failed ? "unknown" : "none", source: "youtube", research };
  }

  // Before S10's readers are applied: Nightshift's own records.
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const [vids, comp, asks] = await Promise.all([
    supabase.from("videos").select("video_id,title,published_at").eq("channel_id", channelId).not("title", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false }).limit(10),
    supabase.from("competitor_snapshots").select("title,view_count,polled_date").eq("chronos_channel_id", channelId)
      .gte("polled_date", since).order("view_count", { ascending: false, nullsFirst: false }).limit(20),
    supabase.from("demand_signals").select("topic_phrase,mention_count,polled_date").eq("channel_id", channelId)
      .order("polled_date", { ascending: false }).limit(30),
  ]);
  if (vids.error || comp.error || asks.error) return base;
  const videos = (vids.data ?? []) as { video_id: string; title: string | null }[];
  let snaps: { video_id: string; views: number | null; likes: number | null; comment_count: number | null; snapshot_date: string }[] = [];
  if (videos.length) {
    const m = await supabase.from("metrics_snapshots").select("video_id,views,likes,comment_count,snapshot_date")
      .in("video_id", videos.map((v) => v.video_id)).order("snapshot_date", { ascending: false }).limit(200);
    if (m.error) return base;
    snaps = (m.data ?? []) as typeof snaps;
  }
  const latest = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) if (!latest.has(s.video_id)) latest.set(s.video_id, s);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
  const seen = new Set<string>();
  const competitorTop: ChannelFacts["competitorTop"] = [];
  for (const r of (comp.data ?? []) as { title: string | null; view_count: number | null }[]) {
    const title = plain(r.title, 120);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    competitorTop.push({ title, views: n(r.view_count) });
    if (competitorTop.length >= 5) break;
  }
  const askSeen = new Set<string>();
  const audienceAsks: ChannelFacts["audienceAsks"] = [];
  for (const r of (asks.data ?? []) as { topic_phrase: string | null; mention_count: number | null }[]) {
    const topic = plain(r.topic_phrase, 80);
    if (!topic || askSeen.has(topic.toLowerCase())) continue;
    askSeen.add(topic.toLowerCase());
    audienceAsks.push({ untrusted_text: topic, count: n(r.mention_count) });
    if (audienceAsks.length >= 8) break;
  }
  const ownRecent = videos.flatMap((v) => {
    const title = plain(v.title, 120);
    if (!title) return [];
    const s = latest.get(v.video_id);
    return [{ title, views: n(s?.views), likes: n(s?.likes), comments: n(s?.comment_count) }];
  });
  const any = ownRecent.length + competitorTop.length + audienceAsks.length > 0;
  return { ...base, state: any ? "data" : "none", source: "nightshift", ownRecent, competitorTop, audienceAsks };
}
