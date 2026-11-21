/**
 * Channel DNA (migration 0056) — the pure, client-safe half.
 *
 * A channel's DNA is its look and voice in one place: a default style kit
 * (0047), default characters (0047), the narrator voice, the script language,
 * a default format (long / Shorts) and aspect, and one line of tone. It only
 * PRE-FILLS: the Studio panel and the Run now form start from it, and the
 * person can change anything per job. Setting it spends nothing and starts
 * nothing.
 *
 * Where each part lives (existing columns reused, see the migration header):
 *   style kit   channels.default_style_kit_id
 *   characters  channel_dna_characters
 *   voice       channels.agent_config.elevenlabs_voice_id  (the pipeline's key)
 *   language    channels.agent_config.language             ('Uzbek' | 'Russian' | 'English')
 *   format      channels.dna_format
 *   aspect      channels.dna_aspect
 *   tone        channels.dna_tone
 *
 * The database (set_channel_dna) is the authority on every rule here; this
 * file checks the same rules first so the form can say what is wrong, shapes
 * a channel row into DNA, and turns DNA into each form's starting values.
 * Unit-tested in tests/channel-dna.test.ts.
 */
import { HOME_LANGUAGES } from "@/lib/home";
import { VOICES } from "@/lib/ttsModels";
import { charLength, parseChannelRef, parseStyleId } from "@/lib/style-kits";
import type { StudioPrefill } from "@/lib/creative/studio";
import type { ChannelRow } from "@/lib/types";

export const DNA_FORMATS = ["long", "shorts"] as const;
export type DnaFormat = (typeof DNA_FORMATS)[number];

/** The Studio's own aspect ratios (lib/creative/studio ASPECT_RATIOS), and 0056's check. */
export const DNA_ASPECTS = ["16:9", "9:16", "1:1"] as const;
export type DnaAspect = (typeof DNA_ASPECTS)[number];

export const DNA_LANGUAGES = ["uz", "ru", "en"] as const;
export type DnaLanguage = (typeof DNA_LANGUAGES)[number];

export const DNA_LIMITS = { maxCharacters: 8, toneMax: 200 } as const;

const VOICE_RE = /^[A-Za-z0-9]{20}$/;

/** What a channel's DNA card shows and every form starts from. */
export interface ChannelDna {
  styleKitId: string | null;
  characterIds: string[];
  /** The narrator voice id as the pipeline reads it, or null when none is set. */
  voiceId: string | null;
  /** uz / ru / en when the channel's language is one of them, else null. */
  language: DnaLanguage | null;
  /** The language as stored, for display when it is none of the three ("Arabic"). */
  languageRaw: string;
  format: DnaFormat | null;
  aspect: DnaAspect | null;
  tone: string;
}

export const EMPTY_DNA: ChannelDna = {
  styleKitId: null,
  characterIds: [],
  voiceId: null,
  language: null,
  languageRaw: "",
  format: null,
  aspect: null,
  tone: "",
};

export function isDnaFormat(v: unknown): v is DnaFormat {
  return typeof v === "string" && (DNA_FORMATS as readonly string[]).includes(v);
}

export function isDnaAspect(v: unknown): v is DnaAspect {
  return typeof v === "string" && (DNA_ASPECTS as readonly string[]).includes(v);
}

export function isDnaLanguage(v: unknown): v is DnaLanguage {
  return typeof v === "string" && (DNA_LANGUAGES as readonly string[]).includes(v);
}

/** 'Uzbek' -> 'uz' (the pipeline's value -> DNA's code), or null. */
export function languageCode(stored: unknown): DnaLanguage | null {
  if (typeof stored !== "string") return null;
  const hit = HOME_LANGUAGES.find((l) => l.value.toLowerCase() === stored.trim().toLowerCase());
  return hit ? hit.id : null;
}

/** 'uz' -> 'Uzbek': what the run form and the pipeline read. */
export function languageValue(code: DnaLanguage): string {
  return HOME_LANGUAGES.find((l) => l.id === code)?.value ?? "English";
}

/** The language's own name ("O'zbek"), the same in every locale. */
export function languageLabel(code: DnaLanguage): string {
  return HOME_LANGUAGES.find((l) => l.id === code)?.label ?? code;
}

/** One premade voice (the Studio's and the run form's list), or null for a custom id. */
export function knownVoice(id: string | null | undefined): { id: string; name: string; style: string } | null {
  return id ? (VOICES.find((v) => v.id === id) ?? null) : null;
}

/** A tone as 0056 stores it: one line, control characters removed, trimmed. */
export function cleanTone(raw: unknown): string {
  return (typeof raw === "string" ? raw : "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/**
 * A channel row (select *, RLS) plus its character rows -> DNA. Anything the
 * database would refuse reads as unset rather than being guessed at; a row
 * from before 0056 is simply empty DNA.
 */
export function dnaFromChannel(
  row: Pick<ChannelRow, "agent_config" | "default_style_kit_id" | "dna_format" | "dna_aspect" | "dna_tone"> | null | undefined,
  characterIds: readonly string[] = [],
): ChannelDna {
  if (!row) return EMPTY_DNA;
  const agent = row.agent_config ?? {};
  const voice = typeof agent.elevenlabs_voice_id === "string" && VOICE_RE.test(agent.elevenlabs_voice_id) ? agent.elevenlabs_voice_id : null;
  const languageRaw = typeof agent.language === "string" ? agent.language.trim() : "";
  return {
    styleKitId: parseStyleId(row.default_style_kit_id),
    characterIds: characterIds.filter((id) => parseStyleId(id)).slice(0, DNA_LIMITS.maxCharacters),
    voiceId: voice,
    language: languageCode(languageRaw),
    languageRaw,
    format: isDnaFormat(row.dna_format) ? row.dna_format : null,
    aspect: isDnaAspect(row.dna_aspect) ? row.dna_aspect : null,
    tone: cleanTone(row.dna_tone).slice(0, DNA_LIMITS.toneMax),
  };
}

/** channel_dna_characters rows -> channel id -> character ids in order. */
export function characterIdsByChannel(data: unknown): Map<string, string[]> {
  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  const sorted = rows
    .filter((r) => typeof r?.channel_id === "string" && parseStyleId(r.character_id))
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
  const out = new Map<string, string[]>();
  for (const r of sorted) {
    const list = out.get(r.channel_id as string) ?? [];
    list.push(r.character_id as string);
    out.set(r.channel_id as string, list);
  }
  return out;
}

/** Has the channel set anything a form could start from? */
export function hasDna(d: ChannelDna): boolean {
  return Boolean(d.styleKitId || d.characterIds.length || d.voiceId || d.language || d.format || d.aspect || d.tone);
}

/** The aspect new work starts in: the one picked, else the format's own. */
export function dnaAspect(d: ChannelDna): DnaAspect | null {
  return d.aspect ?? (d.format === "shorts" ? "9:16" : d.format === "long" ? "16:9" : null);
}

// ── what each form starts from ──────────────────────────────────────────────

/** The Studio panel's starting values from DNA (only what the panel offers). */
export interface StudioDna {
  aspect: DnaAspect | null;
  /** Only a voice the Studio's list offers: a custom id would sit in a select that cannot show it. */
  voiceId: string | null;
}

export function studioDna(d: ChannelDna): StudioDna | null {
  const aspect = dnaAspect(d);
  const voiceId = knownVoice(d.voiceId)?.id ?? null;
  // The style kit travels separately (defaultStyleKitId, 0047's prop).
  return aspect || voiceId || d.styleKitId ? { aspect, voiceId } : null;
}

/**
 * A link that opened the panel on a tool (Home's quick tools, the Library's
 * "Use in Studio") carries no aspect or voice of its own — its "16:9" is a
 * placeholder — so the channel's DNA fills those. A retried job or a template
 * never comes through here: its own settings stand.
 */
export function withChannelDna(initial: StudioPrefill | null, dna: StudioDna | null): StudioPrefill | null {
  if (!initial || !dna) return initial;
  return {
    ...initial,
    ...(dna.aspect ? { aspect: dna.aspect } : {}),
    ...(initial.capability === "tts" && dna.voiceId && !initial.voiceId ? { voiceId: dna.voiceId } : {}),
  };
}

/** The Run now form's starting values from DNA — strings, as its controls hold them. */
export interface RunDna {
  language: string;
  voice: string;
  duration: string;
}

export function runDna(d: ChannelDna): RunDna | null {
  const language = d.language ? languageValue(d.language) : "";
  // A custom voice id is already "the channel's voice" (the form's empty choice).
  const voice = knownVoice(d.voiceId)?.id ?? "";
  // A Shorts channel starts at the shortest run, as Home's Shorts format does.
  const duration = d.format === "shorts" ? "60" : "";
  return language || voice || duration ? { language, voice, duration } : null;
}

// ── input (POST /api/channels/dna) ──────────────────────────────────────────

export type DnaInputError =
  | "bad_request"
  | "invalid_style_kit"
  | "invalid_character"
  | "too_many_characters"
  | "duplicate_character"
  | "invalid_voice"
  | "invalid_language"
  | "invalid_format"
  | "invalid_aspect"
  | "invalid_tone";

export interface DnaInput {
  channelId: string;
  styleKitId: string | null;
  characterIds: string[];
  /** null: leave the narrator voice as it is (0056 never clears it). */
  voiceId: string | null;
  /** null: leave the language as it is. */
  language: DnaLanguage | null;
  format: DnaFormat | null;
  aspect: DnaAspect | null;
  tone: string;
}

export type ParsedDna = { ok: true; value: DnaInput } | { ok: false; error: DnaInputError };

const nil = (v: unknown) => v === undefined || v === null || v === "";

/** `{ channel_id, style_kit_id?, character_ids?, voice_id?, language?, format?, aspect?, tone? }`. */
export function parseDnaInput(raw: unknown): ParsedDna {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "bad_request" };
  const b = raw as Record<string, unknown>;
  const channelId = parseChannelRef(b.channel_id);
  if (!channelId) return { ok: false, error: "bad_request" };

  const styleKitId = nil(b.style_kit_id) ? null : parseStyleId(b.style_kit_id);
  if (!nil(b.style_kit_id) && !styleKitId) return { ok: false, error: "invalid_style_kit" };

  const rawChars = nil(b.character_ids) ? [] : b.character_ids;
  if (!Array.isArray(rawChars)) return { ok: false, error: "bad_request" };
  if (rawChars.length > DNA_LIMITS.maxCharacters) return { ok: false, error: "too_many_characters" };
  const characterIds: string[] = [];
  for (const v of rawChars) {
    const id = parseStyleId(v);
    if (!id) return { ok: false, error: "invalid_character" };
    if (characterIds.includes(id)) return { ok: false, error: "duplicate_character" };
    characterIds.push(id);
  }

  if (!nil(b.voice_id) && !(typeof b.voice_id === "string" && VOICE_RE.test(b.voice_id))) return { ok: false, error: "invalid_voice" };
  if (!nil(b.language) && !isDnaLanguage(b.language)) return { ok: false, error: "invalid_language" };
  if (!nil(b.format) && !isDnaFormat(b.format)) return { ok: false, error: "invalid_format" };
  if (!nil(b.aspect) && !isDnaAspect(b.aspect)) return { ok: false, error: "invalid_aspect" };
  if (!nil(b.tone) && typeof b.tone !== "string") return { ok: false, error: "invalid_tone" };
  const tone = cleanTone(b.tone);
  if (charLength(tone) > DNA_LIMITS.toneMax) return { ok: false, error: "invalid_tone" };

  return {
    ok: true,
    value: {
      channelId,
      styleKitId,
      characterIds,
      voiceId: nil(b.voice_id) ? null : (b.voice_id as string),
      language: nil(b.language) ? null : (b.language as DnaLanguage),
      format: nil(b.format) ? null : (b.format as DnaFormat),
      aspect: nil(b.aspect) ? null : (b.aspect as DnaAspect),
      tone,
    },
  };
}

/** set_channel_dna's arguments, in its order. */
export function dnaRpcArgs(v: DnaInput) {
  return {
    p_channel_id: v.channelId,
    p_style_kit_id: v.styleKitId,
    p_character_ids: v.characterIds,
    p_voice_id: v.voiceId,
    p_language: v.language,
    p_format: v.format,
    p_aspect: v.aspect,
    p_tone: v.tone || null,
  };
}

// ── errors ──────────────────────────────────────────────────────────────────

export type DnaError = DnaInputError | "unauthorized" | "forbidden" | "not_found" | "not_available" | "not_configured" | "failed";

const INPUT_WORDS: readonly DnaInputError[] = [
  "invalid_style_kit",
  "invalid_character",
  "too_many_characters",
  "duplicate_character",
  "invalid_voice",
  "invalid_language",
  "invalid_format",
  "invalid_aspect",
  "invalid_tone",
];

/** A refusal from set_channel_dna -> a word and an HTTP status. */
export function mapDnaError(error: { code?: string; message?: string } | null | undefined): { error: DnaError; status: number } {
  const word = (error?.message ?? "").trim();
  switch (error?.code) {
    case "NS400":
      return { error: (INPUT_WORDS as readonly string[]).includes(word) ? (word as DnaInputError) : "bad_request", status: 400 };
    case "42501":
      return { error: "forbidden", status: 403 };
    case "P0002":
      return { error: "not_found", status: 404 };
    case "PGRST202":
    case "PGRST205":
    case "42883":
    case "42P01":
      return { error: "not_available", status: 503 };
  }
  if (/could not find the function|does not exist/i.test(error?.message ?? "")) return { error: "not_available", status: 503 };
  return { error: "failed", status: 502 };
}

export function isDnaError(v: unknown): v is DnaError {
  return (
    typeof v === "string" &&
    ([...INPUT_WORDS, "bad_request", "unauthorized", "forbidden", "not_found", "not_available", "not_configured", "failed"] as string[]).includes(v)
  );
}

/** Where "Change" goes: the channel's DNA card on the channels page. */
export function dnaAnchor(channelId: string): string {
  return `dna-${channelId}`;
}
