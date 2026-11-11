/**
 * Going to and from the timeline editor's project page by a FULL document load.
 *
 * A page's Permissions-Policy is fixed when its document loads, and the editor's project page is the only one whose
 * policy lets the microphone be asked for (next.config.ts EDITOR_MIC_SOURCE, deploy/Caddyfile). A client-side
 * navigation keeps the document, and so its policy, in both directions:
 *
 *  * INTO the editor from any other page it would keep `microphone=()`, so Chromium refuses the voice-over's
 *    microphone before the person is asked (the recorder can only offer "Reload page");
 *  * OUT of the editor it would keep `microphone=(self)` on every page visited afterwards, the custom voice page
 *    included, which is exactly what the owner's decision rules out.
 *
 * So links into a project page are plain `<a href>` and programmatic moves use {@link loadDocument}, and while the
 * editor is open, in-app link clicks become full loads ({@link fullLoadTarget}, components/editor/useFullLoadLinks.ts).
 * A full load also runs the editor's `beforeunload` guard, so unsaved changes are asked about as on a reload.
 */

/** `/<channel>/editor/<project uuid>`, never under /api: the same shape as next.config.ts EDITOR_MIC_SOURCE. */
const PROJECT_PATH = /^\/(?!api\/)[^/]+\/editor\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/?$/;

export function isEditorProjectPath(pathname: string): boolean {
  return PROJECT_PATH.test(pathname);
}

/** Is this link (relative or absolute; query and hash ignored) the editor's project page? */
export function isEditorProjectHref(href: string): boolean {
  try {
    return isEditorProjectPath(new URL(href, "https://app.invalid").pathname);
  } catch {
    return false;
  }
}

/** Indirection so tests can watch the load (jsdom cannot navigate). */
export const documentNav = {
  assign(href: string): void {
    window.location.assign(href);
  },
};

/** Open `href` as a new document (never a client-side transition). */
export function loadDocument(href: string): void {
  documentNav.assign(href);
}

/**
 * Programmatic navigation in the app (the command palette, the channel / organization switcher): a full document load
 * when leaving the editor's project page or going to one, so neither page carries the other's Permissions-Policy;
 * the router's client-side transition everywhere else. Says which it did ("document" = no refresh is needed).
 */
export function navigate(href: string, router: { push(href: string): void }, here: string = window.location.pathname): "document" | "client" {
  if (isEditorProjectPath(here) || isEditorProjectHref(href)) {
    loadDocument(href);
    return "document";
  }
  router.push(href);
  return "client";
}

export interface ClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

export interface AnchorLike {
  /** The anchor's resolved `href` property (absolute). */
  href: string;
  target: string;
  download: boolean;
}

/**
 * The address a click on an anchor should load as a full document while the editor is open, or null to leave the
 * click alone: a new tab or window (a modifier, a middle click, `target`), a download, another origin, another
 * scheme, a link to a place on this same page, and a click someone already handled.
 */
export function fullLoadTarget(e: ClickLike, a: AnchorLike, here: URL): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  if (a.download || (a.target !== "" && a.target !== "_self")) return null;
  let to: URL;
  try {
    to = new URL(a.href, here);
  } catch {
    return null;
  }
  if (to.origin !== here.origin || (to.protocol !== "https:" && to.protocol !== "http:")) return null;
  if (to.pathname === here.pathname && to.search === here.search) return null;
  return to.href;
}
