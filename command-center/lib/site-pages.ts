import { SITEMAP_PATHS } from "@/lib/public-paths";
import { DEV_PAGE_PATHS } from "@/lib/dev-pages";

/**
 * The one list of public, indexable pages. /sitemap.xml and /llms.txt are both
 * built from it, so a page added to (or flag-gated out of) the public site
 * appears in both or in neither: two hand-kept lists drift, and a crawler told
 * about a page that answers the public 404 is worse than one told nothing.
 *
 * `devPages` is the DEV_CLI_PAGE flag (lib/dev-pages.ts): off, /docs/cli and
 * /docs/skills are the public 404 and are not listed.
 */
export function listedPagePaths(devPages: boolean): string[] {
  return devPages ? [...SITEMAP_PATHS, ...DEV_PAGE_PATHS] : [...SITEMAP_PATHS];
}
