import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchSocialAccounts } from "@/lib/server/social-accounts";
import { fetchTokenStatuses } from "@/lib/server/channel-tokens";
import { getChannelContext } from "@/lib/channels-server";
import { youtubeAccounts } from "@/lib/connectedAccounts";
import {
  PUBLISH_REQUEST_COLUMNS,
  coercePublishRequests,
  type PublishRequestRow,
  type YoutubeTarget,
} from "@/lib/publish";
import type { SocialAccount } from "@/lib/social-accounts";

/**
 * The organization's YouTube channels as publish targets, read as the
 * signed-in user (RLS): the channels of the organization being viewed — only
 * those in the same organization as the video's own channel — with the
 * "connected" rule of the account panel (lib/connectedAccounts.ts: the 0022
 * Vault reference when there is one, else the credential health row). The
 * database checks the same thing again on insert (publish_channel_connected).
 */
async function loadYoutubeTargets(videoChannelId: string): Promise<YoutubeTarget[]> {
  try {
    const { channels, credentials } = await getChannelContext();
    const own = channels.find((c) => c.channel_id === videoChannelId);
    const sameOrg = own?.org_id ? channels.filter((c) => c.org_id === own.org_id) : channels;
    if (sameOrg.length === 0) return [];
    const tokens = await fetchTokenStatuses();
    const accounts = youtubeAccounts(sameOrg, credentials, tokens.available ? tokens.rows : null);
    return accounts.map((a) => {
      const ch = sameOrg.find((c) => c.channel_id === a.id);
      return {
        channel_id: a.id,
        name: a.name,
        avatarUrl: a.avatarUrl,
        connected: a.connected,
        active: String(ch?.status ?? "").toUpperCase() === "ACTIVE",
      };
    });
  } catch {
    return [];
  }
}

/**
 * What the video page's "Publish to platforms" panel starts from, read as the
 * signed-in user (RLS): the organization's connected Instagram / TikTok
 * accounts, its YouTube channels, and this video's publish requests, newest
 * first. `available` is false when 0028/0029 are not applied — the panel then
 * says so.
 */
export async function loadPublishPanel(
  videoId: string,
  videoChannelId: string,
  orgId: string | null,
): Promise<{
  available: boolean;
  accounts: SocialAccount[];
  youtube: YoutubeTarget[];
  requests: PublishRequestRow[];
}> {
  const [social, youtube] = await Promise.all([fetchSocialAccounts(orgId), loadYoutubeTargets(videoChannelId)]);
  if (!social.available) return { available: false, accounts: [], youtube, requests: [] };
  const supabase = await createClient();
  if (!supabase) return { available: false, accounts: [], youtube, requests: [] };
  try {
    const { data, error } = await supabase
      .from("publish_requests")
      .select(PUBLISH_REQUEST_COLUMNS)
      .eq("video_id", videoId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return { available: false, accounts: social.rows, youtube, requests: [] };
    return { available: true, accounts: social.rows, youtube, requests: coercePublishRequests(data) };
  } catch {
    return { available: false, accounts: social.rows, youtube, requests: [] };
  }
}
