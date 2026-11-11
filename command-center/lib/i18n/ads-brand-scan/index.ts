import type { Locale } from "@/lib/i18n";
import { adsBrandScanEn, type AdsBrandScanDictionary } from "./en";
import { adsBrandScanRu } from "./ru";
import { adsBrandScanUz } from "./uz";

/**
 * The brand scan panel's strings by locale. Kept beside the app's dictionaries rather than inside them: the panel is dark behind
 * NIGHTSHIFT_ADS_BRAND_SCAN, and its strings are reached only from it. An unknown locale reads as English.
 */
export const ADS_BRAND_SCAN_STRINGS: Record<string, AdsBrandScanDictionary> = { en: adsBrandScanEn, ru: adsBrandScanRu, uz: adsBrandScanUz };

export function brandScanStrings(locale: Locale | string): AdsBrandScanDictionary {
  return ADS_BRAND_SCAN_STRINGS[locale] ?? adsBrandScanEn;
}

export type { AdsBrandScanDictionary };
