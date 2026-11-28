import "server-only";
import { ttsLanguageCode, type VerifiedTtsLanguage } from "@/lib/tts-language-code";

/**
 * Which ElevenLabs model speaks which language. This is the Command Center's copy of
 * modules/tts_languages.py, and tests/test_tts_languages.py keeps the two tables equal.
 *
 * Source: https://elevenlabs.io/docs/overview/models, read 2026-11-14. Only uz, ru and
 * en were verified for each model. Any other language is unknown here, and unknown is
 * not "no": the picker disables a model only for a verified "no".
 *
 * Server-only: the table is keyed by the vendor's model ids and sat in a public chunk.
 * The operator's Create form gets each model's languages as props
 * (lib/server/pipeline-options.ts); how a person writes a language, which the form
 * needs live as it is typed, is lib/tts-language-code.ts.
 */

export const TTS_LANGUAGE_SOURCE = "https://elevenlabs.io/docs/overview/models";
export const TTS_LANGUAGE_READ_ON = "2026-11-14";

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

/** true / false when both the model and the language were verified; null when either is unknown. */
export function modelSpeaks(model: string, language: unknown): boolean | null {
  const code = ttsLanguageCode(language);
  const langs = TTS_MODEL_LANGUAGES[model];
  if (!code || !langs) return null;
  return langs.includes(code);
}
