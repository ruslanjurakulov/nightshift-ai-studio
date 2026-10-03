import { LOCALES, DEFAULT_LOCALE, type Locale } from "./core";
import { dictionaries, type Dictionary } from "./index";
import { devEn, type DevDictionary } from "./site/dev-en";
import { devRu } from "./site/dev-ru";
import { devUz } from "./site/dev-uz";

export type { DevDictionary };

/** The developer pages' copy by language (English is the source of truth). */
export const devDictionaries: Record<Locale, DevDictionary> = { en: devEn, ru: devRu, uz: devUz };

export function getDevDictionary(locale: Locale): DevDictionary {
  return devDictionaries[locale] ?? devEn;
}

/**
 * The developer pages' words for a dictionary a component was handed (the
 * public shell and footer get `t`, not a locale): found by identity, the way
 * the shell already picks its font preload.
 */
export function devFor(t: Dictionary): DevDictionary {
  const code = LOCALES.find((l) => dictionaries[l.code] === t)?.code ?? DEFAULT_LOCALE;
  return getDevDictionary(code);
}
