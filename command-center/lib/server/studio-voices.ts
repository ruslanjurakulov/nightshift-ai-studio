import "server-only";
import { listAllVoices, type PickerVoice, type VoiceListResult } from "@/lib/elevenlabsVoices";
import { VOICE_ID_RE } from "@/lib/creative/operations";

/**
 * The platform ElevenLabs account's voices for the Studio's speech picker, read through the paginated list
 * (lib/elevenlabsVoices.ts) and kept for a few minutes: every member sees the same account's list, so one read
 * serves everyone. Only a successful read is kept; a failure is asked again next time.
 */

const CACHE_MS = 5 * 60 * 1000;
let cached: { at: number; voices: PickerVoice[]; truncated: boolean } | null = null;

export type StudioVoices = Extract<VoiceListResult, { ok: true }>;

/** The kept read, when it is fresh. */
export function cachedStudioVoices(now = Date.now()): StudioVoices | null {
  return cached && now - cached.at < CACHE_MS ? { ok: true, voices: cached.voices, truncated: cached.truncated } : null;
}

export async function readStudioVoices(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<VoiceListResult> {
  const result = await listAllVoices(apiKey, fetchImpl);
  if (!result.ok) return result;
  // The worker refuses any id that is not 20 letters and digits (modules/capabilities/audio.py): such a voice is
  // left out here rather than offered and refused after the person pressed Generate.
  const voices = result.voices.filter((v) => VOICE_ID_RE.test(v.voiceId));
  cached = { at: Date.now(), voices, truncated: result.truncated };
  return { ok: true, voices, truncated: result.truncated };
}

/** Tests only: forget the kept read. */
export function resetStudioVoicesCache() {
  cached = null;
}
