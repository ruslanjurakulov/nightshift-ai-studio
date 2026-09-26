import type { Locale } from "@/lib/i18n";
import type { LegalTexts } from "./types";
import { en } from "./en";
import { ru } from "./ru";
import { uz } from "./uz";

export type { LegalBlock, LegalDocument, LegalSection, LegalTexts } from "./types";

export const LEGAL_TEXTS: Record<Locale, LegalTexts> = { en, ru, uz };

export function getLegalTexts(locale: Locale): LegalTexts {
  return LEGAL_TEXTS[locale] ?? en;
}
