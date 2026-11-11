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

/**
 * An organization switch that must wait for a full document load (leaving the editor's project page, which
 * runs its unsaved-changes prompt). Switching first and then loading left a person who cancelled the prompt on
 * the old page under the NEW organization's session. So the intent is kept in this tab's session storage and
 * the new page asks the server ({@link applyPendingOrganizationSwitch}); a cancelled load changes nothing.
 */
const PENDING_ORG_KEY = "ns.pendingOrgSwitch";
/** How long a kept switch is good for: a cancelled one must not fire on a later, unrelated load. */
export const PENDING_ORG_TTL_MS = 60_000;

export function deferOrganizationSwitch(orgId: string, href: string, now: number = Date.now()): void {
  try {
    const path = new URL(href, window.location.origin).pathname;
    window.sessionStorage.setItem(PENDING_ORG_KEY, JSON.stringify({ orgId, path, at: now }));
  } catch {
    // no storage: the switch is simply not made (the page stays as it is)
  }
}

/**
 * On a page load: the switch kept for exactly this page within PENDING_ORG_TTL_MS is made now (true when the
 * server switched; the caller then refreshes). Any kept switch is forgotten either way.
 */
export async function applyPendingOrganizationSwitch(pathname: string, now: number = Date.now()): Promise<boolean> {
  let pending: { orgId?: unknown; path?: unknown; at?: unknown } | null = null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_ORG_KEY);
    window.sessionStorage.removeItem(PENDING_ORG_KEY);
    pending = raw ? JSON.parse(raw) : null;
  } catch {
    return false;
  }
  if (
    !pending ||
    typeof pending.orgId !== "string" ||
    pending.path !== pathname ||
    typeof pending.at !== "number" ||
    !(now - pending.at >= 0 && now - pending.at <= PENDING_ORG_TTL_MS)
  )
    return false;
  return switchOrganization(pending.orgId);
}
