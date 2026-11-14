import type { Locale } from "@/lib/i18n";
import { filmStudioEn, type FilmStudioDictionary } from "./en";
import { filmStudioRu } from "./ru";
import { filmStudioUz } from "./uz";

/**
 * Studio → Projects strings by locale. Kept beside the app's dictionaries rather than inside them: the section is dark behind
 * NIGHTSHIFT_FILM_STUDIO and its strings are reached only from it. An unknown locale reads as English.
 */
export const FILM_STUDIO_STRINGS: Record<string, FilmStudioDictionary> = { en: filmStudioEn, ru: filmStudioRu, uz: filmStudioUz };

export function filmStudioStrings(locale: Locale | string): FilmStudioDictionary {
  return FILM_STUDIO_STRINGS[locale] ?? filmStudioEn;
}

export type { FilmStudioDictionary };
