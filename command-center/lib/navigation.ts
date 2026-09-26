/**
 * Where a screen sits in the app, and where "back" goes from it.
 *
 * The sidebar, the breadcrumbs and the tab title all read the same list below,
 * so a section renamed in the dictionary is renamed everywhere at once — a
 * breadcrumb that disagrees with the rail it sits beside is worse than none.
 *
 * Pure: no React, no window. The client pieces (components/navigation/*) feed
 * it the pathname and the in-app history they have tracked.
 */

import type { Dictionary } from "@/lib/i18n";

export type NavKey = Exclude<keyof Dictionary["nav"], "more" | "gManage" | "gIntel" | "gSystem" | "menu">;
export type NavGroupLabel = keyof Pick<Dictionary["nav"], "gManage" | "gIntel" | "gSystem">;
export interface NavItem {
  href: string;
  key: NavKey;
}
export interface NavGroup {
  label?: NavGroupLabel;
  items: NavItem[];
}

/** The ground floor. Named, like every other section — `/` only redirects here. */
export const HOME = "/command-center";

/**
 * The primary navigation, in rail order. The first group has no heading: those
 * are the daily loop (make a video, watch it, shape the look, follow the
 * pipeline, read the numbers). SideNav attaches the icons.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: HOME, key: "command" },
      { href: "/create", key: "create" },
      { href: "/videos", key: "videos" },
      { href: "/studio", key: "studio" },
      { href: "/pipeline", key: "pipeline" },
      { href: "/analytics", key: "analytics" },
    ],
  },
  {
    label: "gManage",
    items: [
      { href: "/channels", key: "channels" },
      { href: "/accounts", key: "accounts" },
      { href: "/portfolio", key: "portfolio" },
      { href: "/providers", key: "providers" },
      { href: "/billing", key: "billing" },
      { href: "/credits", key: "credits" },
      { href: "/series", key: "series" },
      { href: "/agents", key: "agents" },
      { href: "/jobs", key: "jobs" },
    ],
  },
  {
    label: "gIntel",
    items: [
      { href: "/intelligence", key: "advisory" },
      { href: "/intelligence-map", key: "intelligence" },
      { href: "/decisions", key: "decisions" },
      { href: "/learning", key: "learning" },
      { href: "/memory", key: "memory" },
      { href: "/topics", key: "topics" },
      { href: "/measurement", key: "measure" },
      { href: "/feedback-loop", key: "feedback" },
      { href: "/autonomy", key: "autonomy" },
    ],
  },
  {
    label: "gSystem",
    items: [
      { href: "/getting-started", key: "onboarding" },
      { href: "/organization", key: "organization" },
      { href: "/members", key: "members" },
      { href: "/security", key: "security" },
      { href: "/approvals", key: "approvals" },
      { href: "/alerts", key: "alerts" },
      { href: "/audit", key: "audit" },
      { href: "/time-machine", key: "timeMachine" },
      { href: "/integrations", key: "integrations" },
      { href: "/errors", key: "errors" },
      { href: "/logs", key: "logs" },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** `/chronos/videos/abc?x=1` → slug "chronos", segments ["videos", "abc"]. */
export function splitPath(pathname: string): { slug: string; segments: string[] } {
  const clean = pathname.split(/[?#]/)[0] ?? "";
  const [slug = "", ...segments] = clean.split("/").filter(Boolean);
  return { slug, segments };
}

export function isHomePath(pathname: string): boolean {
  const { segments } = splitPath(pathname);
  return segments.length === 1 && "/" + segments[0] === HOME;
}

export type Crumb =
  /** The channel the URL is about — context, not a destination. */
  | { kind: "channel"; slug: string }
  /** A section the sidebar knows, labelled from the sidebar's own key. */
  | { kind: "section"; key: NavKey; href: string }
  /** A segment below a section (`/videos/<id>`, `/channels/new`), or a route
   *  the sidebar does not list. Labelled by the caller, which knows the words. */
  | { kind: "detail"; segment: string; parent: string | null; href: string };

/**
 * The trail for a pathname: [channel, Command Center, section, detail…].
 *
 * The channel comes first and always — whether to SHOW it (a single-channel
 * deployment has nothing to distinguish) is the caller's choice. The Command
 * Center itself is the whole trail on its own ground floor.
 */
export function breadcrumbs(pathname: string): Crumb[] {
  const { slug, segments } = splitPath(pathname);
  if (!slug) return [];
  const at = (p: string) => `/${slug}${p}`;
  const crumbs: Crumb[] = [{ kind: "channel", slug }, { kind: "section", key: "command", href: at(HOME) }];
  if (segments.length === 0) return crumbs;

  const sectionHref = "/" + segments[0];
  if (sectionHref === HOME) return crumbs;
  const item = NAV_ITEMS.find((i) => i.href === sectionHref);
  if (item) crumbs.push({ kind: "section", key: item.key, href: at(item.href) });
  else crumbs.push({ kind: "detail", segment: segments[0], parent: null, href: at(sectionHref) });

  let href = sectionHref;
  for (const segment of segments.slice(1)) {
    href += "/" + segment;
    crumbs.push({ kind: "detail", segment: decodeSegment(segment), parent: segments[0], href: at(href) });
  }
  return crumbs;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Where "up" is from a pathname, on the same channel: `/c/videos/abc` →
 * `/c/videos`, `/c/integrations` → `/c/command-center`. Null on the ground
 * floor, which has no parent.
 */
export function parentPath(pathname: string): string | null {
  const { slug, segments } = splitPath(pathname);
  if (!slug) return null;
  if (segments.length === 0) return `/${slug}${HOME}`;
  if (segments.length === 1) return "/" + segments[0] === HOME ? null : `/${slug}${HOME}`;
  return `/${slug}/${segments.slice(0, -1).join("/")}`;
}

/** Enough to cover any real session; bounded so the list cannot grow forever. */
export const MAX_TRACKED = 50;

/**
 * Keep a record of the in-app pages this tab has visited, top = current.
 *
 * Why not `history.length`: it counts pages from before the app (a search
 * result, the login screen), so a back based on it can leave the product. And
 * `document.referrer` is not updated by client-side navigation at all. This
 * list only ever holds pages this app rendered in this tab.
 *
 * `viaPop` is a browser back/forward. Stepping back to the page under the top
 * pops. Any other pop is a jump the list cannot place (forward past a reload,
 * or back past where tracking started): the list restarts from here, so the
 * next "back" falls to the logical parent rather than guessing at an entry
 * that may be another site.
 */
export function recordVisit(stack: readonly string[], pathname: string, viaPop: boolean): string[] {
  const top = stack[stack.length - 1];
  if (top === pathname) return [...stack];
  if (viaPop) {
    if (stack.length > 1 && stack[stack.length - 2] === pathname) return stack.slice(0, -1);
    return [pathname];
  }
  const next = [...stack, pathname];
  return next.length > MAX_TRACKED ? next.slice(-MAX_TRACKED) : next;
}

export type BackAction = { kind: "history" } | { kind: "navigate"; href: string };

/**
 * What the back arrow does from `pathname`, given how many in-app pages sit
 * under it in this tab's history.
 *
 * With an in-app page behind: the browser's own back, so scroll position and
 * the page you actually came from are restored. With none (a fresh tab, a
 * pasted link, a reload): the logical parent — never `history.back()`, which
 * would leave the app. Null only on the ground floor with nothing behind.
 */
export function resolveBack(pathname: string, depth: number): BackAction | null {
  if (depth > 0) return { kind: "history" };
  const parent = parentPath(pathname);
  return parent ? { kind: "navigate", href: parent } : null;
}

/**
 * The stack to start a tab with, from what sessionStorage held before this
 * document loaded.
 *
 * Only a reload may resume it: the history behind a reloaded page is the same
 * history the stack described. A page reached any other way (a typed URL, a
 * link from another site, back from another site) may have anything behind it
 * — resuming then could send "back" out of the app — so tracking restarts.
 */
export function restoreStack(stored: unknown, pathname: string, navigationType: string | null): string[] {
  if (navigationType !== "reload" || !Array.isArray(stored)) return [pathname];
  const clean = stored.filter((p): p is string => typeof p === "string" && p.startsWith("/")).slice(-MAX_TRACKED);
  return clean.length > 0 && clean[clean.length - 1] === pathname ? clean : [pathname];
}

/**
 * The section a pathname's tab title names: the deepest crumb the sidebar
 * knows. `/c/videos/abc` is titled "Videos", which is truer than an id.
 */
export function titleKey(pathname: string): NavKey | null {
  const sections = breadcrumbs(pathname).filter((c): c is Extract<Crumb, { kind: "section" }> => c.kind === "section");
  return sections.length > 0 ? sections[sections.length - 1].key : null;
}
