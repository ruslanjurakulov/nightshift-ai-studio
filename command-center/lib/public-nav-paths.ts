import { dictionaries } from "@/lib/i18n";
import { navHrefs, publicNav } from "@/lib/public-nav";

/** The header's own links beside the menu: the wordmark, Sign in and Start free (components/legal/PublicShell.tsx, PublicMenu.tsx). */
export const HEADER_PATHS = ["/", "/login", "/signup"] as const;

/**
 * Every un-prefixed destination the public header draws (the bar, the panels, the phone sheet and the header's own
 * links), each once, as menuHref (lib/public-nav.ts) receives it. The localised paths' check (lib/i18n/locale-path.ts
 * LOCALIZED_PATHS) can be run against this one list. The destinations are the same in every language
 * (tests/public-megamenu.test.tsx), so English stands for all three.
 *
 * Its own module, not lib/public-nav.ts: that one is imported by the header's client components, and this one imports
 * every dictionary.
 */
export function publicMenuPaths(opts: { devPages: boolean }): string[] {
  return [...new Set([...HEADER_PATHS, ...navHrefs(publicNav(dictionaries.en, opts))])];
}
