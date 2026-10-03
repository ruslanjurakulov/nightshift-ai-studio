import { preload } from "react-dom";
import type { Locale } from "@/lib/i18n/core";
import { CRITICAL_FONT_PATHS } from "@/lib/public-paths";

/**
 * Every page preloads the Latin file of the one typeface (app/fonts.css), and a
 * Russian page the Cyrillic one too: left to the unicode-range rule alone, the
 * browser finds out it needs Cyrillic only after layout, and the swap reflowed
 * the hero. English and Uzbek (Latin, with oʻ gʻ in the same file) preload one
 * file of 34 KB; Russian two, 50 KB in all.
 */
export function preloadFonts(locale: Locale) {
  for (const href of CRITICAL_FONT_PATHS[locale]) preload(href, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
}

/** The public shells' original name for the same call; kept so they need no edit. */
export const preloadSiteFonts = preloadFonts;
