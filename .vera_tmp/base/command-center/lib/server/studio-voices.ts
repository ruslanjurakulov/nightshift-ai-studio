import "server-only";
import { listAllVoices, readAccountPlan, type AccountPlan, type PickerVoice } from "@/lib/elevenlabsVoices";
import { VOICE_ID_RE } from "@/lib/creative/operations";

/**
 * The platform ElevenLabs account's voices for the Studio's speech picker, read through the paginated list
 * (lib/elevenlabsVoices.ts) with the account's plan beside them, and kept for a few minutes: every member sees the
 * same account, so one read serves everyone. Only a successful voice read is kept; a failure is asked again next
 * time. A plan that could not be read is kept as "unknown" with it, so a key without the user-read permission does
 * not cost a second call on every page open.
 */

const CACHE_MS = 5 * 60 * 1000;

export type StudioVoices =
  | { ok: true; voices: PickerVoice[]; truncated: boolean; plan: AccountPlan }
  | { ok: false; error: "elevenlabs_unreachable" | "elevenlabs_unavailable" | "key_rejected" };

let cached: { at: number; value: Extract<StudioVoices, { ok: true }> } | null = null;

/** The kept read, when it is fresh. */
export function cachedStudioVoices(now = Date.now()): Extract<StudioVoices, { ok: true }> | null {
  return cached && now - cached.at < CACHE_MS ? cached.value : null;
}

export async function readStudioVoices(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<StudioVoices> {
  const [result, plan] = await Promise.all([listAllVoices(apiKey, fetchImpl), readAccountPlan(apiKey, fetchImpl)]);
  if (!result.ok) return { ok: false, error: result.error };
  // The worker refuses any id that is not 20 letters and digits (modules/capabilities/audio.py): such a voice is
  // left out here rather than offered and refused after the person pressed Generate.
  const voices = result.voices.filter((v) => VOICE_ID_RE.test(v.voiceId));
  const value = { ok: true as const, voices, truncated: result.truncated, plan };
  cached = { at: Date.now(), value };
  return value;
}

/** Tests only: forget the kept read. */
export function resetStudioVoicesCache() {
  cached = null;
}
