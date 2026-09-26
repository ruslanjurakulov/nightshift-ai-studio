/**
 * ElevenLabs narration models the pipeline accepts (config.ELEVENLABS_MODELS).
 * The workflow's `tts_model` options and migration 0024 carry the same ids.
 * The label names the trade-off, since the ids alone don't say it.
 */
export const TTS_MODELS = [
  "eleven_v3",
  "eleven_multilingual_v2",
  "eleven_flash_v2_5",
  "eleven_turbo_v2_5",
] as const;

export type TtsModel = (typeof TTS_MODELS)[number];

export const TTS_MODEL_LABELS: Record<TtsModel, string> = {
  eleven_v3: "Eleven v3 — most expressive",
  eleven_multilingual_v2: "Multilingual v2 — steady narration",
  eleven_flash_v2_5: "Flash v2.5 — fastest, cheapest",
  eleven_turbo_v2_5: "Turbo v2.5 — fast, balanced",
};

export function isTtsModel(value: string): value is TtsModel {
  return (TTS_MODELS as readonly string[]).includes(value);
}
