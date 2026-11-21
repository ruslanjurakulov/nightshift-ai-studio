import { REFERRAL_PATH, REFUND_PATH, ROADMAP_PATH, SITEMAP_PATHS, TRUST_PATH } from "@/lib/public-paths";
import { DEV_PAGE_PATHS } from "@/lib/dev-pages";

/**
 * The one list of public, indexable pages. /sitemap.xml and /llms.txt are both
 * built from it, so a page added to (or flag-gated out of) the public site
 * appears in both or in neither: two hand-kept lists drift, and a crawler told
 * about a page that answers the public 404 is worse than one told nothing.
 *
 * UNCOUNTED_PAGE_PATHS are public and listed, but outside the page-view counter's closed SQL list (migration 0104),
 * which SITEMAP_PATHS must equal; widening that list needs a migration, so these pages are listed without being counted.
 *
 * `devPages` is the DEV_CLI_PAGE flag (lib/dev-pages.ts): off, /docs/cli and
 * /docs/skills are the public 404 and are not listed.
 */
/** Listed in the sitemap and llms.txt, not counted by the page-view beacon (see above). */
export const UNCOUNTED_PAGE_PATHS = [ROADMAP_PATH, REFUND_PATH, TRUST_PATH, REFERRAL_PATH] as const;

export function listedPagePaths(devPages: boolean): string[] {
  return devPages ? [...SITEMAP_PATHS, ...UNCOUNTED_PAGE_PATHS, ...DEV_PAGE_PATHS] : [...SITEMAP_PATHS, ...UNCOUNTED_PAGE_PATHS];
}
