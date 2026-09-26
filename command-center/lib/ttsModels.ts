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

/**
 * ElevenLabs premade voices offered on the Create page. Any other voice from
 * the account's Voice Library works too: paste its id ("Custom voice id").
 * The pipeline checks the chosen voice with ElevenLabs before it spends
 * anything (audio_mixer.verify_voice), so a wrong id stops the run early.
 */
export interface Voice {
  id: string;
  name: string;
  style: string;
}

export const VOICES: readonly Voice[] = [
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", style: "deep, narration" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian", style: "deep, calm narrator" },
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", style: "warm British storyteller" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", style: "British, news" },
  { id: "TX3LPaxmHKxFdv7VOQHJ", name: "Liam", style: "young, energetic" },
  { id: "cjVigY5qzO86Huf0OWal", name: "Eric", style: "smooth, friendly" },
  { id: "iP95p4xoKVk53GoZ742B", name: "Chris", style: "casual, conversational" },
  { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger", style: "confident, laid-back" },
  { id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum", style: "intense, character" },
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", style: "calm, female narration" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", style: "soft, female news" },
  { id: "XB0fDUnXU5powFXDhCwa", name: "Charlotte", style: "warm, female" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", style: "British, female narration" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", style: "friendly, female" },
  { id: "FGY2WhTYpPnrIDTdsKH5", name: "Laura", style: "upbeat, female" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", style: "expressive, female" },
];

/** An ElevenLabs voice id: 20 letters and digits (the same check the pipeline and 0024 make). */
export function isVoiceId(value: string): boolean {
  return /^[A-Za-z0-9]{20}$/.test(value);
}
