/**
 * Whether a click on a link will make this tab go to another page. A key shows "loading" only then: a ctrl/cmd/shift/alt or
 * middle click opens a new tab or window, a `target` or `download` link leaves this tab alone, another origin is not ours to
 * vouch for, and a link to this very page (or a hash on it) scrolls rather than loads. In any of those cases a spinner would
 * spin over a page that is not going anywhere.
 */
export function willNavigate(
  e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  a: Pick<HTMLAnchorElement, "href" | "target" | "hasAttribute">,
  here: { origin: string; pathname: string; search: string },
): boolean {
  // (No defaultPrevented check: this runs in the capture phase, before any handler could cancel the click.)
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  if ((a.target && a.target !== "_self") || a.hasAttribute("download")) return false;
  let to: URL;
  try {
    to = new URL(a.href, here.origin);
  } catch {
    return false;
  }
  if (to.origin !== here.origin) return false;
  return to.pathname !== here.pathname || to.search !== here.search;
}
