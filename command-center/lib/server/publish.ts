import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchSocialAccounts } from "@/lib/server/social-accounts";
import { PUBLISH_REQUEST_COLUMNS, coercePublishRequests, type PublishRequestRow } from "@/lib/publish";
import type { SocialAccount } from "@/lib/social-accounts";

/**
 * What the video page's "Publish to platforms" panel starts from, read as the
 * signed-in user (RLS): the organization's connected Instagram / TikTok
 * accounts and this video's publish requests, newest first. `available` is
 * false when 0028/0029 are not applied — the panel then says so.
 */
export async function loadPublishPanel(
  videoId: string,
  orgId: string | null,
): Promise<{ available: boolean; accounts: SocialAccount[]; requests: PublishRequestRow[] }> {
  const social = await fetchSocialAccounts(orgId);
  if (!social.available) return { available: false, accounts: [], requests: [] };
  const supabase = await createClient();
  if (!supabase) return { available: false, accounts: [], requests: [] };
  try {
    const { data, error } = await supabase
      .from("publish_requests")
      .select(PUBLISH_REQUEST_COLUMNS)
      .eq("video_id", videoId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return { available: false, accounts: social.rows, requests: [] };
    return { available: true, accounts: social.rows, requests: coercePublishRequests(data) };
  } catch {
    return { available: false, accounts: social.rows, requests: [] };
  }
}
