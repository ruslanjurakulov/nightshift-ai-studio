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

/** Indirection so tests can watch the form go (jsdom cannot navigate). */
export const formNav = {
  submit(form: HTMLFormElement): void {
    form.submit();
  },
};

/**
 * Switch organization as a NAVIGATION (app/api/org/switch): a same-origin form post that the server answers by
 * switching and redirecting to `/all-channels` under the new organization. Used where leaving the page must be a
 * full document load (the editor's project page): the page's unsaved-changes prompt runs before anything is sent,
 * so a person who cancels it changes nothing.
 */
export function submitOrganizationSwitch(orgId: string): void {
  const form = document.createElement("form");
  form.method = "post";
  form.action = "/api/org/switch";
  form.style.display = "none";
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "orgId";
  field.value = orgId;
  form.appendChild(field);
  document.body.appendChild(form);
  formNav.submit(form);
}
