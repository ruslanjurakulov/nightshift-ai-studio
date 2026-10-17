import { ALL_CHANNELS_SLUG, CHANNEL_COOKIE, selectionSlug } from "@/lib/channels";
import type { ChannelRow } from "@/lib/types";

/**
 * Switching organization or channel, shared by the desktop switchers (components/org/OrgSwitcher,
 * components/ChannelSwitcher) and the phone's one-button picker (components/shell/ContextSwitcher), so
 * the three always do the same thing.
 */

/** Remember a channel slug for a channelless URL. One year, path-wide, Lax: a view preference, not a credential. */
export function rememberChannel(slug: string): void {
  document.cookie = `${CHANNEL_COOKIE}=${encodeURIComponent(slug)}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * Choosing a channel navigates: the first URL segment is swapped and the screen stays, so
 * /chronos/analytics becomes /extinct-world/analytics. Returns the address to push.
 */
export function channelSwitchHref(next: string, channels: ChannelRow[], pathname: string): string {
  const slug = selectionSlug(next, channels);
  const rest = pathname.split("/").slice(2).join("/");
  return `/${slug}${rest ? "/" + rest : "/command-center"}`;
}

/**
 * Ask the server to switch organization (it checks the choice against the caller's memberships) and, on
 * success, forget the remembered channel, which belongs to the organization being left. True when it switched.
 * The caller then pushes to `/${ALL_CHANNELS_SLUG}` (the first channel of the new org) and refreshes.
 */
export async function switchOrganization(orgId: string): Promise<boolean> {
  try {
    const res = await fetch("/api/org/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId }),
    });
    if (!res.ok) return false;
    document.cookie = `${CHANNEL_COOKIE}=${ALL_CHANNELS_SLUG}; path=/; max-age=31536000; samesite=lax`;
    return true;
  } catch {
    return false;
  }
}
