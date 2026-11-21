/**
 * Which ElevenLabs model speaks which language. This is the Command Center's copy of
 * modules/tts_languages.py, and tests/test_tts_languages.py keeps the two tables equal.
 *
 * Source: https://elevenlabs.io/docs/overview/models, read 2026-11-14. Only uz, ru and
 * en were verified for each model. Any other language is unknown here, and unknown is
 * not "no": the picker disables a model only for a verified "no".
 */

export const TTS_LANGUAGE_SOURCE = "https://elevenlabs.io/docs/overview/models";
export const TTS_LANGUAGE_READ_ON = "2026-11-14";

export const VERIFIED_TTS_LANGUAGES = ["uz", "ru", "en"] as const;
export type VerifiedTtsLanguage = (typeof VERIFIED_TTS_LANGUAGES)[number];

// One model per line, in this exact shape: the Python test reads this block.
export const TTS_MODEL_LANGUAGES: Readonly<Record<string, readonly VerifiedTtsLanguage[]>> = {
  eleven_v4: ["uz", "ru", "en"],
  eleven_v4_turbo: ["uz", "ru", "en"],
  eleven_v3: ["uz", "ru", "en"],
  eleven_v3_conversational: ["uz", "ru", "en"],
  eleven_ttv_v3: ["uz", "ru", "en"],
  eleven_multilingual_v2: ["ru", "en"],
  eleven_flash_v2_5: ["ru", "en"],
  eleven_turbo_v2_5: ["ru", "en"],
  eleven_multilingual_sts_v2: ["ru", "en"],
  eleven_multilingual_ttv_v2: ["ru", "en"],
  // Gemini API TTS: "Northern Uzbek", Russian, English ticked on aistudio.google.com/docs/speech-generation (read 2026-11-21).
  "gemini-3.8-flash-tts": ["uz", "ru", "en"],
  "gemini-3.8-flash-lite-tts": ["uz", "ru", "en"],
};

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

/** true / false when both the model and the language were verified; null when either is unknown. */
export function modelSpeaks(model: string, language: unknown): boolean | null {
  const code = ttsLanguageCode(language);
  const langs = TTS_MODEL_LANGUAGES[model];
  if (!code || !langs) return null;
  return langs.includes(code);
}
