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
};

const NAMES: Record<string, VerifiedTtsLanguage> = {
  english: "en",
  russian: "ru",
  uzbek: "uz",
  "o'zbek": "uz",
  "oʻzbek": "uz",
  "o‘zbek": "uz",
  ozbek: "uz",
  "o'zbekcha": "uz",
  "oʻzbekcha": "uz",
  русский: "ru",
  узбекский: "uz",
};

/** uz / ru / en from a stored language ("Uzbek", "uz", "uz-Latn"), else null (not one this table verified). */
export function ttsLanguageCode(language: unknown): VerifiedTtsLanguage | null {
  if (typeof language !== "string") return null;
  const value = language.trim().replace(/\s+/g, " ").toLowerCase();
  if (!value) return null;
  const tag = /^([a-z]{2,3})(-[a-z0-9]{2,8})*$/.exec(value);
  const code = tag ? ({ uzb: "uz", uzn: "uz", rus: "ru", eng: "en" } as Record<string, string>)[tag[1]] ?? tag[1] : NAMES[value] ?? NAMES[value.split(" (")[0].split(" ")[0]];
  return (VERIFIED_TTS_LANGUAGES as readonly string[]).includes(code ?? "") ? (code as VerifiedTtsLanguage) : null;
}

/** true / false when both the model and the language were verified; null when either is unknown. */
export function modelSpeaks(model: string, language: unknown): boolean | null {
  const code = ttsLanguageCode(language);
  const langs = TTS_MODEL_LANGUAGES[model];
  if (!code || !langs) return null;
  return langs.includes(code);
}
