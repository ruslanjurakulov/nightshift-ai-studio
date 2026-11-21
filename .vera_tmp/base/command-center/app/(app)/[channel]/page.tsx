import { redirect } from "next/navigation";
import { ALL_CHANNELS_SLUG, channelSlug } from "@/lib/channels";
import { getChannelContext } from "@/lib/channels-server";
import { landingSection } from "@/lib/navigation";
import { OWNER_CONSOLE } from "@/lib/owner-mode";
import { isPlatformOwner, viewingAsOperator } from "@/lib/server/owner-view";

/**
 * A channel on its own names no screen — it names a lens. Landing on one sends
 * you to where you start in that channel: the platform owner in the Owner account opens the Owner Console, another
 * operator their Command Center, a customer (and the owner in the User account) Home (lib/navigation landingSection).
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
  // The owner in the User account lands where a customer does (lib/owner-mode): the account decides the first screen.
  const asOperator = await viewingAsOperator();
  if (asOperator && (await isPlatformOwner())) redirect(OWNER_CONSOLE);
  const landing = landingSection(asOperator);
  if (channel === ALL_CHANNELS_SLUG) {
    const { channels } = await getChannelContext();
    const first = channels[0];
    redirect(`/${first ? channelSlug(first, channels) : ALL_CHANNELS_SLUG}/${landing}`);
  }
  redirect(`/${channel}/${landing}`);
}
