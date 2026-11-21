/**
 * Nightshift Brain: the rules the conversation follows, as code (docs/studio/NIGHTSHIFT_AI.md). Pure: no network, no database. The
 * route gives this the facts it read and the model's raw answer, and takes back what to store and show: the slots, the next question
 * card, the proposed scenarios and the BRIEF v1 the canvas draws.
 *
 * What the code, not the prompt, guarantees (CLAUDE.md rules 3–5):
 *   - the first question is always the kind (a long YouTube video or a short Studio film); nothing is proposed before every slot of
 *     that kind is known — a model that proposes early has its scenarios dropped and the next question asked instead;
 *   - which question comes next is the server's choice; the model only words it and offers three answers;
 *   - a length is one the target path takes (Run now's lengths; a film's 60–1200 s with 3–30 s scenes), never a number made up;
 *   - every price shown is the backend's; a price, a credit figure, a discount or a link the model writes is removed from its text;
 *   - text is plain, bounded by code points (never half an emoji), without the invisible characters that make text read otherwise.
 */

import { RUN_DURATIONS_S, HOME_LANGUAGES, type HomeLanguage } from "@/lib/home";

export type BrainKind = "long" | "short";
export type BrainAspect = "16:9" | "9:16" | "1:1";
export const BRAIN_ASPECTS: BrainAspect[] = ["16:9", "9:16", "1:1"];
export type BrainSlot = "kind" | "target_seconds" | "aspect" | "style" | "language" | "audience";
/** The order the server asks in. A long video is always 16:9 (Run now makes YouTube videos), so it never asks the aspect. */
export const SLOT_ORDER: BrainSlot[] = ["kind", "target_seconds", "aspect", "style", "language", "audience"];

/** film_limits() (0166): the database enforces these; they are repeated here only to keep the model inside them. */
export const FILM = { targetMin: 10, targetMax: 1200, sceneMin: 3, sceneMax: 30, maxScenes: 60, promptMax: 2000, titleMax: 120 } as const;

export interface BrainSlots {
  kind?: BrainKind;
  target_seconds?: number;
  aspect?: BrainAspect;
  style?: string;
  language?: HomeLanguage;
  audience?: string;
}

export interface BrainCard {
  id: string;
  slot: BrainSlot;
  thread_title: string;
  question: string;
  options: string[];
  allow_own: true;
}

export interface BriefCharacter { id: string; name: string; description: string; image_prompt: string; asset_id: string | null; character_id: string | null; source: "prompt" | "upload" | "library" }
export interface BriefLocation { id: string; name: string; description: string; image_prompt: string; asset_id: string | null }
export interface BriefProp { id: string; name: string; description: string }
export interface BriefChapter { id: string; title: string; start_s: number; beats: { at_s: number; text: string }[] }
export interface BriefScene {
  id: string; n: number; title: string; duration_s: number; visual_prompt: string;
  dialogue: { character_id: string; line: string }[];
  character_ids: string[]; location_id: string | null; prop_ids: string[];
  keyframe_model: string | null; clip_model: string | null;
}

/** One proposed scenario: everything of the BRIEF the model writes. */
export interface Scenario {
  title: string; idea: string; story: { logline: string; conflict: string };
  chapters: BriefChapter[]; characters: BriefCharacter[]; locations: BriefLocation[]; props: BriefProp[]; scenes: BriefScene[];
  target_seconds: number;
}

export type BriefPrice =
  | { state: "priced"; total_credits: number; nodes?: Record<string, number>; spendable: number | "exempt" | "unknown"; fits: boolean;
      shorter: { target_seconds: number; credits: number } | null }
  | { state: "exempt" }
  | { state: "unpriced" }
  | { state: "failed" };

export interface Brief extends Partial<Omit<Scenario, "target_seconds">> {
  version: 1;
  session_id: string;
  status: "drafting" | "ready" | "created";
  kind: BrainKind | null;
  language: HomeLanguage | null;
  audience: string | null;
  style: string | null;
  aspect: BrainAspect | null;
  target_seconds: number | null;
  voice: { mode: "off" | "clip_audio" | "pipeline" };
  music: { mode: "off" };
  price?: BriefPrice;
  // credit_ref and scene_map are read by the database from the job and the film (0198), never sent by the browser.
  handoff: null | { kind: "film"; film_id: string; scene_map?: Record<string, string> }
    | { kind: "run"; channel_id: string; dispatched_at?: string; job_id?: string; credit_ref?: string };
}

export const CAP = { reply: 900, thread: 80, question: 200, option: 160, title: 120, idea: 300, logline: 300, style: 120, audience: 120,
  name: 80, description: 400, imagePrompt: 600, beat: 240, line: 300, chapters: 20, beats: 12, characters: 8, locations: 8, props: 12 } as const;
export const MAX_SCENARIOS = 3;
export const MIN_SCENARIOS = 2;
export const HISTORY_TURNS = 12;

// Control characters, bidi overrides and isolates, zero-width marks, LRM/RLM/ALM and the BOM (Breach on 0198: these make a title,
// a number or a URL read other than it is).
const INVISIBLE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜​-‏\u2028\u2029‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Plain text: invisible characters out, whitespace folded, bounded by CODE POINTS so a cut never leaves half an emoji (which the
 *  database refuses as JSON). Never HTML, never markdown: React renders it as text. */
export function plain(v: unknown, max: number, multiline = false): string {
  if (typeof v !== "string") return "";
  // Lone surrogates (half an emoji) are as unstorable as a cut one.
  const whole = v.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
  const stripped = whole.replace(INVISIBLE, " ");
  const folded = multiline
    ? whole.replace(/\r\n?/g, "\n").replace(INVISIBLE, (c) => (c === "\n" ? "\n" : " ")).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim()
    : stripped.replace(/\s+/g, " ").trim();
  const cps = Array.from(folded);
  return cps.length > max ? cps.slice(0, max - 1).join("").trimEnd() + "…" : folded;
}

// A link or a price in the model's words would read as Nightshift's own next to the real price (a comment can steer the model).
const LINK = /\[([^\]]{0,200})\]\([^)]*\)|\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|ru|uz|me|app|link|xyz|ly)\/\S*/gi;
const MONEY = new RegExp(
  [
    String.raw`[$€£¥₽]\s?\d[\d\s.,]*`,
    String.raw`\d[\d\s.,]*\s?(?:usd|eur|uzs|rub|dollars?|euros?|so[ʻ'’]?m|сум|руб\w*|долл\w*)`,
    String.raw`\d[\d\s.,]*\s?(?:credits?|кредит\w*|kredit\w*)`,
    String.raw`\d+\s?%\s?(?:off|discount|скидк\w*|chegirma\w*)`,
    String.raw`(?:free|бесплатн\w*|bepul)\s+(?:credits?|кредит\w*|kredit\w*)`,
  ].join("|"),
  "giu",
);

/** The model's words with every link and every price/credit/discount claim removed (shown as "…"). Plain and bounded too. */
export function modelText(v: unknown, max: number, multiline = false): string {
  const t = plain(v, max * 2, multiline);
  return plain(t.replace(LINK, (_m, label) => (label ? String(label) : "…")).replace(MONEY, "…"), max, multiline);
}

/** The nearest length Run now takes. */
export function snapRunLength(v: unknown): (typeof RUN_DURATIONS_S)[number] | undefined {
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  let best: (typeof RUN_DURATIONS_S)[number] = RUN_DURATIONS_S[0];
  for (const d of RUN_DURATIONS_S) if (Math.abs(d - n) < Math.abs(best - n)) best = d;
  return best;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,5}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** A film's target: 60–1200 s. A shorter ask is not silently stretched: it is dropped, and the question explains the shortest. */
export function filmLength(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  const r = Math.round(n);
  return r >= FILM.targetMin && r <= FILM.targetMax ? r : undefined;
}

function language(v: unknown): HomeLanguage | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return HOME_LANGUAGES.find((l) => l.value.toLowerCase() === s || l.id === s || l.label.toLowerCase() === s)?.value;
}

/** HomeLanguage → films.language (0166 takes en | ru | uz). */
export function filmLanguage(l: HomeLanguage): "en" | "ru" | "uz" {
  return (HOME_LANGUAGES.find((x) => x.value === l)?.id ?? "en") as "en" | "ru" | "uz";
}

export interface SlotRead {
  slots: BrainSlots;
  /** A length was asked that the kind cannot take (a 15 s film): the next question says why. */
  lengthOutOfRange: boolean;
}

/** Merge what the model read into the slots already filled. A value we cannot make is dropped; the question stays open. */
export function mergeSlots(prev: BrainSlots, raw: unknown): SlotRead {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const next: BrainSlots = { ...prev };
  let lengthOutOfRange = false;
  // The kind is decided once: after that a model cannot flip a short film into a long video (lengths and paths differ).
  if (!next.kind && (r.kind === "long" || r.kind === "short")) next.kind = r.kind;
  if (next.kind && r.target_seconds !== undefined && r.target_seconds !== null) {
    const len = next.kind === "long" ? snapRunLength(r.target_seconds) : filmLength(r.target_seconds);
    if (len) next.target_seconds = len;
    else lengthOutOfRange = num(r.target_seconds) !== undefined;
  }
  if (next.kind === "long") next.aspect = "16:9";
  else if (typeof r.aspect === "string" && (BRAIN_ASPECTS as string[]).includes(r.aspect)) next.aspect = r.aspect as BrainAspect;
  const style = plain(r.style, CAP.style);
  if (style) next.style = style;
  const lang = language(r.language);
  if (lang) next.language = lang;
  const aud = plain(r.audience, CAP.audience);
  if (aud) next.audience = aud;
  return { slots: next, lengthOutOfRange };
}

export function readSlots(raw: unknown): BrainSlots {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // Stored slots are data too: re-read through the same rules (kind first, then the rest).
  return mergeSlots(r.kind === "long" || r.kind === "short" ? { kind: r.kind } : {}, r).slots;
}

export function nextSlot(s: BrainSlots): BrainSlot | null {
  for (const k of SLOT_ORDER) if (s[k] === undefined) return k;
  return null;
}

function card(raw: unknown, slot: BrainSlot, id: string, fixed?: string[]): BrainCard {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const options = (Array.isArray(r.options) ? r.options : []).map((o) => modelText(o, CAP.option)).filter(Boolean).slice(0, 3);
  // Three options or none (the person then types their own answer, and the slot's question is ours, from i18n). The server's own
  // options win where it has them (the kind question: only what can actually be made here is offered).
  return { id, slot, thread_title: modelText(r.thread_title, CAP.thread), question: modelText(r.question, CAP.question),
           options: fixed?.length ? fixed : options.length === 3 ? options : [], allow_own: true };
}

/**
 * The vendor or model behind Nightshift AI, by name. The owner's rule: Nightshift AI never names its providers (it declines to say, it
 * never pretends to be human or home-made). The prompt says so; this is the check after the answer, because a prompt is a request.
 * Checked on what the person reads from the assistant itself (its reply and its card), not on a scenario about, say, the AI industry.
 */
const VENDOR = /(?<![\p{L}\p{N}])(claude|anthropic|chat\s?gpt|gpt(?:[-\s]?\d[\w.]*)?|openai|open\s?ai|gemini|deepmind|deepseek|sonnet\s?\d|opus\s?\d|haiku\s?\d)(?![\p{L}])/iu;
export function namesVendor(text: string): boolean {
  return VENDOR.test(text.normalize("NFKC"));
}

/**
 * A greeting or a question about the assistant itself ("salom", "who are you", "кто ты", "which model are you"), and nothing else (a
 * topic that starts with "hello" is a topic): such a turn decides nothing, so the server keeps the plan's slots as they were whatever the model put in them.
 */
const SMALL_TALK = /^(hi|hello|hey|good (morning|afternoon|evening)|salom|assalomu? alaykum|assalom|привет|здравствуй(те)?|добрый (день|вечер)|who are you|what are you|are you (a bot|an ai|human|chatgpt|claude)|(?:which|what) (?:model|ai|company)(?: are you| powers you| is this| do you use)?|sen kimsan|siz kimsiz|kimsan|kimsiz|qaysi model|кто ты|кто вы|что ты( такое)?|какая (ты )?модель)(?:[\s,!?.…]+(?:nightshift(?:\s?ai)?|there|ai|aka|doʻst|бро))*$/iu;
export function isSmallTalk(text: string): boolean {
  const t = text.normalize("NFKC").trim().replace(/[!?.,…\s]+$/u, "");
  return t.length > 0 && t.length <= 80 && SMALL_TALK.test(t);
}

const ID = /^[a-z][a-z0-9_-]{0,15}$/i;
const sid = (v: unknown, fallback: string) => (typeof v === "string" && ID.test(v) ? v.toLowerCase() : fallback);
const arr = (v: unknown) => (Array.isArray(v) ? v : []);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** One proposed scenario, validated as BRIEF parts; null when it is not usable for this kind. */
export function readScenario(raw: unknown, slots: BrainSlots): Scenario | null {
  const r = obj(raw);
  const title = modelText(r.title, CAP.title);
  const idea = modelText(r.idea, CAP.idea);
  if (!title || !idea || !slots.kind) return null;
  const characters = arr(r.characters).slice(0, CAP.characters).map((c, i): BriefCharacter => {
    const o = obj(c);
    return { id: sid(o.id, `c${i + 1}`), name: modelText(o.name, CAP.name), description: modelText(o.description, CAP.description),
             image_prompt: modelText(o.image_prompt, CAP.imagePrompt), asset_id: null, character_id: null, source: "prompt" };
  }).filter((c) => c.name);
  const locations = arr(r.locations).slice(0, CAP.locations).map((c, i): BriefLocation => {
    const o = obj(c);
    return { id: sid(o.id, `l${i + 1}`), name: modelText(o.name, CAP.name), description: modelText(o.description, CAP.description),
             image_prompt: modelText(o.image_prompt, CAP.imagePrompt), asset_id: null };
  }).filter((c) => c.name);
  const props = arr(r.props).slice(0, CAP.props).map((c, i): BriefProp => {
    const o = obj(c);
    return { id: sid(o.id, `p${i + 1}`), name: modelText(o.name, CAP.name), description: modelText(o.description, CAP.description) };
  }).filter((c) => c.name);
  const known = { c: new Set(characters.map((c) => c.id)), l: new Set(locations.map((l) => l.id)), p: new Set(props.map((p) => p.id)) };
  const chapters = arr(r.chapters).slice(0, CAP.chapters).map((c, i): BriefChapter => {
    const o = obj(c);
    return { id: sid(o.id, `ch${i + 1}`), title: modelText(o.title, CAP.title), start_s: Math.max(0, Math.round(num(o.start_s) ?? 0)),
             beats: arr(o.beats).slice(0, CAP.beats).map((b) => ({ at_s: Math.max(0, Math.round(num(obj(b).at_s) ?? 0)), text: modelText(obj(b).text, CAP.beat) }))
               .filter((b) => b.text) };
  }).filter((c) => c.title);
  const scenes = arr(r.scenes).slice(0, FILM.maxScenes).map((sc, i): BriefScene | null => {
    const o = obj(sc);
    const dur = Math.round(num(o.duration_s) ?? 0);
    const visual = modelText(o.visual_prompt, FILM.promptMax, true);
    if (!visual) return null;
    return {
      id: `s${i + 1}`, n: i + 1, title: modelText(o.title, CAP.title),
      duration_s: slots.kind === "short" ? Math.min(FILM.sceneMax, Math.max(FILM.sceneMin, dur || 6)) : Math.max(1, dur || 10),
      visual_prompt: visual,
      dialogue: slots.kind === "short"
        ? arr(o.dialogue).slice(0, 6).map((d) => ({ character_id: sid(obj(d).character_id, ""), line: modelText(obj(d).line, CAP.line) }))
            .filter((d) => d.line && known.c.has(d.character_id))
        : [],
      character_ids: arr(o.character_ids).map((x) => sid(x, "")).filter((x) => known.c.has(x)),
      location_id: known.l.has(sid(o.location_id, "")) ? sid(o.location_id, "") : null,
      prop_ids: arr(o.prop_ids).map((x) => sid(x, "")).filter((x) => known.p.has(x)),
      // The model never picks a model: a film's defaults are the Studio's, and a named one is checked by save_film anyway.
      keyframe_model: null, clip_model: null,
    };
  }).filter((s): s is BriefScene => s !== null);
  if (slots.kind === "short" && scenes.length === 0) return null;
  // A short film's length is what its scenes add up to, within a film's bounds; a long video's is the length the person chose.
  const sum = scenes.reduce((a, s) => a + s.duration_s, 0);
  const target_seconds = slots.kind === "short"
    ? Math.min(FILM.targetMax, Math.max(FILM.targetMin, sum || (slots.target_seconds ?? FILM.targetMin)))
    : (slots.target_seconds ?? RUN_DURATIONS_S[0]);
  return {
    title, idea, story: { logline: modelText(obj(r.story).logline, CAP.logline), conflict: modelText(obj(r.story).conflict, CAP.logline) },
    chapters, characters, locations, props, scenes, target_seconds,
  };
}

export interface ModelAnswer {
  reply: string;
  slots: BrainSlots;
  lengthOutOfRange: boolean;
  card: BrainCard | null;
  scenarios: Scenario[];
  step: "asking" | "proposing";
}

/** The model's raw text → what may be shown, or null when it is not the JSON we asked for (the turn then fails honestly). */
export interface AnswerRules {
  /** A greeting or identity question: the slots stay as they were. */
  freezeSlots?: boolean;
  /** Whether a short film can be made here now (Film Studio open). False: "short" is never taken and never offered. */
  shortAvailable?: boolean;
  /** The kind question's options, the server's own (i18n), in the person's language. */
  kindOptions?: string[];
  /** What replaces a reply that names a vendor or model (i18n identityReply). */
  identityReply?: string;
}

export function readModelAnswer(text: string, prev: BrainSlots, cardId: string, rules: AnswerRules = {}): ModelAnswer | null {
  const json = extractJson(text);
  if (!json) return null;
  let reply = modelText(json.reply, CAP.reply, true);
  if (!reply) return null;
  if (rules.identityReply && namesVendor(reply)) reply = rules.identityReply;
  const merged = rules.freezeSlots ? { slots: { ...prev }, lengthOutOfRange: false } : mergeSlots(prev, json.slots);
  const { lengthOutOfRange } = merged;
  let slots = merged.slots;
  // No dead option: a short film where Film Studio is closed is not taken (the kind question is asked again, without it).
  if (rules.shortAvailable === false && slots.kind === "short" && prev.kind !== "short") slots = { ...slots, kind: undefined, aspect: prev.aspect };
  const ask = nextSlot(slots);
  if (ask) {
    const c = card(json.card, ask, cardId, ask === "kind" ? rules.kindOptions : undefined);
    // The card is the assistant speaking too: a vendor name in it goes, the slot's own question (i18n) stands in.
    const clean = rules.identityReply && [c.thread_title, c.question, ...c.options].some(namesVendor)
      ? { ...c, thread_title: "", question: "", options: c.options.some(namesVendor) ? [] : c.options } : c;
    return { reply, slots, lengthOutOfRange, card: clean, scenarios: [], step: "asking" };
  }
  const scenarios = arr(json.scenarios).map((s) => readScenario(s, slots)).filter((s): s is Scenario => s !== null).slice(0, MAX_SCENARIOS);
  // Fewer than two usable scenarios is not a proposal: no card either (every slot is known), the person can ask again.
  return { reply, slots, lengthOutOfRange, card: null, scenarios: scenarios.length >= MIN_SCENARIOS ? scenarios : [],
           step: scenarios.length >= MIN_SCENARIOS ? "proposing" : "asking" };
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

/** The BRIEF v1 the canvas draws, from the slots and (once chosen) one scenario. */
export function buildBrief(sessionId: string, slots: BrainSlots, chosen: Scenario | null, status: Brief["status"], price?: BriefPrice): Brief {
  const b: Brief = {
    version: 1, session_id: sessionId, status,
    kind: slots.kind ?? null, language: slots.language ?? null, audience: slots.audience ?? null, style: slots.style ?? null,
    aspect: slots.aspect ?? null, target_seconds: chosen?.target_seconds ?? slots.target_seconds ?? null,
    // No TTS model is on sale (S6, 21 Nov): a short film speaks only through the video model's own audio; a long video keeps
    // Run now's own voice handling.
    voice: { mode: slots.kind === "long" ? "pipeline" : chosen?.scenes.some((s) => s.dialogue.length) ? "clip_audio" : "off" },
    music: { mode: "off" },
    handoff: null,
  };
  if (chosen) Object.assign(b, { title: chosen.title, idea: chosen.idea, story: chosen.story, chapters: chosen.chapters,
                                 characters: chosen.characters, locations: chosen.locations, props: chosen.props, scenes: chosen.scenes });
  if (price) b.price = price;
  return b;
}

/** The film a short BRIEF becomes: the settings and scenes create_film_draft / save_film take (0166). Dialogue goes into the clip
 *  prompt, which the video model speaks; narration stays empty (no TTS is on sale). */
export function filmFromBrief(b: Brief): { settings: Record<string, unknown>; scenes: Record<string, unknown>[]; sourceText: string } | null {
  if (b.kind !== "short" || !b.scenes?.length || !b.language || !b.title) return null;
  const names = new Map((b.characters ?? []).map((c) => [c.id, c.name]));
  const describe = (ids: string[]) => ids.map((id) => (b.characters ?? []).find((c) => c.id === id)).filter(Boolean)
    .map((c) => `${c!.name}: ${c!.description || c!.image_prompt}`).join(". ");
  const scenes = b.scenes.map((s) => {
    const loc = (b.locations ?? []).find((l) => l.id === s.location_id);
    const lines = s.dialogue.map((d) => `${names.get(d.character_id) ?? "A character"} says: "${d.line}"`).join(" ");
    const prompt = [s.visual_prompt, describe(s.character_ids), loc ? `Setting: ${loc.name}. ${loc.description}` : "", lines, b.style ? `Style: ${b.style}` : ""]
      .filter(Boolean).join("\n");
    return { title: s.title, narration: "", visual_prompt: plain(prompt, FILM.promptMax, true), planned_seconds: s.duration_s };
  });
  return {
    settings: { title: plain(b.title, FILM.titleMax), language: filmLanguage(b.language), aspect: b.aspect ?? "16:9", target_seconds: b.target_seconds },
    scenes,
    sourceText: plain([b.idea, b.story?.logline].filter(Boolean).join("\n"), 2000, true),
  };
}

/** The Run now link a long scenario opens: topic, length and language prefill the form; the session rides along so the form can
 *  record the handoff after the person's own press. Nothing starts until then. */
export function runLink(channelSlug: string, b: Brief): string {
  const q = new URLSearchParams({ topic: `${b.title ?? ""}: ${b.idea ?? ""}`.slice(0, 300), length: String(b.target_seconds ?? 60) });
  if (b.language) q.set("lang", b.language);
  q.set("brain", b.session_id);
  return `/${encodeURIComponent(channelSlug)}/create?${q.toString()}`;
}

export type Quote = (lengthS: number) => Promise<{ ok: true; credits: number | null } | { ok: false }>;
export type Spendable = number | "exempt" | "unknown";

/** A long video's price at its length, from the Run now estimator, and the longest shorter length that fits when it does not. */
export async function priceLong(lengthS: number, spendable: Spendable, quote: Quote): Promise<BriefPrice> {
  if (spendable === "exempt") return { state: "exempt" };
  const r = await quote(lengthS);
  if (!r.ok) return { state: "failed" };
  if (r.credits === null) return { state: "unpriced" };
  const fits = typeof spendable === "number" && r.credits <= spendable;
  let shorter: { target_seconds: number; credits: number } | null = null;
  if (!fits && typeof spendable === "number") {
    for (const d of [...RUN_DURATIONS_S].filter((x) => x < lengthS).sort((a, b) => b - a)) {
      const q = await quote(d);
      if (q.ok && q.credits !== null && q.credits <= spendable) {
        shorter = { target_seconds: d, credits: q.credits };
        break;
      }
    }
  }
  return { state: "priced", total_credits: r.credits, spendable, fits, shorter };
}
