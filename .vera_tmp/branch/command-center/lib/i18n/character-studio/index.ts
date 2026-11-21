import type { Locale } from "@/lib/i18n";
import { characterStudioEn, type CharacterStudioDictionary } from "./en";
import { characterStudioRu } from "./ru";
import { characterStudioUz } from "./uz";

/**
 * Character Studio's strings by locale. Kept beside the app's dictionaries rather than inside them: the studio is dark behind
 * NIGHTSHIFT_CHARACTER_STUDIO, and its strings are reached only from it. An unknown locale reads as English.
 */
export const CHARACTER_STUDIO_STRINGS: Record<string, CharacterStudioDictionary> = { en: characterStudioEn, ru: characterStudioRu, uz: characterStudioUz };

export function characterStudioStrings(locale: Locale | string): CharacterStudioDictionary {
  return CHARACTER_STUDIO_STRINGS[locale] ?? characterStudioEn;
}

export type { CharacterStudioDictionary };
