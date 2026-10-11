/**
 * The customer sidebar's width preference, as plain constants and one pure reader.
 *
 * These live outside components/shell/SidebarState.tsx on purpose: that module is a client component, and a constant
 * imported from a client module into a Server Component (the (app) layout) does not resolve to its value on the
 * server, so the layout could never match the cookie. Both sides import from here.
 */
/** localStorage key (the browser's own memory of the choice). */
export const SIDEBAR_KEY = "ns-sidebar";
/** Cookie name: a mirror of the choice so the server draws the right width on the first frame. */
export const SIDEBAR_COOKIE = "ns_sidebar";
/** The only value that means collapsed; anything else (missing, junk) is the open sidebar. */
export const SIDEBAR_COLLAPSED = "collapsed";
export const SIDEBAR_OPEN = "open";

export function isSidebarCollapsed(value: string | null | undefined): boolean {
  return value === SIDEBAR_COLLAPSED;
}
