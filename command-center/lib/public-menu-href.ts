/*
 * The public header's hrefs and its lit-item match, apart from lib/public-nav.ts: the header's client components import
 * these, and lib/public-nav.ts reads the developer pages' dictionary, which must not reach a public page's client bundle
 * (tests/public-bundle-dictionary.test.ts).
 */

/**
 * Where a header, panel or sheet link points, from the plain path the list holds. Every href the public header draws goes
 * through here (tests/public-megamenu.test.tsx checks the three components), so the localised public paths (/ru/…, /uz/…)
 * arrive as a change to this one function: it becomes lib/i18n/locale-path.ts `localeHref(locale, path)`. Identity today.
 * The list itself stays un-prefixed: the tests resolve those paths to route files and to lib/public-paths.ts.
 */
export function menuHref(path: string): string {
  return path;
}

/**
 * The page the visitor is on, as the list's un-prefixed path: what the lit item is matched against. Today the pathname
 * itself; with localised paths it becomes lib/i18n/locale-path.ts `splitLocalePath(pathname).path`.
 */
export function menuPath(pathname: string): string {
  return pathname;
}

/** Is this link the page the visitor is on? A "#section" link is a part of a page, never the page itself. */
export function isCurrentPage(path: string, pathname: string): boolean {
  return !path.includes("#") && path === menuPath(pathname);
}
