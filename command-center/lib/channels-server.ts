import { cookies, headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import {
  ALL_CHANNELS,
  ALL_CHANNELS_SLUG,
  CHANNEL_COOKIE,
  CHANNEL_HEADER,
  DEFAULT_CHANNEL_ID,
  resolveSelection,
  selectionSlug,
  slugToSelection,
  type ChannelSelection,
} from "@/lib/channels";
import type {
  ChannelCredentialRow,
  ChannelRow,
  ChannelTopicPerformanceRow,
  TopicPerformanceRow,
} from "@/lib/types";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Server-side channel context: the channels this user can see, and which one
 * they have selected.
 *
 * Kept out of lib/channels.ts so that module stays pure and unit-testable —
 * this file is the only part that touches cookies and the database.
 *
 * `channels` is empty (not an error) when the multi-channel migration has not
 * been applied yet. Callers then render exactly as they did before Phase 5,
 * which is what a single-channel deployment should see.
 */
export interface ChannelContextData {
  channels: ChannelRow[];
  credentials: ChannelCredentialRow[];
  selection: ChannelSelection;
  /** The URL segment this selection SHOULD have — the channel's name, not its
   *  internal id. The layout redirects when the URL disagrees. */
  slug: string;
  /** True once more than one channel exists — the switcher is noise before that. */
  multi: boolean;
  /** True when the `channels` table isn't there yet (migration not applied). */
  notMigrated: boolean;
}

export async function getChannelContext(): Promise<ChannelContextData> {
  const supabase = await createClient();

  // The URL is the selection. The middleware reads the channel segment and
  // sets it as a header, because a Server Component this deep cannot see route
  // params. The cookie is only a memory of the channel last viewed, used to
  // send a channelless URL somewhere sensible — never to decide what a URL
  // that already names a channel is showing.
  const headerStore = await headers();
  const fromUrl = headerStore.get(CHANNEL_HEADER);
  const raw = fromUrl
    ? slugToSelection(fromUrl)
    : (await cookies()).get(CHANNEL_COOKIE)?.value;

  if (!supabase) {
    return {
      channels: [],
      credentials: [],
      selection: ALL_CHANNELS,
      slug: ALL_CHANNELS_SLUG,
      multi: false,
      notMigrated: false,
    };
  }

  // Channels belong to an organization (migration 0018), and the switcher,
  // the URL and every "all channels" count are about the CURRENT one. RLS
  // already hides other tenants' channels; this narrows the operator — who
  // may read every org — to the org they are looking at. Before 0018 there is
  // no org and nothing is narrowed.
  const org = await getOrgContext();
  let channelQuery = supabase.from("channels").select("*").order("channel_id", { ascending: true });
  // No current org means the caller belongs to none yet: the nil uuid matches
  // no channel, which is the truth, and keeps the query well-formed.
  if (org.supported) channelQuery = channelQuery.eq("org_id", org.current?.id ?? NIL_UUID);

  const [ch, cr] = await Promise.all([
    channelQuery,
    supabase.from("channel_credentials").select("*"),
  ]);

  // PGRST205: the table doesn't exist. That is a "not migrated yet" state, not
  // a failure to report as broken — say so plainly where it matters and
  // otherwise behave like the single-channel app.
  const notMigrated = Boolean(ch.error && /does not exist|PGRST205/i.test(ch.error.message));
  const channels = (ch.data as ChannelRow[]) ?? [];
  const inOrg = new Set(channels.map((c) => c.channel_id));
  const credentials = ((cr.data as ChannelCredentialRow[]) ?? []).filter(
    (c) => !org.supported || inOrg.has(c.channel_id),
  );

  const selection = resolveSelection(raw, channels);
  return {
    channels,
    credentials,
    selection,
    slug: selectionSlug(selection, channels),
    multi: channels.length > 1,
    notMigrated,
  };
}

/** Just the selection, for pages that don't need the channel list. */
export async function getChannelSelection(): Promise<ChannelSelection> {
  return (await getChannelContext()).selection;
}

/**
 * Learned topic scores for the current view.
 *
 * Two tables hold scores and they are not interchangeable:
 *
 * * `channel_topic_performance` is keyed on (channel_id, topic) and is the
 *   isolated, per-channel verdict.
 * * `topic_performance` is keyed on `topic` alone. It predates channels and is
 *   still written for the default channel, so it remains correct for a
 *   single-channel deployment and for historical data — but it structurally
 *   cannot hold two channels' scores for the same topic.
 *
 * So: scoped to a channel, read that channel's own rows (falling back to the
 * shared table for the default channel, whose scores may predate Phase 5).
 * Across all channels, read the shared table and do NOT merge per-channel rows
 * — averaging a Finance verdict with a History one would invent a number that
 * describes neither. The topics page says so where more than one channel
 * exists.
 */
export async function fetchTopicScores(
  supabase: NonNullable<Awaited<ReturnType<typeof createClient>>>,
  selection: ChannelSelection,
  limit = 200,
): Promise<TopicPerformanceRow[]> {
  if (selection !== ALL_CHANNELS) {
    return fetchChannelTopicScores(supabase, selection, limit);
  }
  const { data } = await supabase
    .from("topic_performance")
    .select("*")
    .order("score", { ascending: false })
    .limit(limit);
  return (data as TopicPerformanceRow[]) ?? [];
}

/** One channel's scores, by id — used where the channel is known from the row
 *  being rendered (a video's own channel) rather than from the switcher. */
export async function fetchChannelTopicScores(
  supabase: NonNullable<Awaited<ReturnType<typeof createClient>>>,
  channelId: string,
  limit = 200,
): Promise<TopicPerformanceRow[]> {
  const { data, error } = await supabase
    .from("channel_topic_performance")
    .select("*")
    .eq("channel_id", channelId)
    .order("score", { ascending: false })
    .limit(limit);

  const rows = (data as ChannelTopicPerformanceRow[]) ?? [];
  if (rows.length > 0) {
    // Same shape minus the key column, so every existing consumer works unchanged.
    return rows.map((r) => ({
      topic: r.topic,
      score: r.score,
      videos_analyzed: r.videos_analyzed,
      avg_views_per_day: r.avg_views_per_day,
      reason: r.reason,
      updated_at: r.updated_at,
    }));
  }
  // No per-channel rows: for the default channel that means its scores predate
  // the channel-scoped table, so fall back rather than show it as unscored. For
  // any other channel, empty is the truth — it simply has not been scored yet.
  if (error || channelId !== DEFAULT_CHANNEL_ID) return [];
  const legacy = await supabase
    .from("topic_performance")
    .select("*")
    .order("score", { ascending: false })
    .limit(limit);
  return (legacy.data as TopicPerformanceRow[]) ?? [];
}
