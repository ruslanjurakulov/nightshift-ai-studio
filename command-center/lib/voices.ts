import voices from "./voices.json";

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
