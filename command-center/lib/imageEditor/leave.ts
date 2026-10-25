/**
 * Leaving the page with unsaved edits. The browser asks on a tab close or a reload (beforeunload); the App Router has no
 * hook for an in-app link, so a click on one is checked here, before Next sees it. The browser's Back button is NOT covered
 * (popstate cannot be cancelled in the App Router): that limit is documented in docs/IMAGE_EDITOR.md.
 */
export interface LeaveLink {
  href: string;
  target?: string | null;
  download?: boolean;
}
export interface LeaveClick {
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
}

/** True when following this link would leave the page the person is editing in this tab. */
export function leavesThePage(link: LeaveLink, click: LeaveClick, here: string): boolean {
  if (click.defaultPrevented || (click.button ?? 0) !== 0) return false;
  // A new tab or window keeps this page where it is.
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (link.download || (link.target && link.target !== "_self")) return false;
  let to: URL;
  let from: URL;
  try {
    from = new URL(here);
    to = new URL(link.href, from);
  } catch {
    return false;
  }
  if (to.protocol !== "http:" && to.protocol !== "https:") return false;
  // A same-page anchor (#top) leaves nothing behind; a different origin is the browser's own beforeunload.
  if (to.origin !== from.origin) return false;
  return to.pathname !== from.pathname || to.search !== from.search;
}
