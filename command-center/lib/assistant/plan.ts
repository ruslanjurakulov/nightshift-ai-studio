/**
 * The Assistant ("Yordamchi") — one goal → a plan with one total price → one
 * confirm. This is the pure half: reading the goal, the plan's steps and how
 * they are edited, what each step asks the existing routes for, and the total.
 *
 * The planner is deterministic on purpose. It reads the count, the kind, the
 * shape, the length, the language and the channel out of the words, and
 * calls nothing: making a plan is free, and the same words always make the
 * same plan, so it can be tested. Every price still comes from the database
 * (/api/creative/quote, /api/credits/estimate) — nothing here computes one —
 * and a step that cannot be priced blocks the confirm instead of being guessed.
 *
 * Confirming creates each item with the building blocks that already exist:
 * a creative job (quote → `max_credits`, one idempotency key per item) or a
 * channel Run now (the same hold, the same approval gate). The keys are
 * derived from the plan's id, so a second press or a reload re-sends the same
 * keys and the server answers the first job instead of starting another.
 */
import { STUDIO_TEMPLATES, type TemplateId } from "@/lib/creative/templates";
import {
  ASPECT_RATIOS,
  PROMPT_MAX,
  VIDEO_DURATIONS,
  buildParams,
  modelsFor,
  type AspectRatio,
  type StudioModel,
  type VideoDuration,
} from "@/lib/creative/studio";
import { HOME_LANGUAGES, HOME_LENGTHS, defaultLanguage, isHomeLanguage, type HomeLanguage } from "@/lib/home";
import type { CreativeCapability } from "@/lib/creative/operations";
import type { Locale } from "@/lib/i18n";

// ── the plan ────────────────────────────────────────────────────────────────

/** What a step makes. `video` is a full channel run; the rest are Studio generations. */
export const STEP_KINDS = ["video", "thumbnail", "cover", "image", "clip", "voice"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** The most items one step makes, and the most steps one plan has. */
export const MAX_COUNT = 10;
export const MAX_STEPS = 6;
export const GOAL_MAX = 500;
/** A run's topic as the run route caps it; a theme shared by several runs is a niche (120). */
export const TOPIC_MAX = 300;
export const NICHE_MAX = 120;

/** The run lengths a step offers: the ones Home and CreateStudio already list. */
export const RUN_LENGTHS_S: readonly number[] = HOME_LENGTHS.map((l) => l.seconds);
export const SHORT_S = 60;
const DEFAULT_VIDEO_S = 600;

export interface PlanStep {
  /** Stable within the plan ("s1", "s2"…): part of every item's idempotency key. */
  id: string;
  kind: StepKind;
  count: number;
  /** The channel a video is made for (runs only). */
  channelSlug: string | null;
  /** The script language (runs) or the spoken language (voice). */
  language: HomeLanguage;
  /** Runs: seconds, one of RUN_LENGTHS_S. */
  durationS: number;
  /** Pictures and clips. */
  aspect: AspectRatio;
  /** Clips: seconds. */
  clipSeconds: VideoDuration;
  /** Runs: the topic (one video) or the theme each video picks a topic within (several). Others: the description / the words. */
  text: string;
}

export interface Plan {
  id: string;
  goal: string;
  theme: string;
  steps: PlanStep[];
  /** The next step number, so an added step never reuses a removed step's id (and its keys). */
  seq: number;
  /** Nothing in the words said what to make: the plan starts with one video. */
  guessed: boolean;
}

/** A channel the Assistant can make a video for (verified: rule 7). */
export interface PlannerChannel {
  /** channel_id — what the run route takes. */
  id: string;
  slug: string;
  name: string;
  /** The channel's configured script language, free text ("" = the deployment's default). */
  language: string;
}

export interface PlannerContext {
  locale: Locale;
  channels: PlannerChannel[];
  currentSlug: string | null;
}

/** The longest words a step takes: a run's topic as the run route caps it, else the Studio's limit. */
export function textMax(kind: StepKind): number {
  return kind === "video" ? TOPIC_MAX : PROMPT_MAX;
}

export function isRunKind(kind: StepKind): boolean {
  return kind === "video";
}

const KIND_CAPABILITY: Record<Exclude<StepKind, "video">, CreativeCapability> = {
  thumbnail: "t2i",
  cover: "t2i",
  image: "t2i",
  clip: "t2v",
  voice: "tts",
};

export function stepCapability(kind: StepKind): CreativeCapability | null {
  return kind === "video" ? null : KIND_CAPABILITY[kind];
}

const KIND_TEMPLATE: Record<Exclude<StepKind, "video" | "voice">, TemplateId> = {
  thumbnail: "yt_thumbnail",
  cover: "shorts_cover",
  image: "story_scene",
  clip: "broll",
};

const KIND_ASPECT: Record<StepKind, AspectRatio> = {
  video: "16:9",
  thumbnail: "16:9",
  cover: "9:16",
  image: "16:9",
  clip: "16:9",
  voice: "16:9",
};

/**
 * The words of a voice intro, in the language it is spoken in. The Studio's
 * own template is English; a voice in Uzbek or Russian must say Uzbek or
 * Russian words, so the planner carries the same intro in each.
 */
const VOICE_INTRO: Record<HomeLanguage, string> = {
  English: STUDIO_TEMPLATES.find((t) => t.id === "voice_intro")?.prompt ?? "",
  Russian: "С возвращением на канал! Сегодня говорим про [topic] — досмотрите до конца, будет сюрприз.",
  Uzbek: "Kanalga xush kelibsiz! Bugun [topic] haqida gaplashamiz — oxirigacha ko'ring, sizni syurpriz kutmoqda.",
};

const BRACKETS = /\[[^\]]*\]/g;

/** The starter words of a step: the Studio's template with the theme put into its [brackets]. */
export function starterText(kind: StepKind, theme: string, language: HomeLanguage, aspect?: AspectRatio): string {
  const th = theme.trim();
  if (kind === "video") return th.slice(0, TOPIC_MAX);
  const template =
    kind === "voice"
      ? VOICE_INTRO[language]
      : (STUDIO_TEMPLATES.find((t) => t.id === (kind === "clip" && aspect === "9:16" ? "shorts_clip" : KIND_TEMPLATE[kind]))
          ?.prompt ?? "");
  return th ? template.replace(BRACKETS, th) : template;
}

// ── reading the goal ────────────────────────────────────────────────────────

/** Uzbek has several apostrophes (ʻ ʼ ' ’ ‘); one is enough to match on. */
function normalize(s: string): string {
  return s.replace(/[ʻʼ’‘`]/g, "'").toLowerCase();
}

const L = "\\p{L}";
const KIND_PATTERNS: { kind: StepKind | "short"; re: RegExp }[] = [
  { kind: "short", re: new RegExp(`(?<!${L})(?:shorts?\\s+videos?(?!${L})|qisqa\\s+video${L}*|коротк${L}*\\s+(?:видео|ролик${L}*)|shorts?${L}*|шортс${L}*|шорт${L}*|reels?(?!${L})|рилс${L}*)`, "gu") },
  { kind: "voice", re: new RegExp(`(?<!${L})(?:голосов${L}*\\s+(?:интро|приветстви${L}*|вступлени${L}*)|voice[\\s-]*(?:intro|over)s?(?!${L})|voiceovers?(?!${L})|narrations?(?!${L})|intros?(?!${L})|озвучк${L}*|интро(?!${L})|голос${L}*|ovozli\\s+kirish${L}*|ovoz${L}*|kirish\\s+so'z${L}*)`, "gu") },
  { kind: "thumbnail", re: new RegExp(`(?<!${L})(?:thumbnails?(?!${L})|thumbs?(?!${L})|превью(?!${L})|обложк${L}*|миниатюр${L}*|muqova${L}*|thumbnail${L}*)`, "gu") },
  { kind: "cover", re: new RegExp(`(?<!${L})(?:covers?(?!${L}))`, "gu") },
  { kind: "image", re: new RegExp(`(?<!${L})(?:images?(?!${L})|pictures?(?!${L})|illustrations?(?!${L})|photos?(?!${L})|картин${L}*|изображен${L}*|иллюстрац${L}*|рисун${L}*|rasm${L}*|surat${L}*)`, "gu") },
  { kind: "clip", re: new RegExp(`(?<!${L})(?:videoclips?(?!${L})|video\\s+clips?(?!${L})|видеоклип${L}*|clips?(?!${L})|b-?roll(?!${L})|клип${L}*|klip${L}*)`, "gu") },
  { kind: "video", re: new RegExp(`(?<!${L})(?:videos?(?!${L})|видео${L}*|ролик${L}*|video${L}*)`, "gu") },
];

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3,
  один: 1, одна: 1, одно: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
  bir: 1, ikki: 2, uch: 3, "to'rt": 4, besh: 5, olti: 6, yetti: 7, sakkiz: 8, "to'qqiz": 9, "o'n": 10,
};

/** "for my next video", "для видео", "video uchun": the kind names the context, not a thing to make. */
const CONTEXT_BEFORE = new Set(["for", "to", "для", "к", "ко", "под"]);
const CONTEXT_AFTER = new Set(["uchun"]);

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokens(s: string): Token[] {
  const out: Token[] = [];
  for (const m of s.matchAll(/[\p{L}\p{N}'×:-]+/gu)) out.push({ text: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  return out;
}

function numberOf(tok: string): number | null {
  const d = /^(\d{1,3})(?:ta|x)?$/.exec(tok);
  if (d) return Number(d[1]);
  return NUMBER_WORDS[tok] ?? null;
}

const MINUTE_WORD = /^(?:min\p{L}*|мин\p{L}*|daqiqa\p{L}*)$/u;
const DURATION_TOKEN = /^\d{1,3}-?(?:min\p{L}*|мин\p{L}*|daqiqa\p{L}*)$/u;

interface KindHit {
  kind: StepKind | "short";
  start: number;
  end: number;
}

function kindHits(norm: string): KindHit[] {
  const all: KindHit[] = [];
  for (const p of KIND_PATTERNS) {
    for (const m of norm.matchAll(p.re)) {
      const start = m.index ?? 0;
      all.push({ kind: p.kind, start, end: start + m[0].length });
    }
  }
  // Earlier first; at the same place the longer phrase ("qisqa video" over "video").
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: KindHit[] = [];
  for (const h of all) {
    if (out.some((o) => h.start < o.end && o.start < h.end)) continue;
    out.push(h);
  }
  return out;
}

/**
 * The count in front of a kind — the nearest number up to three words back
 * ("5 ta shorts", "3 new thumbnails", "two 10-minute videos"), 1 when none.
 * Null: the kind is context, not a thing to make ("for my next video").
 */
function countBefore(toks: Token[], hit: KindHit, prevEnd: number): number | null {
  const before = toks.filter((t) => t.end <= hit.start && t.start >= prevEnd).slice(-3);
  const after = toks.find((t) => t.start >= hit.end);
  if (after && CONTEXT_AFTER.has(after.text)) return null;
  for (let i = before.length - 1; i >= 0; i--) {
    const w = before[i].text;
    if (DURATION_TOKEN.test(w)) continue;
    const n = numberOf(w);
    if (n !== null) {
      // "10 minutes": a length, not a count.
      const next = toks.find((t) => t.start >= before[i].end);
      if (next && MINUTE_WORD.test(next.text)) continue;
      return n;
    }
    if (CONTEXT_BEFORE.has(w)) return null;
  }
  return 1;
}

/** "10-minute", "10 minutes", "10 минут", "10 daqiqalik" → seconds, or null. */
export function parseMinutes(norm: string): number | null {
  const m = /(?<!\p{N})(\d{1,3})\s*-?\s*(?:min\p{L}*|мин\p{L}*|daqiqa\p{L}*)/u.exec(norm);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n * 60 : null;
}

/** The run length offered for a requested one: the smallest that is at least as long, else the longest. */
export function nearestRunLength(seconds: number): number {
  return RUN_LENGTHS_S.find((s) => s >= seconds) ?? RUN_LENGTHS_S[RUN_LENGTHS_S.length - 1];
}

/** Only an explicit "in Russian" / "на русском" / "o'zbekcha" sets the language — a theme like "Russian history" does not. */
export function parseLanguage(norm: string): HomeLanguage | null {
  const rules: [HomeLanguage, RegExp][] = [
    ["Uzbek", /(?:\bin\s+uzbek\b|на\s+узбекском|(?<!\p{L})o'?zbek(?:cha|\s+tilida))/u],
    ["Russian", /(?:\bin\s+russian\b|на\s+русском|(?<!\p{L})rus(?:cha|\s+tilida))/u],
    ["English", /(?:\bin\s+english\b|на\s+английском|(?<!\p{L})ingliz(?:cha|\s+tilida))/u],
  ];
  let best: { lang: HomeLanguage; at: number } | null = null;
  for (const [lang, re] of rules) {
    const m = re.exec(norm);
    if (m && (best === null || (m.index ?? 0) < best.at)) best = { lang, at: m.index ?? 0 };
  }
  return best?.lang ?? null;
}

export function parseAspect(norm: string): AspectRatio | null {
  if (/(?<!\p{L})(?:vertical|portrait|вертикальн\p{L}*|vertikal\p{L}*)|9:16/u.test(norm)) return "9:16";
  if (/(?<!\p{L})(?:square|квадрат\p{L}*|kvadrat\p{L}*)|1:1/u.test(norm)) return "1:1";
  if (/(?<!\p{L})(?:horizontal|landscape|горизонтальн\p{L}*|gorizontal\p{L}*)|16:9/u.test(norm)) return "16:9";
  return null;
}

/** "… and 3 ", "…, a ", "… и 3 ", "… va 2 ta ": the words that join one thing to the next. */
const JOIN_TAIL = /(?:\s*(?:,|\band\b|\bplus\b|(?<!\p{L})и(?!\p{L})|(?<!\p{L})va(?!\p{L})|\+))\s*(?:\S+\s+){0,2}$/u;

const tidy = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:!?"'«»“”-]+|[\s,.;:!?"'«»“”-]+$/g, "")
    .trim();

/**
 * What the things are about: after "about" / "про" / "на тему", or before
 * "haqida". Cut where the next thing to make, the channel or the language
 * begins. "" when the words do not say — a run then lets the channel pick
 * its topic, and a picture keeps its [brackets] for the person to fill.
 */
export function parseTheme(goal: string): string {
  const src = goal.replace(/[ʻʼ’‘`]/g, "'");
  const norm = src.toLowerCase();
  const hits = kindHits(norm);
  let start = -1;
  let end = src.length;
  const marker = /(?<!\p{L})(?:about|regarding|on the topic of|про|на тему|обо|об|о)\s+/u.exec(norm);
  if (marker) {
    start = (marker.index ?? 0) + marker[0].length;
  } else {
    const haqida = /(?<!\p{L})(?:haqida|haqidagi|mavzusida)(?!\p{L})/u.exec(norm);
    if (!haqida) return "";
    end = haqida.index ?? 0;
    // Back to the last thing named before it ("5 ta shorts kosmos haqida" → "kosmos").
    const prior = hits.filter((h) => h.end <= end).pop();
    start = prior ? prior.end : 0;
    const head = norm.slice(start, end);
    const lead = /^(?:\s*(?:\d+\s*ta|uchun|kanalim\p{L}*|menga|mening|va|,))+/u.exec(head);
    if (lead) start += lead[0].length;
  }
  const after = norm.slice(start, end);
  const stops = [
    /\s+(?:for|in|on|to)\s+(?:my|our|the|this|a)\b/u,
    /\s+in\s+(?:english|russian|uzbek)\b/u,
    /\s+(?:для|на\s+(?:моём|моем|мой|канал|русском|английском|узбекском))(?!\p{L})/u,
    /\s+(?:kanal\p{L}*|uchun)(?!\p{L})/u,
    /[;.!?]/u,
  ];
  let cut = after.length;
  for (const re of stops) {
    const m = re.exec(after);
    if (m && (m.index ?? 0) < cut) cut = m.index ?? 0;
  }
  // The next thing to make ("… and 3 thumbnails") ends the theme, with its joining word.
  const nextHit = hits.find((h) => h.start >= start && h.start < start + cut);
  if (nextHit) {
    const upto = norm.slice(start, nextHit.start);
    const join = JOIN_TAIL.exec(upto);
    cut = Math.min(cut, join ? (join.index ?? upto.length) : upto.length);
  }
  const theme = tidy(src.slice(start, start + cut)).slice(0, NICHE_MAX);
  // "about 5 videos" is a count, not a subject.
  return /\p{L}{2}/u.test(theme) ? theme : "";
}

function pickChannel(norm: string, ctx: PlannerContext): PlannerChannel | null {
  const named = ctx.channels.find((c) => c.name.trim().length >= 3 && norm.includes(normalize(c.name.trim())));
  return named ?? ctx.channels.find((c) => c.slug === ctx.currentSlug) ?? ctx.channels[0] ?? null;
}

/** The channel's own language when it is one the plan offers, else the viewer's. */
function channelLanguage(ch: PlannerChannel | null, locale: Locale): HomeLanguage {
  const own = ch?.language.trim().toLowerCase() ?? "";
  const hit = HOME_LANGUAGES.find((l) => l.value.toLowerCase() === own || l.id === own);
  return hit ? hit.value : defaultLanguage(locale);
}

const clampCount = (n: number) => Math.max(1, Math.min(MAX_COUNT, Math.trunc(n) || 1));

/** A new step of `kind`, filled from the plan's theme, channel and language. */
export function newStep(
  id: string,
  kind: StepKind,
  base: { theme: string; channel: PlannerChannel | null; language: HomeLanguage; aspect?: AspectRatio | null; durationS?: number | null; count?: number },
): PlanStep {
  const aspect = base.aspect && kind !== "video" && kind !== "voice" ? base.aspect : KIND_ASPECT[kind];
  return {
    id,
    kind,
    count: clampCount(base.count ?? 1),
    channelSlug: base.channel?.slug ?? null,
    language: base.language,
    durationS: kind === "video" ? (base.durationS ?? DEFAULT_VIDEO_S) : DEFAULT_VIDEO_S,
    aspect,
    clipSeconds: 5,
    text: starterText(kind, base.theme, base.language, aspect),
  };
}

/**
 * The goal → a plan. Deterministic: the same words, channels and locale make
 * the same plan (the id is the caller's). Nothing is priced or sent here.
 */
export function planFromGoal(goal: string, ctx: PlannerContext, id: string): Plan {
  const text = goal.slice(0, GOAL_MAX);
  const norm = normalize(text);
  const toks = tokens(norm);
  const channel = pickChannel(norm, ctx);
  const language = parseLanguage(norm) ?? channelLanguage(channel, ctx.locale);
  const aspect = parseAspect(norm);
  const minutes = parseMinutes(norm);
  const theme = parseTheme(text);

  const steps: PlanStep[] = [];
  const hits = kindHits(norm);
  const src = text.replace(/[ʻʼ’‘`]/g, "'");
  let prevEnd = 0;
  hits.forEach((hit, i) => {
    const count = countBefore(toks, hit, prevEnd);
    prevEnd = hit.end;
    if (count === null || steps.length >= MAX_STEPS) return;
    const kind: StepKind = hit.kind === "short" ? "video" : hit.kind;
    const durationS = hit.kind === "short" ? SHORT_S : minutes ? nearestRunLength(minutes) : DEFAULT_VIDEO_S;
    // "5 Shorts about space and 3 thumbnails about black holes": each its own subject, else the goal's.
    const next = hits[i + 1];
    let segment = src.slice(hit.start, next?.start ?? src.length);
    if (next) {
      const join = JOIN_TAIL.exec(segment);
      if (join) segment = segment.slice(0, join.index);
    }
    const own = parseTheme(segment);
    steps.push(newStep(`s${steps.length + 1}`, kind, { theme: own || theme, channel, language, aspect, durationS, count }));
  });
  const guessed = steps.length === 0 && text.trim() !== "";
  if (guessed) {
    // Nothing named what to make: one video about what was written.
    const topic = theme || tidy(text);
    steps.push(newStep("s1", "video", { theme: topic, channel, language, durationS: minutes ? nearestRunLength(minutes) : DEFAULT_VIDEO_S }));
  }
  return { id, goal: text, theme, steps, seq: steps.length + 1, guessed };
}

// ── editing ─────────────────────────────────────────────────────────────────

export type StepPatch = Partial<Pick<PlanStep, "count" | "channelSlug" | "language" | "durationS" | "aspect" | "clipSeconds" | "text">>;

/** One step changed. Values outside what the step offers are ignored, never stored. */
export function updateStep(plan: Plan, stepId: string, patch: StepPatch): Plan {
  return {
    ...plan,
    steps: plan.steps.map((s) => {
      if (s.id !== stepId) return s;
      const next = { ...s };
      if (patch.count !== undefined) next.count = clampCount(patch.count);
      if (patch.channelSlug !== undefined) next.channelSlug = patch.channelSlug;
      if (patch.language !== undefined && isHomeLanguage(patch.language)) {
        // A voice's untouched starter follows its language; words the person wrote stay.
        if (s.kind === "voice" && s.text === starterText("voice", plan.theme, s.language)) next.text = starterText("voice", plan.theme, patch.language);
        next.language = patch.language;
      }
      if (patch.durationS !== undefined && RUN_LENGTHS_S.includes(patch.durationS)) next.durationS = patch.durationS;
      if (patch.aspect !== undefined && (ASPECT_RATIOS as readonly string[]).includes(patch.aspect)) next.aspect = patch.aspect;
      if (patch.clipSeconds !== undefined && (VIDEO_DURATIONS as readonly number[]).includes(patch.clipSeconds)) next.clipSeconds = patch.clipSeconds;
      if (patch.text !== undefined) next.text = patch.text.slice(0, s.kind === "video" ? TOPIC_MAX : PROMPT_MAX);
      return next;
    }),
  };
}

export function removeStep(plan: Plan, stepId: string): Plan {
  return { ...plan, steps: plan.steps.filter((s) => s.id !== stepId) };
}

/** A step added by hand. Its id is new, so its keys are new; the plan's other steps are untouched. */
export function addStep(plan: Plan, kind: StepKind, ctx: PlannerContext): Plan {
  if (plan.steps.length >= MAX_STEPS) return plan;
  const fromStep = plan.steps.find((s) => s.channelSlug);
  const channel = ctx.channels.find((c) => c.slug === fromStep?.channelSlug) ?? pickChannel("", ctx);
  const language = plan.steps[0]?.language ?? channelLanguage(channel, ctx.locale);
  const step = newStep(`s${plan.seq}`, kind, { theme: plan.theme, channel, language });
  return { ...plan, steps: [...plan.steps, step], seq: plan.seq + 1, guessed: false };
}

// ── what each step asks for ─────────────────────────────────────────────────

/** Why a step cannot be priced or started, before anything is asked of a server. */
export type StepBlocker = "no_org" | "no_model" | "need_words" | "no_channel" | "no_access" | "run_unavailable";

export interface StepEnv {
  orgId: string | null;
  models: StudioModel[];
  channels: PlannerChannel[];
  /** Owner/admin of the organization — what Run now requires. Presentation only; the route re-checks. */
  canRun: boolean;
  /** Run now is wired on this deployment. */
  runConfigured: boolean;
}

export interface CreativeRequest {
  type: "creative";
  capability: CreativeCapability;
  model: string;
  params: Record<string, string | number>;
}

export interface RunRequest {
  type: "run";
  channelId: string;
  channelSlug: string;
  duration: number;
  language: HomeLanguage;
  /** One video: its topic. */
  topic?: string;
  /** Several videos: the theme each picks its own topic within, so they are not the same video five times. */
  niche?: string;
}

export type StepRequest = CreativeRequest | RunRequest;

export function stepBlocker(step: PlanStep, env: StepEnv): StepBlocker | null {
  if (isRunKind(step.kind)) {
    if (!env.channels.some((c) => c.slug === step.channelSlug)) return "no_channel";
    if (!env.canRun) return "no_access";
    if (!env.runConfigured) return "run_unavailable";
    return null;
  }
  if (!env.orgId) return "no_org";
  const cap = stepCapability(step.kind);
  if (!cap || modelsFor(env.models, cap).length === 0) return "no_model";
  const words = step.text.trim();
  if (!words || /\[[^\]]*\]/.test(words)) return "need_words";
  return null;
}

/**
 * What a step asks the existing routes for — the same request for its price
 * and for each item it makes — or null when it is blocked. The model is the
 * first one offered for the kind, as the Studio picks it.
 */
export function stepRequest(step: PlanStep, env: StepEnv): StepRequest | null {
  if (stepBlocker(step, env)) return null;
  if (isRunKind(step.kind)) {
    const ch = env.channels.find((c) => c.slug === step.channelSlug)!;
    const theme = step.text.trim();
    return {
      type: "run",
      channelId: ch.id,
      channelSlug: ch.slug,
      duration: step.durationS,
      language: step.language,
      ...(theme ? (step.count > 1 ? { niche: theme.slice(0, NICHE_MAX) } : { topic: theme.slice(0, TOPIC_MAX) }) : {}),
    };
  }
  const capability = stepCapability(step.kind)!;
  const model = modelsFor(env.models, capability)[0].id;
  const params = buildParams({
    capability: capability as "t2i" | "t2v" | "tts",
    prompt: step.text,
    aspect: step.aspect,
    duration: step.clipSeconds,
  }) as Record<string, string | number>;
  return { type: "creative", capability, model, params };
}

/** One string per distinct price question: steps that ask the same thing share one answer. */
export function priceKey(req: StepRequest): string {
  return req.type === "run"
    ? `run:${req.channelId}:${req.duration}`
    : `creative:${req.capability}:${req.model}:${JSON.stringify(req.params)}`;
}

// ── prices and the total ───────────────────────────────────────────────────

/** One item's price, from the database. `free`: no charge (an exempt organization). */
export type StepPrice =
  | { status: "quoting" }
  | { status: "ready"; unit: number; free: boolean }
  | { status: "error"; message: string };

export type PlanTotal =
  | { status: "empty" }
  | { status: "pending" }
  | { status: "blocked"; stepIndex: number; reason: { blocker: StepBlocker } | { message: string } }
  | { status: "ready"; total: number; free: boolean };

const roundCredits = (n: number) => Math.round(n * 100) / 100;

/**
 * The one total, or why there is none. Each item costs the step's unit price
 * (every item of a step asks exactly the same thing); a step that is blocked
 * or could not be priced blocks the whole confirm — it is never counted as 0.
 */
export function planTotal(steps: PlanStep[], env: StepEnv, priceOf: (step: PlanStep) => StepPrice | undefined): PlanTotal {
  if (steps.length === 0) return { status: "empty" };
  let total = 0;
  let free = true;
  let pending = false;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const blocker = stepBlocker(s, env);
    if (blocker) return { status: "blocked", stepIndex: i, reason: { blocker } };
    const p = priceOf(s);
    if (p?.status === "error") return { status: "blocked", stepIndex: i, reason: { message: p.message } };
    if (!p || p.status === "quoting") {
      pending = true;
      continue;
    }
    total += p.unit * s.count;
    free = free && p.free;
  }
  if (pending) return { status: "pending" };
  return { status: "ready", total: roundCredits(total), free: free && total === 0 };
}

export function stepCost(step: PlanStep, price: StepPrice | undefined): number | null {
  return price?.status === "ready" ? roundCredits(price.unit * step.count) : null;
}

// ── confirm ─────────────────────────────────────────────────────────────────

/**
 * The idempotency key of one item: the plan, the step, the item. Stable for
 * the plan's life (a second press, a reload of the saved plan), so the server
 * answers the first job rather than starting a second. Matches the creative
 * route's key shape ([A-Za-z0-9_:.-], ≤255).
 */
export function itemKey(planId: string, stepId: string, index: number): string {
  return `assistant:${planId}:${stepId}:${index}`;
}

export function newPlanId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The request body of one item. `unit` is the price the person confirmed: the ceiling, never more. */
export function itemBody(req: StepRequest, key: string, unit: number, free: boolean, orgId: string | null): Record<string, unknown> {
  if (req.type === "creative")
    return { org_id: orgId, capability: req.capability, model: req.model, params: req.params, idempotency_key: key, max_credits: unit };
  return {
    channel_id: req.channelId,
    duration: req.duration,
    language: req.language,
    ...(req.topic ? { topic: req.topic } : {}),
    ...(req.niche ? { niche: req.niche } : {}),
    idempotency_key: key,
    // An exempt organization holds nothing, so there is no price to cap.
    ...(free ? {} : { max_credits: unit }),
  };
}

/** Every item of the plan, in the order it is started. */
export function planItems(plan: Plan): { step: PlanStep; index: number; key: string }[] {
  return plan.steps.flatMap((step) =>
    Array.from({ length: step.count }, (_, index) => ({ step, index, key: itemKey(plan.id, step.id, index) })),
  );
}
