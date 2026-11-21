import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EPISODE_COLUMNS,
  PLAN_COLUMNS,
  isSeriesId,
  isVideoLinkId,
  parseEpisode,
  parsePlan,
  parseQuote,
  type EpisodeLinks,
  type EpisodeView,
  type PlanView,
  type QuoteView,
} from "../seriesPlan";
import { scopeQuery, type ChannelScope } from "../channels";
import { isCreditsMissing } from "./credits";

/**
 * A series plan (migration 0120), read on the server with the signed-in user's client: RLS shows a plan and its episodes to members of
 * its organization and to nobody else (`series_plans_select`, `series_episodes_select`). No service key. The price of each episode is
 * the database's own answer (`quote_series_episode`); this file never computes one.
 */

export type EpisodeRead = {
  episode: EpisodeView;
  /** The database's quote, or null when it could not be read (shown as "price unavailable", never as 0). */
  quote: QuoteView | null;
  links: EpisodeLinks | null;
};

export type PlanRead =
  | { state: "ok"; plan: PlanView; episodes: EpisodeRead[]; linksFailed: boolean }
  | { state: "not_found" }
  | { state: "unsupported" }
  | { state: "failed" };

/** `inScope` is asked as soon as the plan's channel is known: a plan outside the current view reads as missing and its episodes (and
 *  their quotes) are never asked for. */
export async function readSeriesPlan(
  supabase: SupabaseClient,
  id: string,
  inScope: (channelId: string) => boolean = () => true,
): Promise<PlanRead> {
  if (!isSeriesId(id)) return { state: "not_found" };
  const { data, error } = await supabase.from("series_plans").select(PLAN_COLUMNS).eq("id", id).maybeSingle();
  if (error) return isCreditsMissing(error) ? { state: "unsupported" } : { state: "failed" };
  const plan = parsePlan(data);
  if (!plan || !inScope(plan.channelId)) return { state: "not_found" };
  if (plan.status !== "ready") return { state: "ok", plan, episodes: [], linksFailed: false };

  const eps = await supabase.from("series_episodes").select(EPISODE_COLUMNS).eq("plan_id", plan.id).order("n", { ascending: true });
  if (eps.error) return isCreditsMissing(eps.error) ? { state: "unsupported" } : { state: "failed" };
  const episodes = (eps.data ?? []).flatMap((row) => {
    const e = parseEpisode(row);
    return e ? [e] : [];
  });
  // A ready plan with fewer episodes than it was asked for is a read we cannot trust: say so, never show a short series.
  if (episodes.length !== plan.nEpisodes) return { state: "failed" };

  const quotes = await Promise.all(
    episodes.map(async (e): Promise<QuoteView | null> => {
      try {
        const { data: q, error: qe } = await supabase.rpc("quote_series_episode", { p_episode: e.id });
        return qe ? null : parseQuote(q);
      } catch {
        return null;
      }
    }),
  );
  const { links, failed } = await readLinks(supabase, plan, episodes);
  return {
    state: "ok",
    plan,
    episodes: episodes.map((episode, i) => ({ episode, quote: quotes[i], links: links.get(episode.id) ?? null })),
    linksFailed: failed,
  };
}

/** The run, the storyboard and the video of each STARTED episode: the run by its id, the others by the channel and the topic the run was
 *  given (an episode's run carries its topic explicitly, and 0120 keeps no storyboard id on the episode). */
async function readLinks(
  supabase: SupabaseClient,
  plan: PlanView,
  episodes: EpisodeView[],
): Promise<{ links: Map<string, EpisodeLinks>; failed: boolean }> {
  const started = episodes.filter((e) => e.status === "started");
  const links = new Map<string, EpisodeLinks>();
  if (started.length === 0) return { links, failed: false };
  const jobIds = started.flatMap((e) => (e.renderJobId === null ? [] : [e.renderJobId]));
  const topics = started.map((e) => e.topic).filter((t) => t !== "");
  const [jobs, boards, videos] = await Promise.all([
    jobIds.length ? supabase.from("render_jobs").select("id,status").in("id", jobIds) : Promise.resolve({ data: [], error: null }),
    topics.length
      ? supabase.from("storyboards").select("id,topic,status,created_at").eq("channel_id", plan.channelId).in("topic", topics).order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    topics.length
      ? supabase.from("videos").select("video_id,topic,published_at").eq("channel_id", plan.channelId).in("topic", topics).order("published_at", { ascending: false, nullsFirst: true })
      : Promise.resolve({ data: [], error: null }),
  ]);
  const failed = Boolean(jobs.error || boards.error || videos.error);
  const jobStatus = new Map<number, string>();
  for (const j of jobs.data ?? []) {
    if (typeof j?.id === "number" && typeof j.status === "string") jobStatus.set(j.id, j.status);
  }
  for (const e of started) {
    const board = (boards.data ?? []).find((b) => b?.topic === e.topic && isSeriesId(b.id) && typeof b.status === "string");
    const video = (videos.data ?? []).find((v) => v?.topic === e.topic && isVideoLinkId(v.video_id));
    links.set(e.id, {
      jobStatus: e.renderJobId === null ? null : (jobStatus.get(e.renderJobId) ?? null),
      storyboard: board ? { id: board.id as string, status: board.status as string } : null,
      video: video ? { id: video.video_id as string } : null,
    });
  }
  return { links, failed };
}

export type RecentPlan = { id: string; topic: string; title: string; status: string; createdAt: string | null; nEpisodes: number };
export type RecentPlans = { state: "ok"; plans: RecentPlan[] } | { state: "unsupported" } | { state: "failed" };

/** The organization's newest plans, for the list on the series page (the scope is the whole organization, as the series list is).
 *  RLS scopes it too; a missing table is "unsupported", not empty. */
export async function readRecentPlans(supabase: SupabaseClient, scope: ChannelScope): Promise<RecentPlans> {
  const { data, error } = await scopeQuery(supabase.from("series_plans").select(PLAN_COLUMNS), scope)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return isCreditsMissing(error) ? { state: "unsupported" } : { state: "failed" };
  return {
    state: "ok",
    plans: (data ?? []).flatMap((row) => {
      const p = parsePlan(row);
      return p ? [{ id: p.id, topic: p.topic, title: p.title, status: p.status, createdAt: p.createdAt, nEpisodes: p.nEpisodes }] : [];
    }),
  };
}
