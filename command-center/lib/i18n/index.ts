import { en } from "./en";
import { ru } from "./ru";
import { uz } from "./uz";
import type { Locale } from "./core";

export { DEFAULT_LOCALE, LOCALES, LOCALE_COOKIE, fmt, isLocale, type Locale } from "./core";

/** The dictionary shape — English is the source of truth; ru/uz must match. */
export type Dictionary = typeof en;

export const dictionaries: Record<Locale, Dictionary> = { en, ru, uz };

export function getDictionaryFor(locale: Locale): Dictionary {
  return dictionaries[locale] ?? en;
}
