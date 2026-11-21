import type { Locale } from "@/lib/i18n/core";
import { siteCarouselEn, type SiteCarouselDictionary } from "./en";
import { siteCarouselRu } from "./ru";
import { siteCarouselUz } from "./uz";

const BY_LOCALE: Record<Locale, SiteCarouselDictionary> = { en: siteCarouselEn, ru: siteCarouselRu, uz: siteCarouselUz };

/**
 * The carousel's, the picture-to-video slider's and the ticker's words in the page's language. Looked up by locale rather than
 * hung off the site dictionary so those pieces add no line to the shared dictionaries other landing work is editing.
 */
export function siteCarouselCopy(locale: Locale): SiteCarouselDictionary {
  return BY_LOCALE[locale] ?? siteCarouselEn;
}

export type { SiteCarouselDictionary };
