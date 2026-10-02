import { preload } from "react-dom";
import type { Locale } from "@/lib/i18n/core";
import { PUBLIC_FONT_PATHS } from "@/lib/public-paths";

/**
 * A Russian page sets its headline and body in Cyrillic, which next/font loads
 * only once the page has been laid out (the subset sits behind a unicode-range)
 * — late enough to reflow the hero (CLS ≈ 0.07 at 1440, 0.22 on a phone). So a
 * Russian page preloads the two Cyrillic faces it will use, from public/fonts
 * (declared in components/site/site.css). Other languages preload nothing more.
 */
export function preloadSiteFonts(locale: Locale) {
  if (locale !== "ru") return;
  for (const href of PUBLIC_FONT_PATHS) preload(href, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
}
