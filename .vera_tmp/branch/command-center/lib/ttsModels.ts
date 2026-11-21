import voices from "./voices.json";
import { modelSpeaks, ttsLanguageCode, type VerifiedTtsLanguage } from "./ttsLanguages";

/**
 * ElevenLabs narration models the run queue accepts (modules/run_request.TTS_MODELS).
 * The workflow's `tts_model` options and render_job_params_valid (0025 … 0145) carry the
 * same ids, and tests/ttsModels.test.ts holds them together.
 */
export const TTS_MODELS = [
  "eleven_v3",
  "eleven_multilingual_v2",
  "eleven_flash_v2_5",
  "eleven_turbo_v2_5",
] as const;

export type TtsModel = (typeof TTS_MODELS)[number];

/**
 * What the picker lists. eleven_v4 is ElevenLabs' newest model and speaks Uzbek, but it is
 * shown switched off. Neither the queue check (render_job_params_valid) nor the workflow's
 * choice list accepts it yet, so choosing it would only fail at the database. It stays
 * off until a migration adds it there (see the PR that added this line).
 */
export const TTS_PICKER_MODELS = ["eleven_v4", ...TTS_MODELS] as const;
export type TtsPickerModel = (typeof TTS_PICKER_MODELS)[number];

/** Models ElevenLabs marks deprecated. Turbo v2.5 is equivalent to Flash v2.5 (docs/overview/models, 2026-11-14). */
export const DEPRECATED_TTS_MODELS: readonly TtsPickerModel[] = ["eleven_turbo_v2_5"];

/** The label names the trade-off, since the ids alone don't say it. Model names are not translated. */
export const TTS_MODEL_LABELS: Record<TtsPickerModel, string> = {
  eleven_v4: "Eleven v4 — most expressive, speaks Uzbek",
  eleven_v3: "Eleven v3 — expressive, speaks Uzbek",
  eleven_multilingual_v2: "Multilingual v2 — steady narration",
  eleven_flash_v2_5: "Flash v2.5 — fastest, cheapest",
  eleven_turbo_v2_5: "Turbo v2.5 — equivalent to Flash v2.5",
};

export function isTtsModel(value: string): value is TtsModel {
  return (TTS_MODELS as readonly string[]).includes(value);
}

/** The language's own name, for the reason beside a switched-off model. Not translated, like the language picker. */
export const TTS_LANGUAGE_NAMES: Record<VerifiedTtsLanguage, string> = { uz: "Oʻzbek", ru: "Русский", en: "English" };

/**
 * Why a model cannot be picked for a video in `language`, or null when it can.
 * "language" only on a verified no; an unknown language disables nothing (rule 5: unknown is not no).
 */
export function ttsModelBlock(model: TtsPickerModel, language: unknown): { reason: "not_on_queue" } | { reason: "language"; language: VerifiedTtsLanguage } | null {
  if (!isTtsModel(model)) return { reason: "not_on_queue" };
  const code = ttsLanguageCode(language);
  if (code && modelSpeaks(model, code) === false) return { reason: "language", language: code };
  return null;
}

/**
 * ElevenLabs premade voices offered on the Create page (lib/voices.json, which
 * tools/voice_previews.py reads too, to prepare their preview clips). Any other voice from
 * the account's Voice Library works too: paste its id ("Custom voice id").
 * The pipeline checks the chosen voice with ElevenLabs before it spends
 * anything (audio_mixer.verify_voice), so a wrong id stops the run early.
 */
export interface Voice {
  id: string;
  name: string;
  style: string;
}

export const VOICES: readonly Voice[] = voices;

/** An ElevenLabs voice id: 20 letters and digits (the same check the pipeline and 0024 make). */
export function isVoiceId(value: string): boolean {
  return /^[A-Za-z0-9]{20}$/.test(value);
}
