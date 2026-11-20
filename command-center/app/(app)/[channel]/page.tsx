import { redirect } from "next/navigation";
import { ALL_CHANNELS_SLUG, channelSlug } from "@/lib/channels";
import { getChannelContext } from "@/lib/channels-server";
import { isOperator } from "@/lib/auth/org-roles";
import { landingSection } from "@/lib/navigation";
import { cookies } from "next/headers";
import { OWNER_MODE_COOKIE, ownerFrame } from "@/lib/owner-mode";

/**
 * A channel on its own names no screen — it names a lens. Landing on one sends
 * you to where you start in that channel: the operator's Command Center, a
 * customer's Home (lib/navigation landingSection).
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
  // The owner with Owner mode off lands where a customer does (lib/owner-mode): the frame decides the first screen.
  const operator = await isOperator();
  const landing = landingSection(operator && ownerFrame(operator, (await cookies()).get(OWNER_MODE_COOKIE)?.value));
  if (channel === ALL_CHANNELS_SLUG) {
    const { channels } = await getChannelContext();
    const first = channels[0];
    redirect(`/${first ? channelSlug(first, channels) : ALL_CHANNELS_SLUG}/${landing}`);
  }
  redirect(`/${channel}/${landing}`);
}
