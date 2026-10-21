/**
 * The "altered or synthetic content" label a video went out with — read back from the `video.ai_disclosure` event the
 * pipeline records after an upload (modules/ai_disclosure.py). Client-safe and pure.
 *
 * The event, not a column: no migration was needed, and the panel reads it the way it reads the gate's own event. It
 * only says what was recorded. A video with no readable record has an UNKNOWN label (it may predate the feature, or
 * the event has not synced yet), which the panel says — never "not labelled".
 */

export const AI_DISCLOSURE_EVENT = "video.ai_disclosure";

/** The closed words of modules/ai_disclosure.REASONS. */
export const AI_REASONS = [
  "generated_video",
  "generated_images",
  "ai_presenter",
  "real_person_voice",
  "provenance_unknown",
  "mode_always",
  "mode_never",
  "no_synthetic_media",
] as const;
export type AiReason = (typeof AI_REASONS)[number];

export const AI_MODES = ["auto", "always", "never"] as const;
export type AiMode = (typeof AI_MODES)[number];

/** Channel settings that lowered what "auto" would have declared (modules/ai_disclosure.overrides_of). */
export const AI_OVERRIDES = ["mode_never", "voice_own_clone"] as const;
export type AiOverride = (typeof AI_OVERRIDES)[number];

export interface AiDisclosureView {
  /** True: sent to the platform as "contains altered or synthetic content". */
  label: boolean;
  mode: AiMode;
  reasons: AiReason[];
  /** A disclosure line was added to the description / caption. */
  line: boolean;
  /** Settings a person chose that lowered the label (empty on a record written before this field existed). */
  overrides: AiOverride[];
}

interface EventLike {
  event: string;
  ts: string;
  metadata: Record<string, unknown> | null;
}

/** The newest readable record, or null. A record with an unknown mode or reason word, or a label that contradicts
 *  its own mode, is not trusted. */
export function aiDisclosureFromEvents(events: readonly EventLike[] | null | undefined): AiDisclosureView | null {
  let best: { ts: string; view: AiDisclosureView } | null = null;
  for (const e of events ?? []) {
    if (!e || e.event !== AI_DISCLOSURE_EVENT) continue;
    const view = parse(e.metadata);
    if (!view) continue;
    if (!best || String(e.ts) >= best.ts) best = { ts: String(e.ts), view };
  }
  return best ? best.view : null;
}

function parse(meta: Record<string, unknown> | null): AiDisclosureView | null {
  if (!meta || typeof meta !== "object") return null;
  const { label, mode, reasons, line, overrides } = meta as Record<string, unknown>;
  if (typeof label !== "boolean" || typeof line !== "boolean") return null;
  if (!(AI_MODES as readonly unknown[]).includes(mode)) return null;
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  if (!reasons.every((r) => (AI_REASONS as readonly unknown[]).includes(r))) return null;
  if ((mode === "never" && label) || (mode === "always" && !label)) return null;
  const known = Array.isArray(overrides) ? overrides.filter((o): o is AiOverride => (AI_OVERRIDES as readonly unknown[]).includes(o)) : [];
  return { label, mode: mode as AiMode, reasons: reasons as AiReason[], line, overrides: known };
}

// ── Who may set the two settings that lower the label (migration 0114) ───────────────────────────────────────────────

/** The closed words of modules/ai_disclosure.VOICES. */
export const AI_VOICES = ["generic", "own_clone", "real_person"] as const;
export type AiVoice = (typeof AI_VOICES)[number];

/** The two channel settings (agent_config keys) this page edits. */
export type AiSettingKey = "ai_disclosure" | "ai_disclosure_voice";

/**
 * The one value of each key that LOWERS what is declared to the platforms: `never` declares nothing, `own_clone` declares
 * a cloned voice that is not labelled. Migration 0114 lets only a platform administrator write them (the database refuses
 * anyone else, an organization's admin included); this is what hides them from the rest.
 */
export const AI_LOWERING: Record<AiSettingKey, AiMode | AiVoice> = { ai_disclosure: "never", ai_disclosure_voice: "own_clone" };

/**
 * Python's `str.strip()` (modules/ai_disclosure.py normalize_mode / normalize_voice) removes this set, which is not what
 * JavaScript's `trim()` removes (trim() also removes U+FEFF and leaves U+001C-001F and U+0085). It is the character class of
 * migration 0114's `ai_disclosure_norm`, character for character; tests/ai-disclosure-lock-ui.test.tsx pins the three equal.
 */
export const AI_STRIP_CLASS = "[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]";
const STRIP = new RegExp(`^${AI_STRIP_CLASS}+|${AI_STRIP_CLASS}+$`, "g");

function readWord(value: unknown): string | null {
  return typeof value === "string" ? value.replace(STRIP, "").toLowerCase() : null;
}

/** How the pipeline reads a stored `ai_disclosure`: exactly one of the three words (case and surrounding space ignored), else `auto`. */
export function normalizeAiMode(value: unknown): AiMode {
  const v = readWord(value);
  return v !== null && (AI_MODES as readonly string[]).includes(v) ? (v as AiMode) : "auto";
}

/** How the pipeline reads a stored `ai_disclosure_voice`: absent or blank is `generic`; an unknown word is `real_person` (the cautious reading). */
export function normalizeAiVoice(value: unknown): AiVoice {
  if (value === null || value === undefined) return "generic";
  const v = readWord(value);
  if (v === "") return "generic";
  return v !== null && (AI_VOICES as readonly string[]).includes(v) ? (v as AiVoice) : "real_person";
}

export interface AiChoice<V extends string> {
  value: V;
  /** True when the caller may not pick it: the option is shown (so the person sees it exists and why it is off), not hidden. */
  locked: boolean;
}

/** Every word of a setting, with the lowering one locked unless `canLower` (a platform administrator). */
export function aiChoices(key: "ai_disclosure", canLower: boolean): AiChoice<AiMode>[];
export function aiChoices(key: "ai_disclosure_voice", canLower: boolean): AiChoice<AiVoice>[];
export function aiChoices(key: AiSettingKey, canLower: boolean): AiChoice<string>[] {
  const words: readonly string[] = key === "ai_disclosure" ? AI_MODES : AI_VOICES;
  return words.map((value) => ({ value, locked: !canLower && value === AI_LOWERING[key] }));
}

/** The hint migration 0114's refusal carries (and the prefix of its message). */
export const AI_LOCK_HINT = "ai_disclosure_lock";

/** Is this a PostgREST / RPC error the lock raised (rather than any other failure to save)? */
export function isAiLockRefusal(err: { code?: string | null; message?: string | null; hint?: string | null } | null | undefined): boolean {
  if (!err) return false;
  return err.hint === AI_LOCK_HINT || (typeof err.message === "string" && err.message.includes(AI_LOCK_HINT));
}
