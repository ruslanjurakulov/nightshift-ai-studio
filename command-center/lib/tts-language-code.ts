/**
 * A stored language ("Uzbek", "uz_UZ", "Oʻzbek", "Ўзбек") as uz / ru / en: what the Create form needs in the browser to
 * switch off a narration model as the language is typed. Vendor-neutral on purpose; the table of which vendor model speaks
 * which language is lib/ttsLanguages.ts (server-only). tests/test_tts_languages.py holds the spellings below equal to
 * modules/tts_languages.LANGUAGE_NAMES.
 */

export const VERIFIED_TTS_LANGUAGES = ["uz", "ru", "en"] as const;
export type VerifiedTtsLanguage = (typeof VERIFIED_TTS_LANGUAGES)[number];

// What a person calls the language, keyed after foldLanguage(). One entry per line in this exact
// shape: the Python test reads it and holds it equal to modules/tts_languages.LANGUAGE_NAMES.
export const TTS_LANGUAGE_NAMES_BY_SPELLING: Readonly<Record<string, VerifiedTtsLanguage>> = {
  "english": "en",
  "russian": "ru",
  "русский": "ru",
  "uzbek": "uz",
  "uzbekcha": "uz",
  "o'zbek": "uz",
  "o'zbekcha": "uz",
  "ozbek": "uz",
  "ozbekcha": "uz",
  "ўзбек": "uz",
  "ўзбекча": "uz",
  "узбек": "uz",
  "узбекча": "uz",
  "узбекский": "uz",
};

// Every apostrophe-like character people type in O'zbek: ' ’ ʼ ʻ ‘ ` and the prime.
const APOSTROPHES = /[\u0027\u2019\u02bc\u02bb\u2018\u0060\u2032]/g;
const TAG_ALIASES: Record<string, string> = { uzb: "uz", uzn: "uz", rus: "ru", eng: "en" };

export function foldLanguage(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase().replace(APOSTROPHES, "'");
}

/**
 * uz / ru / en from a stored language ("Uzbek", "uz", "uz_UZ", "Oʻzbek", "O’zbek", "Ўзбек"), else null.
 * A miss lets the model through, so a spelling people really use must not miss.
 */
export function ttsLanguageCode(language: unknown): VerifiedTtsLanguage | null {
  if (typeof language !== "string") return null;
  const value = foldLanguage(language);
  if (!value) return null;
  let code: string | undefined;
  if (/^[a-z]{2,3}([-_][a-z0-9]{2,8})*$/.test(value)) {
    const primary = value.split(/[-_]/)[0];
    code = TAG_ALIASES[primary] ?? primary;
  } else {
    const names = TTS_LANGUAGE_NAMES_BY_SPELLING;
    code = names[value] ?? names[value.split(" (")[0].split(" ")[0]];
  }
  return (VERIFIED_TTS_LANGUAGES as readonly string[]).includes(code ?? "") ? (code as VerifiedTtsLanguage) : null;
}

/** The language's own name, for the reason beside a switched-off model. Not translated, like the language picker. */
export const TTS_LANGUAGE_NAMES: Record<VerifiedTtsLanguage, string> = { uz: "Oʻzbek", ru: "Русский", en: "English" };
