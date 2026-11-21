/**
 * Nightshift AI (the Studio's chat): the rules the conversation follows, as code. Pure: no network, no database — the route
 * (app/api/ai-chat/route.ts) gives this the facts it read and the model's raw answer, and takes back what to store and show.
 *
 * What the code, not the prompt, guarantees (Atlas's brief of 2026-11-21; CLAUDE.md rules 3–5):
 *   - nothing is proposed before length, style, platform, language and audience are known: a model that proposes early has its
 *     scenarios dropped and the missing questions asked instead;
 *   - a scenario's length is one the Run now form takes (RUN_DURATIONS_S), never a number the model made up;
 *   - every price shown is the backend's estimate for that length; a price the model writes is never read;
 *   - when the price is above what the workspace can spend, the longest length that fits is found by asking the same estimator
 *     at each shorter length — never by dividing;
 *   - the model's words are plain text, bounded, and never instructions to anything.
 */

import { RUN_DURATIONS_S, HOME_LANGUAGES, type HomeLanguage } from "@/lib/home";

export const AI_CHAT_SLOTS = ["length_s", "style", "platform", "language", "audience"] as const;
export type AiChatSlot = (typeof AI_CHAT_SLOTS)[number];

/** What Run now makes today. Anything else is answered honestly as "not yet", never quietly turned into a YouTube video. */
export const AI_CHAT_PLATFORMS = ["youtube"] as const;
export type AiChatPlatform = (typeof AI_CHAT_PLATFORMS)[number];

export interface AiChatSlots {
  length_s?: (typeof RUN_DURATIONS_S)[number];
  style?: string;
  platform?: AiChatPlatform;
  language?: HomeLanguage;
  audience?: string;
}

export interface AiChatScenario {
  title: string;
  hook: string;
  beats: string[];
  length_s: (typeof RUN_DURATIONS_S)[number];
  style: string;
}

/** A scenario as shown: the backend's price for its length, or the honest reason there is none. */
export type ScenarioPrice =
  | { state: "priced"; credits: number; fits: boolean }
  | { state: "exempt" }
  | { state: "unpriced" }
  | { state: "failed" };

export interface PricedScenario extends AiChatScenario {
  price: ScenarioPrice;
}

/** When a scenario does not fit: the longest length that does (by the estimator), or none at all. */
export type FitAdvice = { state: "shorter"; length_s: (typeof RUN_DURATIONS_S)[number]; credits: number } | { state: "none" };

export const TEXT_MAX = { reply: 900, title: 120, hook: 300, beat: 240, style: 120, audience: 120 } as const;
export const MAX_SCENARIOS = 3;
export const MIN_SCENARIOS = 2;
export const MAX_BEATS = 6;
export const HISTORY_TURNS = 12;

/** Plain text, one line where it must be: control characters out, whitespace folded, bounded. Never HTML, never markdown links. */
export function plain(v: unknown, max: number, multiline = false): string {
  if (typeof v !== "string") return "";
  // Control characters (but newlines, when allowed) and the bidi overrides that can make text read other than it is.
  const stripped = v.replace(/[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/g, multiline ? " " : " ");
  const folded = multiline
    ? stripped.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
    : stripped.replace(/\s+/g, " ").trim();
  return folded.length > max ? folded.slice(0, max - 1).trimEnd() + "…" : folded;
}

/** The nearest length Run now takes; a length that is not a positive number is no length. */
export function snapLength(v: unknown): (typeof RUN_DURATIONS_S)[number] | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,5}$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  let best: (typeof RUN_DURATIONS_S)[number] = RUN_DURATIONS_S[0];
  for (const d of RUN_DURATIONS_S) if (Math.abs(d - n) < Math.abs(best - n)) best = d;
  return best;
}

function language(v: unknown): HomeLanguage | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  const hit = HOME_LANGUAGES.find((l) => l.value.toLowerCase() === s || l.id === s || l.label.toLowerCase() === s);
  return hit?.value;
}

function platform(v: unknown): AiChatPlatform | "other" | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  return /youtube/i.test(v) ? "youtube" : "other";
}

/**
 * Merge what the model read into the slots already filled. A value the model gives that is not one we can make is dropped (the
 * question stays open); a platform we do not make is reported, so the chat can say "not yet" instead of pretending.
 */
export function mergeSlots(prev: AiChatSlots, raw: unknown): { slots: AiChatSlots; unsupportedPlatform: boolean } {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const next: AiChatSlots = { ...prev };
  const len = snapLength(r.length_s);
  if (len) next.length_s = len;
  const style = plain(r.style, TEXT_MAX.style);
  if (style) next.style = style;
  const lang = language(r.language);
  if (lang) next.language = lang;
  const aud = plain(r.audience, TEXT_MAX.audience);
  if (aud) next.audience = aud;
  const p = platform(r.platform);
  if (p === "youtube") next.platform = "youtube";
  return { slots: next, unsupportedPlatform: p === "other" };
}

/** Slots stored on a session, read back defensively (a row is data; only the shapes above survive). */
export function readSlots(raw: unknown): AiChatSlots {
  return mergeSlots({}, raw).slots;
}

export function missingSlots(s: AiChatSlots): AiChatSlot[] {
  return AI_CHAT_SLOTS.filter((k) => s[k] === undefined);
}

function scenario(raw: unknown, slots: AiChatSlots): AiChatScenario | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const title = plain(r.title, TEXT_MAX.title);
  const hook = plain(r.hook, TEXT_MAX.hook);
  const beats = Array.isArray(r.beats) ? r.beats.map((b) => plain(b, TEXT_MAX.beat)).filter(Boolean).slice(0, MAX_BEATS) : [];
  // The length the person asked for is the length, unless the model offers another one Run now takes (a shorter cut, say).
  const length_s = snapLength(r.length_s) ?? slots.length_s;
  const style = plain(r.style, TEXT_MAX.style) || slots.style || "";
  if (!title || !hook || beats.length < 2 || !length_s) return null;
  return { title, hook, beats, length_s, style };
}

export interface ModelAnswer {
  reply: string;
  slots: AiChatSlots;
  unsupportedPlatform: boolean;
  scenarios: AiChatScenario[];
  /** The step after this turn: still asking, or proposing (only with every slot filled and 2–3 usable scenarios). */
  step: "asking" | "proposing";
  missing: AiChatSlot[];
}

/** The model's raw text → what may be shown, or null when it is not the JSON we asked for (the turn then fails honestly). */
export function readModelAnswer(text: string, prev: AiChatSlots): ModelAnswer | null {
  const json = extractJson(text);
  if (!json) return null;
  const reply = plain(json.reply, TEXT_MAX.reply, true);
  if (!reply) return null;
  const { slots, unsupportedPlatform } = mergeSlots(prev, json.slots);
  const missing = missingSlots(slots);
  const raw = Array.isArray(json.scenarios) ? json.scenarios : [];
  const scenarios = missing.length === 0 && !unsupportedPlatform
    ? raw.map((s) => scenario(s, slots)).filter((s): s is AiChatScenario => s !== null).slice(0, MAX_SCENARIOS)
    : [];
  const proposing = scenarios.length >= MIN_SCENARIOS;
  return { reply, slots, unsupportedPlatform, scenarios: proposing ? scenarios : [], step: proposing ? "proposing" : "asking", missing };
}

/** The first JSON object in the text (a model may wrap it in a code fence). Anything else is no answer. */
export function extractJson(text: string): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Spendable credits: a number, "exempt" (the operator's own workspace is not charged), or unknown (a failed read). */
export type Spendable = number | "exempt" | "unknown";

export type Quote = (lengthS: (typeof RUN_DURATIONS_S)[number]) => Promise<{ ok: true; credits: number | null } | { ok: false }>;

/** Every scenario with the backend's price for its own length; one quote per distinct length. */
export async function priceScenarios(scenarios: AiChatScenario[], spendable: Spendable, quote: Quote): Promise<PricedScenario[]> {
  const cache = new Map<number, Promise<{ ok: true; credits: number | null } | { ok: false }>>();
  const q = (l: (typeof RUN_DURATIONS_S)[number]) => {
    if (!cache.has(l)) cache.set(l, quote(l));
    return cache.get(l)!;
  };
  return Promise.all(
    scenarios.map(async (s) => {
      if (spendable === "exempt") return { ...s, price: { state: "exempt" } as const };
      const r = await q(s.length_s);
      if (!r.ok) return { ...s, price: { state: "failed" } as const };
      if (r.credits === null) return { ...s, price: { state: "unpriced" } as const };
      // An unknown balance is not "enough": the card shows the price and says the balance could not be read.
      return { ...s, price: { state: "priced", credits: r.credits, fits: typeof spendable === "number" && r.credits <= spendable } as const };
    }),
  );
}

/** The longest Run now length, shorter than `fromS`, whose backend estimate fits what can be spent. */
export async function longestThatFits(fromS: number, spendable: number, quote: Quote): Promise<FitAdvice> {
  const shorter = [...RUN_DURATIONS_S].filter((d) => d < fromS).sort((a, b) => b - a);
  for (const d of shorter) {
    const r = await quote(d);
    if (r.ok && r.credits !== null && r.credits <= spendable) return { state: "shorter", length_s: d, credits: r.credits };
  }
  return { state: "none" };
}

/** The Run now link a chosen scenario opens: its topic, length and language prefill the form; nothing starts until the press. */
export function runLink(channelSlug: string, s: AiChatScenario, lang: HomeLanguage | undefined): string {
  const q = new URLSearchParams({ topic: `${s.title}: ${s.hook}`.slice(0, 300), length: String(s.length_s) });
  if (lang) q.set("lang", lang);
  return `/${encodeURIComponent(channelSlug)}/create?${q.toString()}`;
}
