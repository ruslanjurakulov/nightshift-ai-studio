import { redirect } from "next/navigation";
import { ALL_CHANNELS_SLUG, channelSlug } from "@/lib/channels";
import { getChannelContext } from "@/lib/channels-server";

/**
 * A channel on its own names no screen — it names a lens. Landing on one sends
 * you to that channel's Command Center, which is what "open this channel"
 * means.
 *
 * The bare every-channel segment is where a sign-in with no remembered channel
 * lands (middleware.ts). It opens the first channel rather than the roll-up —
 * the app is one workspace first — and the roll-up only when there is no
 * channel yet. `/all-channels/command-center` itself stays reachable.
 */
export default async function ChannelIndex({
  params,
}: {
  params: Promise<{ channel: string }>;
}) {
  const { channel } = await params;
  if (channel === ALL_CHANNELS_SLUG) {
    const { channels } = await getChannelContext();
    const first = channels[0];
    redirect(`/${first ? channelSlug(first, channels) : ALL_CHANNELS_SLUG}/command-center`);
  }
  redirect(`/${channel}/command-center`);
}
