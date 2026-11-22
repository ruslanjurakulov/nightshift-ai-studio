/**
 * ElevenLabs Default voices, which "will expire on December 31, 2026, and they will no longer be accessible after
 * this date" (the page below). A copy of modules/voice_retirement.py, kept equal by tests/test_voice_retirement.py:
 * the run refuses these ids from 1 Jan 2027, so a picker that still offered one would make a person wait for a
 * refusal.
 *
 * Each row carries ElevenLabs' own suggested replacement. It is only ever pointed at inside the account's own voice
 * list (Agents → Voice): marked there when the account has it, said to be missing when it does not. It is never
 * saved, typed or swapped in for the person (rule 4); choosing a replacement is theirs, after listening.
 */

export const DEFAULT_VOICES_URL = "https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-default-voices";
/** The last day a Default voice works, as the page says it. */
export const DEFAULT_EXPIRES = "2026-12-31";

export type DefaultVoice = { name: string; suggested: string; suggestedId: string };

/** Default voice id -> its old name and ElevenLabs' suggested replacement (name and id). */
export const DEFAULT_VOICES: Readonly<Record<string, DefaultVoice>> = {
  CwhRBWXzGAHq8TQ4Fs17: { name: "Roger", suggested: "Darian - Warm Grounded Storyteller", suggestedId: "gOupLcAkjEnguROwi4oS" },
  EXAVITQu4vr4xnSDxMaL: { name: "Sarah", suggested: "Talia - Warm Soft Guide", suggestedId: "OZ0L6eISlOejga3XjDFt" },
  FGY2WhTYpPnrIDTdsKH5: { name: "Laura", suggested: "Elara - Crisp Pro Narrator", suggestedId: "WQP7cQUF5aAS6Axh5yaa" },
  IKne3meq5aSn9XLyUdCD: { name: "Charlie", suggested: "Baxter - Dry Calm Aussie", suggestedId: "jSuBIjxMKhqIfb0wCK1F" },
  JBFqnCBsd6RMkjVDRZzb: { name: "George", suggested: "Eldrin - Crisp British Baritone", suggestedId: "6WwXjDDEMyNmFG95zycZ" },
  N2lVS1w4EtoT3dr4eOWO: { name: "Callum", suggested: "Callum - Husky Trickster", suggestedId: "fs2OqxduwXgp9foh2xjK" },
  SAz9YHcvj6GT2YYXdXww: { name: "River", suggested: "Elowen - Upbeat Modern Narrator", suggestedId: "dvbL7qkNGZY1IqPGZAjM" },
  SOYHLrjzK2X1ezoPC6cr: { name: "Harry", suggested: "Kaelen - Amateur Warrior", suggestedId: "10NkTYmU7tSz3Kkl3Lex" },
  TX3LPaxmHKxFdv7VOQHJ: { name: "Liam", suggested: "Lawrence - Bright and Informative", suggestedId: "ktkP7Nsj67dw2zcplQYt" },
  Xb7hH8MSUJpSbSDYk0k2: { name: "Alice", suggested: "Alicia - Polished Global Anchor", suggestedId: "BFd5oBc2DDna33pSi4Gf" },
  XrExE9yKIg1WjnnlVkGX: { name: "Matilda", suggested: "Maisie - Friendly Casual Neighbor", suggestedId: "QtY3JBOUKEB5xzrRfOKc" },
  bIHbv24MWmeRgasZH58o: { name: "Will", suggested: "Warren - Effortless and Cool", suggestedId: "7QN34D2r3hCNwbOYIeK0" },
  cgSgspJ2msm6clMCkdW9: { name: "Jessica", suggested: "Jade - Upbeat and Natural", suggestedId: "g7LVvkPWALzPxOQbF6OE" },
  cjVigY5qzO86Huf0OWal: { name: "Eric", suggested: "Eddie - Natural and Helpful", suggestedId: "l7kNoIfnJKPg7779LI2t" },
  iP95p4xoKVk53GoZ742B: { name: "Chris", suggested: "Caleb - Trusted Guide", suggestedId: "AaOhDHYJ1XLZk74lXhdE" },
  nPczCjzI2devNBz1zQrb: { name: "Brian", suggested: "Sawyer - Midnight Storyteller", suggestedId: "8dEUmyPMdDdK91vboYih" },
  onwK4e9ZLuTAKqWW03F9: { name: "Daniel", suggested: "Finley - Articulate Anchor", suggestedId: "fnYMz3F5gMEDGMWcH1ex" },
  pFZP5JQG7iQjIQuC4Bku: { name: "Lily", suggested: "Florence - Atmospheric Storyteller", suggestedId: "22N9cF8z0o7y23njdyaY" },
  pqHfZKP75CvOlQylNhV4: { name: "Bill", suggested: "Wyatt - Seasoned Mentor", suggestedId: "FrS6cKLB1wg4WYgPa9GW" },
};

// Compared as UTC calendar days, the same as the run (modules/voice_retirement.utc_today): a browser in Tashkent
// must not hide a voice the scheduled run would still accept, or offer one it already refuses.
const utcDay = (now: Date) => now.toISOString().slice(0, 10);

const own = (id: unknown): string => (typeof id === "string" ? id.trim() : "");

export function defaultVoice(id: unknown): DefaultVoice | null {
  const key = own(id);
  return key && Object.prototype.hasOwnProperty.call(DEFAULT_VOICES, key) ? DEFAULT_VOICES[key] : null;
}

export function isDefaultVoice(id: unknown): boolean {
  return defaultVoice(id) !== null;
}

export type Retirement = "retired" | "leaving";

/** "retired": the run refuses it today. "leaving": it still works, until DEFAULT_EXPIRES. null: no retirement known. */
export function voiceRetirement(id: unknown, now: Date): Retirement | null {
  if (!isDefaultVoice(id)) return null;
  return utcDay(now) > DEFAULT_EXPIRES ? "retired" : "leaving";
}

/** The voices a picker may still offer today: a retired one is hidden, not replaced. */
export function offeredVoices<V extends { id: string }>(voices: readonly V[], now: Date): V[] {
  return voices.filter((v) => voiceRetirement(v.id, now) !== "retired");
}

export type ChannelVoiceNotice = { slot: "narrator" | "quote" | "both"; id: string; state: Retirement } & DefaultVoice;

/**
 * The channel's saved ElevenLabs voices that are Default voices, narrator first; one notice ("both") when the narrator and
 * the quote voice are the same voice. An Edge channel has none: its voice is not an ElevenLabs id. "narrator" as the quote
 * voice is the narrator's voice, already covered.
 *
 * Only what the channel row says is judged. A run also falls back to deployment settings the browser cannot see
 * (config.ELEVENLABS_VOICE_ID / ELEVENLABS_SECONDARY_VOICE_ID when a channel has none, config.TTS_PROVIDER when it names no
 * provider), so a channel that saved nothing gets no notice here; the run's own preflight still refuses a retired fallback.
 */
export function channelVoiceNotices(
  cfg: { tts_provider?: string; elevenlabs_voice_id?: string; elevenlabs_secondary_voice_id?: string } | null | undefined,
  now: Date,
): ChannelVoiceNotice[] {
  if (!cfg || cfg.tts_provider === "edge") return [];
  const narrator = own(cfg.elevenlabs_voice_id);
  const quote = own(cfg.elevenlabs_secondary_voice_id);
  const out: ChannelVoiceNotice[] = [];
  const add = (slot: ChannelVoiceNotice["slot"], id: string) => {
    const row = defaultVoice(id);
    const state = voiceRetirement(id, now);
    if (row && state) out.push({ slot, id, state, ...row });
  };
  if (narrator && narrator === quote) add("both", narrator);
  else {
    add("narrator", narrator);
    add("quote", quote);
  }
  return out;
}

/**
 * Whether ElevenLabs' suggestion can be pointed at: "in" only when the account's own list (read through the
 * server-side voices route) has that id, "missing" when the list was read and lacks it, "unknown" before it is read.
 */
export function suggestionInAccount(notice: { suggestedId: string }, accountVoiceIds: readonly string[] | null): "in" | "missing" | "unknown" {
  if (accountVoiceIds === null) return "unknown";
  return accountVoiceIds.includes(notice.suggestedId) ? "in" : "missing";
}
