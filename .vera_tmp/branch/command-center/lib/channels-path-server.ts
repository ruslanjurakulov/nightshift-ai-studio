import "server-only";
import { headers } from "next/headers";
import { ALL_CHANNELS_SLUG, CHANNEL_HEADER, channelPath } from "@/lib/channels";

/** The channel segment of the current URL, for Server Components. */
export async function getChannelSlug(): Promise<string> {
  return (await headers()).get(CHANNEL_HEADER) || ALL_CHANNELS_SLUG;
}

/** A link that stays on the current channel, for Server Components. */
export async function getChannelPath(): Promise<(section: string) => string> {
  const slug = await getChannelSlug();
  return (section: string) => channelPath(slug, section);
}
