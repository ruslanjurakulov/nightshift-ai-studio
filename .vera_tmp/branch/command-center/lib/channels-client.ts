"use client";

import { useCallback } from "react";
import { usePathname } from "next/navigation";
import { ALL_CHANNELS_SLUG, channelPath } from "@/lib/channels";

/**
 * The channel the current URL is about, read from the URL itself.
 *
 * No provider and no context: the first path segment already IS the channel, so
 * anything that can call usePathname already knows. Deriving it beats passing
 * it down, because the two can never disagree.
 */
export function useChannelSlug(): string {
  const pathname = usePathname();
  return pathname.split("/")[1] || ALL_CHANNELS_SLUG;
}

/**
 * Turn a section path into a link that stays on this channel.
 *
 * Every in-app link goes through this, so switching channel and then navigating
 * never silently drops you back to "every channel".
 */
export function useChannelPath(): (section: string) => string {
  const slug = useChannelSlug();
  // Stable while the channel is: effects that key off this (the palette's
  // hotkey listener) then re-register only when the channel actually changes,
  // not on every render.
  return useCallback((section: string) => channelPath(slug, section), [slug]);
}
