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
 *
 * The shot spec types (ShotSize, CameraMove, ShotVariation and the first_frame / last_frame / motion fields of BriefScene) are
 * adapted from HKUDS/ViMax agents/storyboard_artist.py and interfaces/shot_description.py (MIT License, Copyright (c) 2025; see
 * THIRD_PARTY_NOTICES). Everything else here is Nightshift's own.
 */

import { RUN_DURATIONS_S, HOME_LANGUAGES, type HomeLanguage } from "@/lib/home";
import type { RefSheet } from "@/lib/brain/ref-sheets";

export type BrainKind = "long" | "short";
export type BrainAspect = "16:9" | "9:16" | "1:1";
export const BRAIN_ASPECTS: BrainAspect[] = ["16:9", "9:16", "1:1"];
export type BrainSlot = "kind" | "target_seconds" | "aspect" | "style" | "language" | "audience";
/**
 * The slots the model may INFER from the person's sentence (S1 story grammar): the language from the language they write in, the
 * aspect from the format, the audience from the story. A one-sentence request used to become three question cards for things the
 * sentence already implied. An inference is marked as one (BrainSlots.inferred), shown as an editable chip, and always loses to
 * what the person says; the kind and the length are never inferred (they change the path and the price).
 */
export type InferableSlot = "aspect" | "language" | "audience";
export const INFERABLE_SLOTS: InferableSlot[] = ["aspect", "language", "audience"];
export const isInferable = (v: unknown): v is InferableSlot => typeof v === "string" && (INFERABLE_SLOTS as string[]).includes(v);
/** The order the server asks in. A long video is always 16:9 (Run now makes YouTube videos), so it never asks the aspect. */
export const SLOT_ORDER: BrainSlot[] = ["kind", "target_seconds", "aspect", "style", "language", "audience"];

/** film_limits() (0166): the database enforces these; they are repeated here only to keep the model inside them. */
export const FILM = { targetMin: 10, targetMax: 1200, sceneMin: 3, sceneMax: 30, maxScenes: 60, promptMax: 2000, titleMax: 120, maxShots: 3 } as const;

export interface BrainSlots {
  kind?: BrainKind;
  target_seconds?: number;
  aspect?: BrainAspect;
  style?: string;
  language?: HomeLanguage;
  audience?: string;
  /** Which of the values above the model inferred rather than the person said (INFERABLE_SLOTS); absent = all said. */
  inferred?: InferableSlot[];
}

export interface BrainCard {
  id: string;
  slot: BrainSlot;
  thread_title: string;
  question: string;
  options: string[];
  allow_own: true;
}

/**
 * A character's fixed look sheet (S1 story grammar), in English: the same words go into every key-frame and clip prompt the
 * character is in, so the face, hair, build, outfit (fixed costume colours) and palette are written once and never re-described
 * scene by scene (the free "description" each scene used to repeat drifted from shot to shot). `signature`: the one detail that makes
 * the character recognisable in a wide shot (a red scarf, a lame ear). `age_stages`: when the story spans years (a daughter growing
 * up), each stage's own look; a scene names the stage it shows.
 */
export interface CharacterLook { face: string; hair: string; build: string; outfit: string; palette: string; signature: string }
export interface AgeStage { id: string; label: string; look: CharacterLook }
export interface BriefCharacter { id: string; name: string; description: string; image_prompt: string; asset_id: string | null; character_id: string | null; source: "prompt" | "upload" | "library";
  look?: CharacterLook; age_stages?: AgeStage[] }
export interface BriefLocation { id: string; name: string; description: string; image_prompt: string; asset_id: string | null }
export interface BriefProp { id: string; name: string; description: string }
/** The emotional arc a story film's chapters follow, in this order (S1 story grammar). A film under SHORT_ARC_UNDER_S may skip
 *  `longing` (setup → turn → payoff): there is no room for four movements in a handful of shots. */
export type StoryBeat = "setup" | "longing" | "turn" | "payoff";
export const STORY_BEATS: StoryBeat[] = ["setup", "longing", "turn", "payoff"];
export const SHORT_ARC_UNDER_S = 20;
/** start_s is absent when it is not known (Probe M7): an unknown start is never drawn as 0 s (rule 5). `music_cue`: the act's music
 *  in words, for assembly later (nothing makes music from it today). */
export interface BriefChapter { id: string; title: string; start_s?: number; beats: { at_s: number; text: string }[]; beat?: StoryBeat; emotion?: string; music_cue?: string }

/**
 * The five story-film recipes the outline picks from (the owner's reference reels). Guidance for the model, stored on the BRIEF so
 * the plan knows which one it is writing; the person's own length always wins over a recipe's.
 */
export type FilmFormat = "F1" | "F2" | "F3" | "F4" | "F5";
export const FILM_FORMATS: FilmFormat[] = ["F1", "F2", "F3", "F4", "F5"];
/** How a scene is heard. `in_clip`: characters speak inside the clip (lip-sync); `voice_over`: a narrator over it; `none`: no words. */
export type SceneSpeech = "in_clip" | "voice_over" | "none";
export const SCENE_SPEECH: SceneSpeech[] = ["in_clip", "voice_over", "none"];
/** The outline's story craft (all optional on a BRIEF stored before it; required of a fresh story outline where marked). */
export interface StoryCraft {
  format?: FilmFormat;
  /** A line or a visible threat in the first two seconds: the conflict up front. Required of a fresh outline. */
  hook?: string;
  /** An object shown early that pays off in the last third. */
  planted_object?: { text: string; prop_id: string | null; planted_chapter: string; payoff_chapter: string };
  twist?: "flashback" | "time_skip" | "none";
  /** A moral or a dedication at the end: a text layer, never drawn by a model. */
  closing_card?: string;
  /** The title on a 9:16 cover. */
  cover_title?: string;
  /** How the format would be heard (in_clip, voice_over or none), recorded even while only wordless films can be made. */
  speech_intent?: SceneSpeech;
}
/** On-screen words (a bill, a name tag, a time-skip card, the closing card): NEVER drawn by an image or video model, which spell
 *  them wrong and in the wrong script. Each is a layer the editor puts on top later; the scene's prompt says "no text". */
export interface TextLayer { scene_id: string; text: string; position: string }
/** A proposed outline's chapter: BRIEF v1's chapter plus its length, which the plan step writes that chapter's scenes to. The
 *  BRIEF itself keeps the contract's shape (start_s carries where each chapter begins; buildBrief drops `seconds`). */
export interface OutlineChapter extends BriefChapter { seconds: number | null }
/** The shot spec, ported from HKUDS/ViMax agents/storyboard_artist.py (MIT; see lib/brain/prompt.ts and THIRD_PARTY_NOTICES). */
export type ShotSize = "wide" | "two_shot" | "medium" | "close" | "extreme_close" | "over_shoulder" | "insert";
export const SHOT_SIZES: ShotSize[] = ["wide", "two_shot", "medium", "close", "extreme_close", "over_shoulder", "insert"];
export type CameraMove = "static" | "push_in" | "pull_out" | "pan" | "tilt" | "tracking" | "handheld";
export const CAMERA_MOVES: CameraMove[] = ["static", "push_in", "pull_out", "pan", "tilt", "tracking", "handheld"];
/** ViMax's variation_type: how much changes between a shot's first and last frame. */
export type ShotVariation = "small" | "medium" | "large";
export const SHOT_VARIATIONS: ShotVariation[] = ["small", "medium", "large"];
export interface BriefScene {
  id: string; n: number; title: string; duration_s: number; visual_prompt: string;
  /** The lines spoken inside the clip (speech `in_clip`). Never in the key-frame prompt: only the clip's (clipPrompt). */
  dialogue: { character_id: string; line: string }[];
  character_ids: string[]; location_id: string | null; prop_ids: string[];
  keyframe_model: string | null; clip_model: string | null;
  // The story grammar's fields: all optional, so a BRIEF stored before them still reads.
  speech?: SceneSpeech;
  /** How the format meant this scene to be heard, when that cannot be made today (speechAllowed): kept, so nothing is lost. */
  speech_intent?: SceneSpeech;
  /** The voice-over over this scene (speech `voice_over`), in the film's language (0166 film_scenes.narration). */
  narration?: string;
  shot?: ShotSize;
  camera?: { position: string; move: CameraMove };
  lighting?: string;
  /** Pure snapshots, in English (ViMax ff_desc / lf_desc): the picture at the clip's first and last moment, no action words. */
  first_frame?: string;
  last_frame?: string;
  /** ViMax motion_desc: the one simple action and the camera's move between the two frames, characters by appearance. */
  motion?: string;
  /** The characters in frame, each at the age stage this scene shows (null when the character has no stages). */
  in_frame?: { character_id: string; age_stage: string | null }[];
  variation?: ShotVariation;
  /** Sound effects in words, for assembly later. */
  sfx?: string;
  /** This scene carries the outline's hook (the film's first scene must). */
  hook?: boolean;
  text_layers?: { text: string; position: string }[];
  /** The outline chapter the scene belongs to: last_frame → first_frame chains only inside one (chain_from). */
  chapter_id?: string;
  /** The scene before it in the SAME chapter, whose last frame this one continues; null for a chapter's first scene. */
  chain_from?: string | null;
}

/**
 * One proposed scenario. Since the plan step, a proposal is an OUTLINE (no scenes): the storyboard is written afterwards, chapter
 * by chapter (lib/brain/plan.ts), because one answer cannot hold 2–3 whole storyboards past a minute or two (S1_GAPS G2). `scenes`
 * is filled only by a finished plan, or by a payload stored before the plan step existed that already adds up to the length.
 */
export interface Scenario extends StoryCraft {
  title: string; idea: string; story: { logline: string; conflict: string };
  /** The film's look in English (the style the person said, as image and video models read it): folded into every prompt. */
  visual_style?: string;
  chapters: OutlineChapter[]; characters: BriefCharacter[]; locations: BriefLocation[]; props: BriefProp[]; scenes: BriefScene[];
  target_seconds: number;
  /** The server's count of today's messages writing its storyboard takes (lib/brain/plan.ts planTurns); never stored, never the
   *  model's. Absent when there is nothing to plan. */
  plan_turns?: { about: number; at_most: number };
}

export type BriefPrice =
  | { state: "priced"; total_credits: number; nodes?: Record<string, number>; spendable: number | "exempt" | "unknown"; fits: boolean;
      shorter: { target_seconds: number; credits: number } | null }
  | { state: "exempt" }
  | { state: "unpriced" }
  | { state: "failed" };

export interface Brief extends Partial<Omit<Scenario, "target_seconds" | "chapters" | "plan_turns">> {
  chapters?: BriefChapter[];
  version: 1;
  session_id: string;
  status: "drafting" | "ready" | "created";
  kind: BrainKind | null;
  language: HomeLanguage | null;
  audience: string | null;
  style: string | null;
  aspect: BrainAspect | null;
  target_seconds: number | null;
  /**
   * "narration": some scene is voice-over; "clip_audio": some scene is spoken inside its clip (and none is voice-over). `blocked`:
   * why Create is not offered for this film yet (speechBlock), said by name: never shipped silent, never the clips' own sound in
   * place of a voice-over or the other way round (CLAUDE.md rule 4).
   */
  voice: { mode: "off" | "clip_audio" | "pipeline" | "narration"; blocked?: SpeechBlock[] };
  text_layers?: TextLayer[];
  music: { mode: "off" };
  price?: BriefPrice;
  // credit_ref and scene_map are read by the database from the job and the film (0199), never sent by the browser.
  /** Character reference sheets (lib/brain/ref-sheets.ts): optional and additive, written only by /api/brain/sheets. */
  ref_sheets?: RefSheet[];
  handoff: null | { kind: "film"; film_id: string; scene_map?: Record<string, string> }
    | { kind: "run"; channel_id: string; dispatched_at?: string; job_id?: string; credit_ref?: string };
}

export const CAP = { reply: 900, thread: 80, question: 200, option: 160, title: 120, idea: 300, logline: 300, style: 120, audience: 120,
  name: 80, description: 400, imagePrompt: 600, beat: 240, line: 300, chapters: 20, beats: 12, characters: 8, locations: 8, props: 12,
  emotion: 40, look: 160, stages: 4, narration: 600, frame: 500, lighting: 200, camera: 120, visualStyle: 200, craft: 200, layers: 4 } as const;
export const MAX_SCENARIOS = 3;
export const MIN_SCENARIOS = 2;
export const HISTORY_TURNS = 12;

// Control characters, bidi overrides and isolates, zero-width marks, LRM/RLM/ALM and the BOM (Breach on 0199: these make a title,
// a number or a URL read other than it is).
const INVISIBLE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜​-‏\u2028\u2029‪-‮⁠-⁤⁦-⁩﻿]/g;

const FORMAT = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0000}-\u{E007F}]/gu;

/**
 * For the CHECKS only, never for what is shown: look-alike Cyrillic and Greek letters folded to Latin ("Сlaude", "ΟpenAI", "nudе"),
 * and a run of single letters with separators between them closed up ("C l a u d e", "n.a.k.e.d"). A check runs on the text as it
 * is AND on this copy, so Russian and Uzbek words are still matched as themselves.
 */
const CONFUSABLE: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ї: "i", ј: "j", ѕ: "s", ԁ: "d", ӏ: "l",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X", І: "I", Ј: "J", Ѕ: "S",
  α: "a", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
};
export function foldForCheck(text: string): string {
  const base = text.normalize("NFKC").replace(FORMAT, "");
  // Only inside words that also have Latin letters: an all-Cyrillic word is Russian or Uzbek and stays itself.
  const latinised = base.replace(/[\p{L}]+/gu, (w) => (/[a-z]/i.test(w) ? Array.from(w, (ch) => CONFUSABLE[ch] ?? ch).join("") : w));
  return latinised.replace(/(?<![\p{L}])\p{L}(?:[\s.\-_*·•|/]+\p{L}(?![\p{L}])){2,}/gu, (run) => run.replace(/[^\p{L}]/gu, ""));
}

/** Plain text: invisible characters out, whitespace folded, bounded by CODE POINTS so a cut never leaves half an emoji (which the
 *  database refuses as JSON). Never HTML, never markdown: React renders it as text. */
export function plain(v: unknown, max: number, multiline = false): string {
  if (typeof v !== "string") return "";
  // Lone surrogates (half an emoji) are as unstorable as a cut one.
  // Format characters that render as nothing (zero-width, soft hyphen, bidi marks, variation selectors, tags) go entirely, never as a
  // space: "Cl\u200baude" and "cr\u00adedits" are the words they look like (Breach on 0199).
  const whole = v.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "").replace(FORMAT, "");
  const stripped = whole.replace(INVISIBLE, " ");
  const folded = multiline
    ? whole.replace(/\r\n?/g, "\n").replace(INVISIBLE, (c) => (c === "\n" ? "\n" : " ")).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim()
    : stripped.replace(/\s+/g, " ").trim();
  const cps = Array.from(folded);
  return cps.length > max ? cps.slice(0, max - 1).join("").trimEnd() + "…" : folded;
}

// A link or a price in the model's words would read as Nightshift's own next to the real price (a comment can steer the model).
const LINK = /\[([^\]]{0,200})\]\([^)]*\)|\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|ru|uz|me|app|link|xyz|ly)\/\S*/gi;
// Every apostrophe a "soʻm" is typed with, and letters in any script (\w is ASCII: "300 кредитов" left "…ов", Lens on 0199).
const AP = "[ʻʼ'’‘`]";
// Breach BR-S1-06: the currencies a price is written in, not only ours (GBP, the rupee, stablecoins, "bucks" all passed). TRY (the
// lira) only AFTER a number: before one it is the English verb ("try 3 more").
const CODES = "usd|eur|uzs|rub|gbp|inr|usdt|usdc|btc|kzt|cny|rmb|jpy";
const UNIT = String.raw`(?:${CODES}|try|dollars?|euros?|bucks?|quid|so${AP}?m|сўм|сум(?:ы|ов|а|ах)?|рубл\p{L}*|руб\.?|долл\p{L}*|(?:credits?|кредит\p{L}*|kredit\p{L}*)(?!\s+roll))`;
const SCALE = String.raw`(?:k|тыс\.?|тысяч\p{L}*|ming|mln|million\p{L}*|млн\.?|миллион\p{L}*)`;
// Word numbers next to a unit. Not "on" (English): Uzbek "oʻn" (ten) only with its apostrophe (Lens on 0199: "living on credit").
const WORDNUM = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand|nol|bir|ikki|uch|to${AP}rt|besh|o${AP}n|yigirma|o${AP}ttiz|qirq|ellik|yuz|ming|ноль|один|два|три|четыре|пять|десять|пятнадцать|двадцать|тридцать|сорок|пятьдесят|сто|двести|триста|пятьсот|тысяч\p{L}*)`;
const MONEY = new RegExp(
  [
    // Any currency sign (\p{Sc}: ₹ ₺ ₸ ₿ ₩ … as well as $ € £ ¥ ₽), on either side of the number.
    String.raw`\p{Sc}\s?\d[\d\s.,]*${SCALE}?`,
    String.raw`\d[\d\s.,]*\s?\p{Sc}`,
    String.raw`(?<![\p{L}])(?:${CODES}|so${AP}?m|сўм|сум|руб\.?)\s?\d[\d\s.,]*${SCALE}?`,
    String.raw`\d[\d\s.,]*\s?${SCALE}?\s?(?:ta\s)?${UNIT}(?![\p{L}])`,
    String.raw`(?<![\p{L}])${WORDNUM}(?:[\s-]+${WORDNUM})*\s+(?:ta\s)?${UNIT}(?![\p{L}])`,
    String.raw`\d+\s?%\s?(?:off|discount|скидк\p{L}*|chegirma\p{L}*)`,
    // "Free" only as a price claim, next to what would be priced (Lens on 0199: "living for free in Tokyo" is a topic).
    String.raw`(?<![\p{L}])(?:free|бесплатн\p{L}*|bepul)\s+(?:credits?|кредит\p{L}*|kredit\p{L}*|plan|trial|тариф\p{L}*|tarif\p{L}*|video|видео)`,
    String.raw`(?:credits?|кредит\p{L}*|kredit\p{L}*|plan|тариф\p{L}*|tarif\p{L}*)\s+(?:is\s+|are\s+)?(?:free|бесплатн\p{L}*|bepul)(?![\p{L}])`,
  ].join("|"),
  "giu",
);

/** The model's words with every link and every price/credit/discount claim removed (shown as "…"). Plain and bounded too. */
export function modelText(v: unknown, max: number, multiline = false): string {
  const t = plain(v, max * 2, multiline);
  const out = t.replace(LINK, (_m, label) => (label ? String(label) : "…")).replace(MONEY, "…");
  // A price spelt with look-alike letters ("5 credіts"): the folded copy still names one, so the words go as a whole.
  MONEY.lastIndex = 0;
  const hidden = MONEY.test(foldForCheck(out));
  MONEY.lastIndex = 0;
  return plain(hidden ? foldForCheck(out).replace(MONEY, "…") : out, max, multiline);
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

/**
 * Merge what the model read into the slots already filled. A value we cannot make is dropped; the question stays open. `inferredRaw`:
 * what the model inferred rather than heard (INFERABLE_SLOTS only). The order is the rule: an explicit answer always wins, and
 * replaces an inference; an inference fills only a slot nobody answered, so it never overwrites what the person said.
 */
export function mergeSlots(prev: BrainSlots, raw: unknown, inferredRaw?: unknown): SlotRead {
  const said = mergeSaid(prev, raw);
  const next = said.slots;
  const inferred = new Set<InferableSlot>((prev.inferred ?? []).filter(isInferable));
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // What the person said this turn is no longer an inference.
  for (const k of INFERABLE_SLOTS) {
    if (r[k] !== undefined && r[k] !== null && mergeSaid({ kind: next.kind }, { [k]: r[k] }).slots[k] !== undefined) inferred.delete(k);
  }
  const guess = inferredRaw && typeof inferredRaw === "object" && !Array.isArray(inferredRaw) ? (inferredRaw as Record<string, unknown>) : {};
  for (const k of INFERABLE_SLOTS) {
    if (guess[k] === undefined || guess[k] === null) continue;
    // Only into a slot that is empty or itself an inference: never over the person's own answer.
    if (next[k] !== undefined && !inferred.has(k)) continue;
    // A long video is always 16:9: that is a fact of the path, not an inference.
    if (k === "aspect" && next.kind === "long") continue;
    const one = mergeSaid({ kind: next.kind }, { [k]: guess[k] }).slots[k];
    if (one === undefined) continue;
    (next as Record<string, unknown>)[k] = one;
    inferred.add(k);
  }
  if (next.kind === "long") inferred.delete("aspect");
  const list = INFERABLE_SLOTS.filter((k) => inferred.has(k) && next[k] !== undefined);
  if (list.length) next.inferred = list;
  else delete next.inferred;
  return { slots: next, lengthOutOfRange: said.lengthOutOfRange };
}

function mergeSaid(prev: BrainSlots, raw: unknown): SlotRead {
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
  // The model's words like any other (Breach BR-S1-01): the style goes into every scene's prompt and every plan call, so a link or a
  // price in it is taken out here; unsafeBrief reads it too.
  const style = modelText(r.style, CAP.style);
  if (style) next.style = style;
  const lang = language(r.language);
  if (lang) next.language = lang;
  const aud = modelText(r.audience, CAP.audience);
  if (aud) next.audience = aud;
  return { slots: next, lengthOutOfRange };
}

export function readSlots(raw: unknown): BrainSlots {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // Stored slots are data too: re-read through the same rules (kind first, then the rest). The inferred marks are kept only for
  // slots that hold a value.
  const slots = mergeSaid(r.kind === "long" || r.kind === "short" ? { kind: r.kind } : {}, r).slots;
  const marks = arr(r.inferred).filter(isInferable).filter((k) => slots[k] !== undefined && !(k === "aspect" && slots.kind === "long"));
  const list = INFERABLE_SLOTS.filter((k) => marks.includes(k));
  return list.length ? { ...slots, inferred: list } : slots;
}

/**
 * The answers a chip's change offers (an inferred slot the person corrects): the server's own, so the value is one it can make. The
 * audience has none: it is the person's own words.
 */
export function changeOptions(slot: InferableSlot): string[] {
  return slot === "aspect" ? [...BRAIN_ASPECTS] : slot === "language" ? HOME_LANGUAGES.map((l) => l.value) : [];
}

/** The slots the server still needs, in its order: what the DATA block's `open_slots` says (an inference counts as filled). */
export function openSlots(s: BrainSlots): BrainSlot[] {
  return SLOT_ORDER.filter((k) => s[k] === undefined);
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
// Names that are only ever the vendor or its products, with Uzbek's own endings ("Мен Клодман": I am Claude). Claude is also a
// first name: not with the famous ones after it.
const VENDOR = /(?<![\p{L}\p{N}])(claude(?:man|men|miz|ning|dan)?(?!\s+(?:monet|debussy|lelouch|chabrol|bernard|van\s+damme|l[ée]vi|fran[çc]ois))|anthropic|chat\s?gpt|gpt(?:[-\s]?\d[\w.]*)?|openai|open\s?ai|deepmind|deepseek|клод(?:ман|мен|миз|нинг|дан)?(?!\s+(?:моне|дебюсси))|антропик\p{L}*|чат\s?-?\s?гпт|чатгпт|гпт(?:[-\s]?\d)?|опенаи|опен\s?эй\s?ай)(?![\p{L}])/iu;
// Words that are also ordinary ones (a zodiac sign, a poem): a vendor only when the assistant is speaking about itself.
const VENDOR_SELF = /(?:i am|i'm|i use|i run on|powered by|based on|built (?:on|by|with)|made by|my model|model is|я\s|основан\p{L}*\s+на|работаю\s+на|модел\p{L}*|men\s|asosida|modeli?m?)[^.!?\n]{0,40}(?<![\p{L}])(gemini|bard|sonnet\s?\d|opus\s?\d|haiku\s?\d|джемини|гемини)(?![\p{L}])/iu;
export function namesVendor(text: string): boolean {
  const folded = foldForCheck(text);
  return VENDOR.test(text) || VENDOR.test(folded) || VENDOR_SELF.test(text) || VENDOR_SELF.test(folded)
    // Spelt with separators inside a whole word ("Anth-ropic", "open_ai"): the strongest names, letters only.
    || /anthropic|openai|chatgpt|deepseek|deepmind/i.test(folded.replace(/[^\p{L}]/gu, ""));
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
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** What a scenario reader is given: a fresh proposal (an outline, and nothing else), or a stored payload. */
export interface ScenarioRules {
  /**
   * A fresh proposal from the model: an outline. Its scenes are dropped even when the model wrote some (the plan step writes them,
   * chapter by chapter), and a short outline must say how long each chapter is. Without it (a stored payload, which may predate the
   * plan step) a short scenario is usable either as such an outline or as a storyboard that already adds up to the length.
   */
  outline?: boolean;
  /** A fresh story outline from the chat: checked by storyProblem (the film editor's outline has the server's chapters, no arc). */
  story?: boolean;
  /** Where a story outline's problems are collected, for the one re-ask. */
  problems?: string[];
}

/** A length as the model wrote it, rounded; never clamped (a 99 s scene is not a 30 s one, S1_GAPS G1). */
export function sceneSeconds(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,4}(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 100_000 ? Math.round(n) : null;
}

export interface SceneRefs { c: Set<string>; l: Set<string>; p: Set<string> }
export type SceneParts = Omit<BriefScene, "id" | "n" | "duration_s"> & { seconds: number | null };

const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as T) : undefined;

/** One scene the model wrote, as BRIEF parts: plain text, references only to things that exist. Its length is the caller's check;
 *  whether the story-grammar fields are all there is too (lib/brain/plan readWindow): a stored scene may predate them. */
export function readSceneParts(raw: unknown, kind: BrainKind, known: SceneRefs): SceneParts | null {
  const o = obj(raw);
  const visual = modelText(o.visual_prompt, FILM.promptMax, true);
  if (!visual) return null;
  const inFrame = firstOfEachChar(arr(o.in_frame).map(obj).map((x) => ({ character_id: sid(x.character_id, ""), age_stage: typeof x.age_stage === "string" && x.age_stage.trim() ? sid(x.age_stage, "") || null : null }))
    .filter((x) => known.c.has(x.character_id)));
  const cam = obj(o.camera);
  const move = oneOf(cam.move, CAMERA_MOVES);
  const speech = oneOf(o.speech, SCENE_SPEECH);
  const layers = arr(o.text_layers).slice(0, CAP.layers).map(obj)
    .map((x) => ({ text: modelText(x.text, CAP.craft), position: modelText(x.position, CAP.camera) || "center" })).filter((x) => x.text);
  return {
    title: modelText(o.title, CAP.title),
    seconds: sceneSeconds(o.duration_s),
    visual_prompt: visual,
    dialogue: kind === "short"
      ? arr(o.dialogue).slice(0, 6).map((d) => ({ character_id: sid(obj(d).character_id, ""), line: modelText(obj(d).line, CAP.line) }))
          .filter((d) => d.line && known.c.has(d.character_id))
      : [],
    // Every character in frame is one of the scene's characters, whichever list the model filled.
    character_ids: [...new Set([...arr(o.character_ids).map((x) => sid(x, "")), ...inFrame.map((x) => x.character_id)].filter((x) => known.c.has(x)))],
    location_id: known.l.has(sid(o.location_id, "")) ? sid(o.location_id, "") : null,
    prop_ids: [...new Set(arr(o.prop_ids).map((x) => sid(x, "")).filter((x) => known.p.has(x)))],
    // The model never picks a model: a film's defaults are the Studio's, and a named one is checked by save_film anyway.
    keyframe_model: null, clip_model: null,
    ...(speech ? { speech } : {}),
    ...(oneOf(o.speech_intent, SCENE_SPEECH) ? { speech_intent: oneOf(o.speech_intent, SCENE_SPEECH) } : {}),
    ...(typeof o.narration === "string" && modelText(o.narration, CAP.narration, true) ? { narration: modelText(o.narration, CAP.narration, true) } : {}),
    ...(oneOf(o.shot, SHOT_SIZES) ? { shot: oneOf(o.shot, SHOT_SIZES) } : {}),
    ...(move ? { camera: { position: modelText(cam.position, CAP.camera), move } } : {}),
    ...(modelText(o.lighting, CAP.lighting) ? { lighting: modelText(o.lighting, CAP.lighting) } : {}),
    ...(modelText(o.first_frame, CAP.frame, true) ? { first_frame: modelText(o.first_frame, CAP.frame, true) } : {}),
    ...(modelText(o.last_frame, CAP.frame, true) ? { last_frame: modelText(o.last_frame, CAP.frame, true) } : {}),
    ...(modelText(o.motion, CAP.frame, true) ? { motion: modelText(o.motion, CAP.frame, true) } : {}),
    ...(inFrame.length ? { in_frame: inFrame } : {}),
    ...(oneOf(o.variation, SHOT_VARIATIONS) ? { variation: oneOf(o.variation, SHOT_VARIATIONS) } : {}),
    ...(modelText(o.sfx, CAP.craft) ? { sfx: modelText(o.sfx, CAP.craft) } : {}),
    ...(o.hook === true ? { hook: true } : {}),
    ...(layers.length ? { text_layers: layers } : {}),
  };
}

function firstOfEachChar<T extends { character_id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((x) => (seen.has(x.character_id) ? false : (seen.add(x.character_id), true)));
}

function readLook(v: unknown): CharacterLook | undefined {
  const o = obj(v);
  const look: CharacterLook = { face: modelText(o.face, CAP.look), hair: modelText(o.hair, CAP.look), build: modelText(o.build, CAP.look),
                                outfit: modelText(o.outfit, CAP.look), palette: modelText(o.palette, CAP.look), signature: modelText(o.signature, CAP.look) };
  return Object.values(look).some(Boolean) ? look : undefined;
}
/** A look sheet with every part written: the only kind a fresh outline may carry (an empty part is a part each shot reinvents). */
export const lookComplete = (l: CharacterLook | undefined): boolean => !!l && Object.values(l).every(Boolean);

function readCraft(r: Record<string, unknown>, chapterIds: Set<string>, propIds: Set<string>): StoryCraft {
  const out: StoryCraft = {};
  const format = typeof r.format === "string" ? (FILM_FORMATS as string[]).find((f) => f === r.format!.toString().trim().toUpperCase()) as FilmFormat | undefined : undefined;
  if (format) out.format = format;
  const hook = modelText(r.hook, CAP.craft);
  if (hook) out.hook = hook;
  const po = obj(r.planted_object);
  const poText = modelText(po.text, CAP.craft);
  if (poText) {
    const planted = sid(po.planted_chapter, "");
    const payoff = sid(po.payoff_chapter, "");
    const prop = sid(po.prop_id, "");
    out.planted_object = { text: poText, prop_id: propIds.has(prop) ? prop : null, planted_chapter: chapterIds.has(planted) ? planted : "",
                           payoff_chapter: chapterIds.has(payoff) ? payoff : "" };
  }
  const twist = oneOf(r.twist, ["flashback", "time_skip", "none"] as const);
  if (twist) out.twist = twist;
  const closing = modelText(r.closing_card, CAP.craft);
  if (closing) out.closing_card = closing;
  const cover = modelText(r.cover_title, CAP.title);
  if (cover) out.cover_title = cover;
  const intent = oneOf(r.speech_intent, SCENE_SPEECH);
  if (intent) out.speech_intent = intent;
  return out;
}

/**
 * What is wrong with a fresh story outline, in the server's own words (ids and numbers only, for the one re-ask), or null. Code
 * checks what can be checked: the beats in order with the payoff last (setup → longing → turn → payoff; under SHORT_ARC_UNDER_S the
 * longing may be skipped), a hook, a planted object paid off in the last third AFTER it is planted, every character with a whole
 * look sheet, and a life montage (F3) with someone who ages.
 */
export function storyProblem(s: Scenario): string | null {
  const problems: string[] = [];
  if (!s.format) problems.push(`"format" is missing (${FILM_FORMATS.join(", ")})`);
  const beats = s.chapters.map((c) => c.beat);
  if (beats.some((b) => !b)) problems.push(`every chapter needs a "beat" (${STORY_BEATS.join(", ")})`);
  else {
    const rank = (b: StoryBeat) => STORY_BEATS.indexOf(b);
    const ordered = beats.every((b, i) => i === 0 || rank(b!) >= rank(beats[i - 1]!));
    const need: StoryBeat[] = s.target_seconds < SHORT_ARC_UNDER_S ? ["setup", "turn", "payoff"] : STORY_BEATS;
    if (!ordered || beats[0] !== "setup" || beats[beats.length - 1] !== "payoff" || need.some((b) => !beats.includes(b))) {
      problems.push(`the chapters' beats are ${beats.join(" > ")}; they must go ${need.join(" > ")} in that order, starting with setup and ending with payoff`);
    }
  }
  if (s.chapters.some((c) => !c.emotion)) problems.push(`every chapter needs an "emotion" (one short word)`);
  if (!s.hook) problems.push(`"hook" is missing: a line or a visible threat in the first two seconds`);
  const po = s.planted_object;
  if (po) {
    const at = (id: string) => s.chapters.findIndex((c) => c.id === id);
    const payoff = s.chapters[at(po.payoff_chapter)];
    const end = payoff && typeof payoff.start_s === "number" && payoff.seconds ? payoff.start_s + payoff.seconds : null;
    if (!payoff || at(po.planted_chapter) < 0 || at(po.planted_chapter) >= at(po.payoff_chapter) || end === null || end <= (s.target_seconds * 2) / 3) {
      problems.push(`"planted_object" must be planted in an earlier chapter and pay off in a chapter that ends in the last third of the film (after ${Math.ceil((s.target_seconds * 2) / 3)} s)`);
    }
  }
  const noLook = s.characters.filter((c) => !lookComplete(c.look) || (c.age_stages ?? []).some((a) => !lookComplete(a.look)));
  if (noLook.length) problems.push(`character${noLook.length > 1 ? "s" : ""} ${noLook.map((c) => c.id).join(", ")} need a complete "look" (face, hair, build, outfit, palette, signature), and each age stage too`);
  if (s.format === "F3" && !s.characters.some((c) => (c.age_stages ?? []).length >= 2)) problems.push(`a life montage (F3) needs a character with at least two "age_stages"`);
  return problems.length ? problems.join(". ") : null;
}

/** The first of each id only: a second "c1" would let a scene point at either of two characters. */
function firstOfEach<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/** One proposed scenario, validated as BRIEF parts; null when it is not usable for this kind. */
export function readScenario(raw: unknown, slots: BrainSlots, rules: ScenarioRules = {}): Scenario | null {
  const r = obj(raw);
  const title = modelText(r.title, CAP.title);
  const idea = modelText(r.idea, CAP.idea);
  if (!title || !idea || !slots.kind) return null;
  const characters = firstOfEach(arr(r.characters).slice(0, CAP.characters).map((c, i): BriefCharacter => {
    const o = obj(c);
    const look = readLook(o.look);
    const stages = firstOfEach(arr(o.age_stages).slice(0, CAP.stages).map(obj).map((a, k): AgeStage | null => {
      const l = readLook(a.look);
      const label = modelText(a.label, CAP.name);
      return l && label ? { id: sid(a.id, `a${k + 1}`), label, look: l } : null;
    }).filter((a): a is AgeStage => a !== null));
    return { id: sid(o.id, `c${i + 1}`), name: modelText(o.name, CAP.name), description: modelText(o.description, CAP.description),
             image_prompt: modelText(o.image_prompt, CAP.imagePrompt), asset_id: null, character_id: null, source: "prompt",
             ...(look ? { look } : {}), ...(stages.length ? { age_stages: stages } : {}) };
  }).filter((c) => c.name));
  const locations = firstOfEach(arr(r.locations).slice(0, CAP.locations).map((c, i): BriefLocation => {
    const o = obj(c);
    return { id: sid(o.id, `l${i + 1}`), name: modelText(o.name, CAP.name), description: modelText(o.description, CAP.description),
             image_prompt: modelText(o.image_prompt, CAP.imagePrompt), asset_id: null };
  }).filter((c) => c.name));
  const props = firstOfEach(arr(r.props).slice(0, CAP.props).map((c, i): BriefProp => {
    const o = obj(c);
    return { id: sid(o.id, `p${i + 1}`), name: modelText(o.name, CAP.name), description: modelText(o.description, CAP.description) };
  }).filter((c) => c.name));
  const known = { c: new Set(characters.map((c) => c.id)), l: new Set(locations.map((l) => l.id)), p: new Set(props.map((p) => p.id)) };
  const chapters = firstOfEach(arr(r.chapters).slice(0, CAP.chapters).map((c, i): OutlineChapter => {
    const o = obj(c);
    const start = num(o.start_s);
    return { id: sid(o.id, `ch${i + 1}`), title: modelText(o.title, CAP.title), ...(start !== undefined && start >= 0 ? { start_s: Math.round(start) } : {}),
             seconds: sceneSeconds(o.seconds),
             beats: arr(o.beats).slice(0, CAP.beats).map((b) => ({ at_s: Math.max(0, Math.round(num(obj(b).at_s) ?? 0)), text: modelText(obj(b).text, CAP.beat) }))
               .filter((b) => b.text),
             ...(oneOf(o.beat, STORY_BEATS) ? { beat: oneOf(o.beat, STORY_BEATS) } : {}),
             ...(modelText(o.emotion, CAP.emotion) ? { emotion: modelText(o.emotion, CAP.emotion) } : {}),
             ...(modelText(o.music_cue, CAP.craft) ? { music_cue: modelText(o.music_cue, CAP.craft) } : {}) };
  }).filter((c) => c.title));
  // The length is always the one the person chose (S1_GAPS G1: it used to become whatever the model's scenes added up to).
  const target_seconds = slots.target_seconds ?? (slots.kind === "short" ? FILM.targetMin : RUN_DURATIONS_S[0]);
  const story = { logline: modelText(obj(r.story).logline, CAP.logline), conflict: modelText(obj(r.story).conflict, CAP.logline) };
  const visual = modelText(r.visual_style, CAP.visualStyle);
  const craft = slots.kind === "short" ? readCraft(r, new Set(chapters.map((c) => c.id)), known.p) : {};
  const base = { title, idea, story, characters, locations, props, target_seconds, ...(visual ? { visual_style: visual } : {}), ...craft };

  // Where each chapter starts, from the lengths when every one is known (Probe M7: a long outline's chapters had the model's own
  // start_s, or 0). When a length is missing, the model's start_s is kept if it gave one, else none: never a made-up 0.
  const allTimed = chapters.length > 0 && chapters.every((c) => c.seconds !== null);
  const fromLengths = (list: OutlineChapter[]) => {
    let at = 0;
    return list.map((c) => { const start_s = at; at += c.seconds ?? 0; return { ...c, start_s }; });
  };

  if (slots.kind === "long") {
    // Run now cuts its own scenes: a long scenario's scenes are informational, and a fresh outline has none.
    const scenes = rules.outline ? [] : arr(r.scenes).slice(0, FILM.maxScenes).map((sc) => readSceneParts(sc, "long", known))
      .filter((x): x is SceneParts => x !== null)
      .map(({ seconds, ...x }, i): BriefScene => ({ ...x, id: `s${i + 1}`, n: i + 1, duration_s: Math.max(1, seconds ?? 10) }));
    return { ...base, chapters: allTimed ? fromLengths(chapters) : chapters, scenes };
  }

  // A short outline is usable only when its chapters add up to the person's length, each long enough for one scene. One that does
  // not is not proposed: nothing downstream stretches, shrinks or drops a chapter to make it fit.
  const outlined = chapters.length > 0 && chapters.every((c) => c.seconds !== null && c.seconds >= FILM.sceneMin)
    && chapters.reduce((a, c) => a + (c.seconds ?? 0), 0) === target_seconds;
  const timed = outlined ? fromLengths(chapters) : chapters;
  if (rules.outline) {
    if (!outlined) return null;
    const s: Scenario = { ...base, chapters: timed, scenes: [] };
    // A fresh story outline that misses the grammar is not proposed; the reason goes back to the model once (readModelAnswer).
    if (rules.story) {
      const problem = storyProblem(s);
      if (problem) { rules.problems?.push(problem); return null; }
    }
    return s;
  }

  // A payload stored before the plan step: its storyboard is kept only when every scene is a length a film takes and they add up
  // to the person's length exactly. Otherwise it is an outline (planned like a fresh one) or nothing.
  const parts = arr(r.scenes).slice(0, FILM.maxScenes + 1).map((sc) => readSceneParts(sc, "short", known));
  const storyboard = parts.length > 0 && parts.length <= FILM.maxScenes
    && parts.every((x) => x !== null && x.seconds !== null && x.seconds >= FILM.sceneMin && x.seconds <= FILM.sceneMax)
    && parts.reduce((a, x) => a + (x?.seconds ?? 0), 0) === target_seconds;
  if (!outlined && !storyboard) return null;
  const scenes = storyboard
    ? (parts as SceneParts[]).map(({ seconds, ...x }, i): BriefScene => ({ ...x, id: `s${i + 1}`, n: i + 1, duration_s: seconds ?? 0 }))
    : [];
  return { ...base, chapters: timed, scenes };
}

export interface ModelAnswer {
  /** The plan's own safety rule refused the request (the prompt's "refused"): the server answers with its own words. */
  refused?: boolean;
  reply: string;
  slots: BrainSlots;
  lengthOutOfRange: boolean;
  card: BrainCard | null;
  scenarios: Scenario[];
  step: "asking" | "proposing";
  /** Every slot was known but too few outlines followed the story grammar: the server's reason, for the turn's one re-ask. */
  storyProblem?: string;
}

/** The model's raw text → what may be shown, or null when it is not the JSON we asked for (the turn then fails honestly). */
export interface AnswerRules {
  /** A greeting or identity question: the slots stay as they were. */
  freezeSlots?: boolean;
  /** Whether a short film can be made here now (Film Studio open). False: "short" is never taken and never offered. */
  shortAvailable?: boolean;
  /** Whether a long video can be made here (the conversation has a channel). False: "long" is never taken. */
  longAvailable?: boolean;
  /** The kind question's options, the server's own (i18n), in the person's language. */
  kindOptions?: string[];
  /** What replaces a reply that names a vendor or model (i18n identityReply). */
  identityReply?: string;
  /** The person's own change of an inferred slot (a chip): merged as said, whatever the model wrote, before the next question. */
  force?: Partial<Pick<BrainSlots, InferableSlot>>;
}

export function readModelAnswer(text: string, prev: BrainSlots, cardId: string, rules: AnswerRules = {}): ModelAnswer | null {
  const json = extractJson(text);
  if (!json) return null;
  if (json.refused === true || (typeof json.refused === "string" && json.refused.trim() !== "")) {
    return { refused: true, reply: "", slots: { ...prev }, lengthOutOfRange: false, card: null, scenarios: [], step: "asking" };
  }
  let reply = modelText(json.reply, CAP.reply, true);
  if (!reply) return null;
  if (rules.identityReply && namesVendor(reply)) reply = rules.identityReply;
  const merged = rules.freezeSlots ? { slots: { ...prev }, lengthOutOfRange: false } : mergeSlots(prev, json.slots, json.inferred);
  const { lengthOutOfRange } = merged;
  let slots = merged.slots;
  if (rules.force && Object.keys(rules.force).length) slots = mergeSlots(slots, rules.force).slots;
  // No dead option: a short film where Film Studio is closed is not taken (the kind question is asked again, without it).
  if (rules.shortAvailable === false && slots.kind === "short" && prev.kind !== "short") slots = { ...slots, kind: undefined, aspect: prev.aspect };
  if (rules.longAvailable === false && slots.kind === "long" && prev.kind !== "long") slots = { ...slots, kind: undefined, aspect: prev.aspect };
  const ask = nextSlot(slots);
  if (ask) {
    const c = card(json.card, ask, cardId, ask === "kind" ? rules.kindOptions : undefined);
    // The card is the assistant speaking too: a vendor name in it goes, the slot's own question (i18n) stands in.
    const clean = rules.identityReply && [c.thread_title, c.question, ...c.options].some(namesVendor)
      ? { ...c, thread_title: "", question: "", options: c.options.some(namesVendor) ? [] : c.options } : c;
    return { reply, slots, lengthOutOfRange, card: clean, scenarios: [], step: "asking" };
  }
  // Outlines only: one whose chapters do not add up to the person's length is not proposed (S1_GAPS G1).
  // A short film's outlines must follow the story grammar (storyProblem); one that does not is dropped, and when that leaves too
  // few the reasons go back to the model once (the route's re-ask).
  const problems: string[] = [];
  const scenarios = arr(json.scenarios).map((s) => readScenario(s, slots, { outline: true, story: slots.kind === "short", problems }))
    .filter((s): s is Scenario => s !== null).slice(0, MAX_SCENARIOS);
  // Fewer than two usable scenarios is not a proposal: no card either (every slot is known), the person can ask again.
  const enough = scenarios.length >= MIN_SCENARIOS;
  return { reply, slots, lengthOutOfRange, card: null, scenarios: enough ? scenarios : [], step: enough ? "proposing" : "asking",
           ...(!enough && problems.length ? { storyProblem: problems.map((p, i) => `outline ${i + 1}: ${p}`).join(". ") } : {}) };
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

/**
 * A FLOOR, not a filter: words that are never made into a picture or a clip here, checked on a chosen plan before any draft is saved
 * (the prompt's safety rules and the vendors' own come first; this catches what got past both). Sexual content, gore, self-harm,
 * deepfakes and famous people, and a few well-known characters someone else owns. Any script, letter boundaries both sides.
 */
const UNSAFE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:` +
    [
      String.raw`nudes?|nudit\p{L}*|nudist\p{L}*|naked\p{L}*|topless|porn\p{L}*|sex|sexual\p{L}*|sexy|erotic\p{L}*|nsfw|onlyfans|fetish\p{L}*|lingerie`,
      // "голы" alone is football goals (Lens on 0199): the adjective's own endings only.
      String.raw`гол(?:ый|ая|ое|ые|ую|ой|ым|ыми|ых)|голышом|раздет\p{L}*|порн\p{L}*|секс(?:уальн\p{L}*|и)?|эрот\p{L}*`,
      String.raw`yalang${AP}?och\p{L}*|яланғоч\p{L}*|яланг[ʻʼ'’‘]?оч\p{L}*|porno\p{L}*|shahvoniy\p{L}*|erotik\p{L}*`,
      String.raw`gory|gore[-\s]?fest|dismember\p{L}*|decapitat\p{L}*|behead\p{L}*|расчлен\p{L}*|обезглав\p{L}*`,
      String.raw`suicid\p{L}*|self[-\s]?harm\p{L}*|самоубийств\p{L}*|суицид\p{L}*|o${AP}?z\s+joniga\s+qasd`,
      String.raw`deepfake\p{L}*|deepfeyk\p{L}*|дипфейк\p{L}*|celebrit\p{L}*|знаменитост\p{L}*|mashhur\s+(?:odam|aktyor|xonanda)\p{L}*`,
      String.raw`mickey\s+mouse|spider[-\s]?man|batman|superman|pikachu|harry\s+potter|darth\s+vader|super\s+mario|elsa\s+(?:from\s+)?frozen`,
    ].join("|") +
    String.raw`)(?![\p{L}\p{N}])`,
  "iu",
);
export function unsafeText(text: string): boolean {
  const base = text.normalize("NFKC").replace(FORMAT, "");
  return UNSAFE.test(base) || UNSAFE.test(foldForCheck(base));
}
/** Every text of a chosen plan that becomes a picture, a clip or a spoken line. */
export function unsafeBrief(b: Brief): boolean {
  // The style and the audience too: the style is appended to every scene's prompt (filmFromBrief).
  const parts: string[] = [b.title ?? "", b.idea ?? "", b.story?.logline ?? "", b.story?.conflict ?? "", b.style ?? "", b.audience ?? ""];
  const looks = (l?: CharacterLook) => (l ? Object.values(l) : []);
  parts.push(b.visual_style ?? "", b.hook ?? "", b.planted_object?.text ?? "", b.closing_card ?? "", b.cover_title ?? "");
  for (const c of b.characters ?? []) parts.push(c.name, c.description, c.image_prompt, ...looks(c.look), ...(c.age_stages ?? []).flatMap((a) => [a.label, ...looks(a.look)]));
  for (const l of b.locations ?? []) parts.push(l.name, l.description, l.image_prompt);
  for (const s of b.scenes ?? []) {
    parts.push(s.title, s.visual_prompt, ...s.dialogue.map((d) => d.line), s.narration ?? "", s.first_frame ?? "", s.last_frame ?? "", s.motion ?? "",
               s.lighting ?? "", s.camera?.position ?? "", s.sfx ?? "", ...(s.text_layers ?? []).map((t) => t.text));
  }
  for (const ch of b.chapters ?? []) parts.push(ch.title, ...ch.beats.map((x) => x.text), ch.emotion ?? "", ch.music_cue ?? "");
  return parts.some((p) => typeof p === "string" && unsafeText(p));
}

/** The BRIEF v1 the canvas draws, from the slots and (once chosen) one scenario. */
export function buildBrief(sessionId: string, slots: BrainSlots, chosen: Scenario | null, status: Brief["status"], price?: BriefPrice): Brief {
  const b: Brief = {
    version: 1, session_id: sessionId, status,
    kind: slots.kind ?? null, language: slots.language ?? null, audience: slots.audience ?? null, style: slots.style ?? null,
    aspect: slots.aspect ?? null, target_seconds: chosen?.target_seconds ?? slots.target_seconds ?? null,
    // A long video keeps Run now's own voice handling. A short film is heard as its scenes are planned (speechOf); before its
    // storyboard is written nothing is said about its voice yet ("off": no voice step drawn).
    voice: slots.kind === "long" ? { mode: "pipeline" } : speechVoice(chosen?.scenes ?? []),
    music: { mode: "off" },
    handoff: null,
  };
  // BRIEF v1's chapter has no `seconds`: start_s already says where each begins (the contract is not widened by the plan step).
  if (chosen) {
    Object.assign(b, { title: chosen.title, idea: chosen.idea, story: chosen.story,
                       chapters: chosen.chapters.map(({ id, title, start_s, beats, beat, emotion, music_cue }) =>
                         ({ id, title, start_s, beats, ...(beat ? { beat } : {}), ...(emotion ? { emotion } : {}), ...(music_cue ? { music_cue } : {}) })),
                       characters: chosen.characters, locations: chosen.locations, props: chosen.props, scenes: chosen.scenes });
    for (const k of ["visual_style", "format", "hook", "planted_object", "twist", "closing_card", "cover_title", "speech_intent"] as const) {
      if (chosen[k] !== undefined) Object.assign(b, { [k]: chosen[k] });
    }
    const layers = textLayers(chosen);
    if (layers.length) b.text_layers = layers;
  }
  if (price) b.price = price;
  return b;
}

/** What the film's clip model makes, read server-side from its spec (durations_s); `durations: null` = not known. */
export interface ClipShape { durations: number[] | null; maxShots: number }

/**
 * How many shots a scene of `planned` seconds takes on a clip model whose shots are at most `longest` seconds (S1_GAPS G4): one
 * shot per `longest`, up to max_shots. Unknown lengths are not guessed: null, and the film keeps save_film's default of one shot, so
 * quote_film's own refusal ("scene_too_long_for_model", "model_not_set") is what the person reads.
 */
export function shotCount(planned: number, clip: ClipShape | null): number | null {
  const longest = clip?.durations?.length ? Math.max(...clip.durations) : null;
  if (!longest || !Number.isFinite(planned) || planned <= 0) return null;
  return Math.min(Math.max(1, clip!.maxShots), Math.max(1, Math.ceil(planned / longest)));
}

/**
 * A short BRIEF's draft settings and source text, without its scenes: what create_film_draft takes (0166). The draft is made before
 * the storyboard is written (Breach BR-S1-03: a draft the workspace cannot make must be refused before the plan's turns are spent),
 * so nothing here may depend on a scene.
 */
export function draftSettings(b: Brief): { settings: Record<string, unknown>; sourceText: string } | null {
  if (b.kind !== "short" || !b.language || !b.title) return null;
  return {
    settings: { title: plain(b.title, FILM.titleMax), language: filmLanguage(b.language), aspect: b.aspect ?? "16:9", target_seconds: b.target_seconds },
    sourceText: plain([b.idea, b.story?.logline].filter(Boolean).join("\n"), 2000, true),
  };
}

/**
 * Whether a clip's own sound reaches the finished film. It does not today: the assembly cuts every video segment with "-an"
 * (modules/render_backend.py) and mixes only the narration take and the music (modules/film_assembly.py). So a scene spoken inside
 * its clip would be paid for and then heard by nobody. This is the ONE check that says so (speechBlocks): S2's clip-audio fix flips
 * it, and nothing else needs to change for in-clip speech to be offered at Create.
 */
export const CLIP_SOUND_IN_CUT = false;

/**
 * Whether an in-clip line can reach the clip without reaching the key frame. It cannot today: film_scenes has ONE visual_prompt
 * (0166/0171), which makes both, and an image model told 'says: "…"' draws the words. S2's clip-prompt path flips it.
 */
export const CLIP_PROMPT_SAVED = false;

/**
 * How a scene may be heard in a film planned NOW, from the same inputs as speechBlocks: a voice-over only when the film has a voice
 * a quote can price, in-clip speech only when the cut keeps clip sound AND the lines have a clip prompt of their own. Today that is
 * "none" alone, so a speaking film is never planned (and never paid for to be made silent); the format's intended speech is kept as
 * `speech_intent`. ONE helper, used by the chat's choose and the film editor's writer alike.
 */
export function speechAllowed(voiceQuotable: boolean): SceneSpeech[] {
  return ["none", ...(voiceQuotable ? (["voice_over"] as const) : []), ...(CLIP_SOUND_IN_CUT && CLIP_PROMPT_SAVED ? (["in_clip"] as const) : [])];
}

/** A film voice a quote can price (0171 prices only a creative_tts voice with its model): the one input speechAllowed takes. */
export function voiceQuotable(voice: unknown): boolean {
  const v = voice && typeof voice === "object" && !Array.isArray(voice) ? (voice as { source?: unknown; model?: unknown; voice_id?: unknown }) : null;
  return !!v && v.source === "creative_tts" && typeof v.model === "string" && v.model !== "" && typeof v.voice_id === "string" && v.voice_id !== "";
}

/** Why Create is not offered for a film yet, by name (the panel says each in its own words; nothing is ever shipped silent). */
export type SpeechBlock = "clip_sound_not_kept" | "voice_unavailable";

/** How a scene is heard: its own `speech`, or for a scene stored before it, what it carries (lines, a narration, or nothing). */
export function speechOf(s: Pick<BriefScene, "dialogue"> & { speech?: SceneSpeech; narration?: string }): SceneSpeech {
  if (s.speech) return s.speech;
  // A stored BRIEF is data: a scene without its dialogue list is read as having none.
  if ((s.dialogue ?? []).length) return "in_clip";
  return s.narration ? "voice_over" : "none";
}

/** The BRIEF's voice from its scenes: a voice-over when any scene has one; the clips' own sound when only clips speak. */
export function speechVoice(scenes: BriefScene[]): Brief["voice"] {
  const kinds = new Set(scenes.map(speechOf));
  return { mode: kinds.has("voice_over") ? "narration" : kinds.has("in_clip") ? "clip_audio" : "off" };
}

/**
 * What stops this film at Create today, in a fixed order. `voiceReady`: the film has a voice a quote could price. No film voice can
 * be chosen yet (no function sets one on a draft from here, and the film editor has no voice picker), so a voice-over film is
 * refused by name, never made without its narration and never given the clips' own sound instead (CLAUDE.md rule 4).
 */
export function speechBlocks(scenes: BriefScene[], voiceReady: boolean): SpeechBlock[] {
  const kinds = new Set(scenes.map(speechOf));
  const out: SpeechBlock[] = [];
  if (kinds.has("in_clip") && !CLIP_SOUND_IN_CUT) out.push("clip_sound_not_kept");
  if (kinds.has("voice_over") && !voiceReady) out.push("voice_unavailable");
  return out;
}

/** Every on-screen word of the film as a layer (scene id, text, where), the closing card on the last scene. */
export function textLayers(s: Pick<Scenario, "scenes" | "closing_card">): TextLayer[] {
  const out: TextLayer[] = s.scenes.flatMap((sc) => (sc.text_layers ?? []).map((t) => ({ scene_id: sc.id, text: t.text, position: t.position })));
  const last = s.scenes[s.scenes.length - 1];
  if (s.closing_card && last && !out.some((t) => t.scene_id === last.id && t.text === s.closing_card)) {
    out.push({ scene_id: last.id, text: s.closing_card, position: "center" });
  }
  return out;
}

/** What a scene's prompt is assembled from: its own words and references, and the film's characters, locations and style. */
export type PromptScene = Pick<BriefScene, "visual_prompt" | "character_ids" | "location_id" | "dialogue"> &
  Partial<Pick<BriefScene, "speech" | "narration" | "shot" | "camera" | "lighting" | "first_frame" | "motion" | "in_frame" | "text_layers">>;
export type PromptFilm = { characters?: BriefCharacter[] | null; locations?: BriefLocation[] | null; style?: string | null; visual_style?: string | null };

const SHOT_WORDS: Record<ShotSize, string> = {
  wide: "Wide establishing shot", two_shot: "Two-shot", medium: "Medium shot", close: "Close-up", extreme_close: "Extreme close-up",
  over_shoulder: "Over-the-shoulder shot", insert: "Insert shot",
};
const MOVE_WORDS: Record<CameraMove, string> = {
  static: "static camera", push_in: "slow push in", pull_out: "slow pull out", pan: "pan", tilt: "tilt", tracking: "tracking shot", handheld: "handheld",
};

/** A character as every prompt it is in says it: its look sheet verbatim (at the scene's age stage), or the older free description. */
export function characterLine(c: BriefCharacter, stageId: string | null): string {
  const stage = stageId ? (c.age_stages ?? []).find((a) => a.id === stageId) : undefined;
  const l = stage?.look ?? c.look;
  if (!l) return `${c.name}: ${c.description || c.image_prompt}`;
  const parts = [`face ${l.face}`, `hair ${l.hair}`, `build ${l.build}`, `outfit ${l.outfit}`, `palette ${l.palette}`, `signature ${l.signature}`]
    .filter((p) => !/ $/.test(p));
  return `${c.name}${stage ? ` (${stage.label})` : ""}: ${parts.join("; ")}`;
}

/** What every visual prompt ends with before its style (BR-SG-05: the closing card's scene used to be drawn with text). */
export const NO_TEXT = "No text, no letters, no signage.";

function promptParts(b: PromptFilm, s: PromptScene, role: "keyframe" | "clip" | "scene"): string {
  const chars = b.characters ?? [];
  const inFrame = s.in_frame?.length ? s.in_frame : s.character_ids.map((id) => ({ character_id: id, age_stage: null }));
  const described = inFrame.map((x) => ({ c: chars.find((c) => c.id === x.character_id), stage: x.age_stage }))
    .filter((x): x is { c: BriefCharacter; stage: string | null } => !!x.c).map((x) => characterLine(x.c, x.stage)).join(". ");
  const loc = (b.locations ?? []).find((l) => l.id === s.location_id);
  const speech = speechOf(s);
  const camera = s.camera ? `Camera: ${[s.camera.position, role === "keyframe" ? "" : MOVE_WORDS[s.camera.move]].filter(Boolean).join(", ")}.` : "";
  const head = s.shot ? `${SHOT_WORDS[s.shot]}. ${camera}`.trim() : camera;
  // The spoken lines reach the CLIP only, and only once a clip has a prompt of its own and the cut keeps its sound: a key frame is a
  // still picture (an image model told "says: …" draws a speech bubble or the words), and today one prompt makes both.
  const names = new Map(chars.map((c) => [c.id, c.name]));
  const lines = role === "clip" && speech === "in_clip" && CLIP_SOUND_IN_CUT && CLIP_PROMPT_SAVED
    ? s.dialogue.map((d) => `${names.get(d.character_id) ?? "A character"} says: "${d.line}"`).join(" ") : "";
  const style = b.visual_style || b.style;
  return plain([
    head,
    role !== "clip" && s.first_frame ? `First frame: ${s.first_frame}` : "",
    s.visual_prompt,
    role !== "keyframe" && s.motion ? `Motion: ${s.motion}` : "",
    described ? `Characters: ${described}` : "",
    loc ? `Setting: ${loc.name}. ${loc.image_prompt || loc.description}` : "",
    s.lighting ? `Lighting: ${s.lighting}` : "",
    lines,
    // A voice-over scene's characters must not appear to talk over the narrator; never said of a scene spoken in its clip.
    speech === "voice_over" ? "No one speaks; mouths closed." : "",
    // On EVERY prompt: on-screen words (a card, a bill, the closing card) are always layers added in the edit, never drawn (they
    // come out misspelt and in the wrong script), and a scene with no text layer of its own can still sprout a sign.
    NO_TEXT,
    style ? `Style: ${style}` : "",
  ].filter(Boolean).join("\n"), Number.MAX_SAFE_INTEGER, true);
}

/** The key frame's prompt: the shot, its first frame, the characters' looks, the setting, the light and the style; no spoken line. */
export const keyframePrompt = (b: PromptFilm, s: PromptScene): string => promptParts(b, s, "keyframe");
/** The clip's prompt: the shot and the camera's move, the motion, the looks, and (speech `in_clip` only) the lines spoken. */
export const clipPrompt = (b: PromptFilm, s: PromptScene): string => promptParts(b, s, "clip");

/**
 * The prompt a scene is SAVED with (film_scenes.visual_prompt). Today one column makes both the key frame and the clip (0171), so it
 * is the key frame's and the clip's folded together without any spoken line: in-clip lines need a clip prompt of their own, which
 * is S2's (and a film with in-clip speech is refused at Create until the cut keeps clip sound, CLIP_SOUND_IN_CUT). Never cut (S9,
 * creative_price 0218): a prompt the models cannot take is refused by name, because a cut one drops the style or a character's look
 * without anyone being told. Its length is counted the way 0218 counts it, in UTF-16 units (`.length`): an emoji is two.
 */
export function scenePrompt(b: PromptFilm, s: PromptScene): string {
  return promptParts(b, s, "scene");
}

/** The first scene whose whole prompt (saved or clip) is over `limit` UTF-16 units (1-based, in story order), or null. */
export function promptOverLimit(b: Brief, limit: number): { scene: number; limit: number; length: number } | null {
  for (const [i, s] of (b.scenes ?? []).entries()) {
    const length = Math.max(scenePrompt(b, s).length, clipPrompt(b, s).length);
    if (length > limit) return { scene: i + 1, limit, length };
  }
  return null;
}

/** The film a short BRIEF becomes: the settings and scenes create_film_draft / save_film take (0166). A voice-over scene's narration
 *  goes into its narration column; a scene spoken in its clip asks the clip for its sound (0166 makes that a choice, never a
 *  default); a voice-over or wordless scene asks for none. `promptMax` is the plan's prompt limit (planLimits): a scene over it makes
 *  no film at all rather than a cut one; the route refuses it first as prompt_too_long.
 *  It writes no `negative_prompt` and no `seed`: 0218 refuses a seed on every model and a negative prompt on any model whose
 *  registry row does not take one, and nothing here is the person's choice of either. */
export function filmFromBrief(b: Brief, clip: ClipShape | null = null, promptMax: number = FILM.promptMax): { settings: Record<string, unknown>; scenes: Record<string, unknown>[]; sourceText: string } | null {
  if (b.kind !== "short" || !b.scenes?.length || !b.language || !b.title) return null;
  if (promptOverLimit(b, promptMax)) return null;
  const scenes = b.scenes.map((s) => {
    const shots = shotCount(s.duration_s, clip);
    const speech = speechOf(s);
    return {
      title: s.title, narration: speech === "voice_over" ? s.narration ?? "" : "", visual_prompt: scenePrompt(b, s), planned_seconds: s.duration_s,
      ...(shots !== null ? { shot_count: shots } : {}),
      // Never while the cut drops clip sound: the dearer audio variant would be paid for and thrown away (BR-SG-01).
      ...(speech === "in_clip" && CLIP_SOUND_IN_CUT ? { clip_params: { audio: true } } : {}),
    };
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
