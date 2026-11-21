import "server-only";
import { createClient } from "@/lib/supabase/server";
import { ALL_CHANNELS, type ChannelScope } from "@/lib/channels";
import { coerceChannel, type ChannelRead } from "@/lib/brain/dashboard";

/** PGRST202 / 42883: the reader is not there, so S10's migration is not applied here yet. Said as "not switched on". */
function isMissingFunction(e: { code?: string; message?: string } | null): boolean {
  return Boolean(e && (e.code === "PGRST202" || e.code === "42883" || /could not find the function/i.test(e.message ?? "")));
}

/** The channel the card is about: the one open, or the workspace's only one. Several under "All channels" are never summed. */
export function brainChannelFor(scope: ChannelScope): { channelId: string } | { state: "pick_channel" | "no_channel" } {
  if (scope.selection !== ALL_CHANNELS) return { channelId: scope.selection };
  const ids = scope.orgChannelIds ?? [];
  if (ids.length === 1) return { channelId: ids[0] };
  return { state: ids.length === 0 ? "no_channel" : "pick_channel" };
}

/**
 * S10's research readers for one channel, read as the signed-in person (they check membership themselves):
 * research_own_channel and research_comment_themes. Reading never refreshes: fresh numbers are the person's
 * explicit press (POST /api/brain/refresh).
 */
export async function readBrainChannel(scope: ChannelScope): Promise<ChannelRead> {
  const which = brainChannelFor(scope);
  if ("state" in which) return { state: which.state };
  const supabase = await createClient();
  if (!supabase) return { state: "not_enabled" };
  try {
    const [own, themes] = await Promise.all([
      supabase.rpc("research_own_channel", { p_channel: which.channelId }),
      supabase.rpc("research_comment_themes", { p_channel: which.channelId }),
    ]);
    if (own.error) return isMissingFunction(own.error) ? { state: "not_enabled" } : { state: "failed" };
    // Themes failing is not the channel failing: the card shows the numbers and leaves the themes out.
    return coerceChannel(which.channelId, own.data, themes.error ? null : themes.data);
  } catch {
    return { state: "failed" };
  }
}
