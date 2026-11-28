import "server-only";
import { modelSpeaks } from "./ttsLanguages";
import { ttsLanguageCode } from "./tts-language-code";
import type { TtsBlock } from "./pipeline-options";

/**
 * ElevenLabs narration models the run queue accepts (modules/run_request.TTS_MODELS).
 * The workflow's `tts_model` options and render_job_params_valid (0025 … 0145) carry the
 * same ids, and tests/ttsModels.test.ts holds them together.
 *
 * Server-only: the vendor's model ids, its labels and which language each speaks are the
 * operator's routing. The Create form imported this module, which put them in a static
 * chunk; the operator's page now gets them as props (lib/server/pipeline-options.ts).
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

/**
 * Why a model cannot be picked for a video in `language`, or null when it can.
 * "language" only on a verified no; an unknown language disables nothing (rule 5: unknown is not no).
 */
export function ttsModelBlock(model: TtsPickerModel, language: unknown): TtsBlock | null {
  if (!isTtsModel(model)) return { reason: "not_on_queue" };
  const code = ttsLanguageCode(language);
  if (code && modelSpeaks(model, code) === false) return { reason: "language", language: code };
  return null;
}
