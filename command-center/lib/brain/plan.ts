/**
 * Nightshift Brain's plan step (S1_GAPS G1, G2, G4), the pure half: which bounded calls write a chosen outline's storyboard, what
 * each is told, how its answer is checked, and how the answers become one BRIEF. No network, no database: lib/server/brain/plan.ts
 * makes the calls and meters each one as a turn (0199).
 *
 * Why it is its own step: one answer cannot hold 2–3 whole storyboards past a minute or two (8,000 output tokens; a 1200 s film is
 * at least 40 scenes), and a model squeezed for room writes a few short scenes, which used to become a shorter film in silence.
 *
 * What the code, not the prompt, guarantees:
 *   - every chapter's scenes add up to that chapter's seconds exactly, so the storyboard adds up to the length the person chose;
 *     a chapter that does not is asked again once, with the reason, and then fails the plan by name. Nothing is stretched,
 *     shrunk, dropped or padded to make it fit;
 *   - every scene is within the film's 3–30 s, and within what the clip model can make in max_shots shots when that is known;
 *   - scenes are s1..sN in story order, at most 60, and point only at characters, locations and props the outline defines;
 *   - an outline that could not fit 60 scenes is refused before any turn (planWindows null);
 *   - a plan answer carries no vendor's name the outline does not, and never a claim that a vendor made it;
 *   - a plan with any chapter missing is never returned, so it is never priced.
 *
 * One plan at a time per conversation is the database's (0211's lease, lib/server/brain/plan.ts), not this file's.
 */

import {
  FILM,
  arr,
  extractJson,
  foldForCheck,
  namesVendor,
  obj,
  readSceneParts,
  type BriefScene,
  type ClipShape,
  type OutlineChapter,
  type SceneParts,
  type SceneRefs,
  type Scenario,
} from "@/lib/brain/logic";

/**
 * A window is at most 15 scenes (one answer's comfortable room in ru and uz). Its seconds are sized for scenes of a typical clip's
 * length (8 s), or longer where the film's 60 scenes force it (a 1200 s film averages 20 s), filled to 80%: a window sized for the
 * longest scene would force every scene to be the longest, and one sized for the shortest would spend a turn per 45 s. Three
 * calls at a time: one plan, one person, and the vendor's per-key rate limits.
 */
export const PLAN = { windowScenes: 15, windowFill: 0.8, typicalSceneS: 8, concurrency: 3 } as const;

export interface PlanLimits {
  sceneMin: number;
  /** The longest scene this plan may write: the film's 30 s, or less when the clip model's longest shot × max_shots is shorter. */
  sceneMax: number;
  maxScenes: number;
  /** The clip model's longest shot in seconds, or null when it is not known (nothing is split on a guess). */
  clipLongest: number | null;
  maxShots: number;
  /** The longest whole scene prompt (scenePrompt), in UTF-16 units: the film's own 2000, or less when the chosen models' registry
   *  rows (limits.max_prompt_chars) take less. 0218 refuses anything over it before the quote. */
  promptMax: number;
}

/** `promptMax`: the chosen models' own prompt limit (lib/server/brain/clip promptLimitOf), or null when none is known; then the
 *  film's 2000 (film_limits.max_prompt_chars) is the only one, and nothing more is said. */
export function planLimits(clip: ClipShape | null, promptMax: number | null = null): PlanLimits {
  const longest = clip?.durations?.length ? Math.max(...clip.durations) : null;
  const maxShots = Math.max(1, clip?.maxShots ?? FILM.maxShots);
  // A scene longer than this is one quote_film refuses ("scene_too_long_for_model"): the plan is told so up front.
  const byModel = longest ? longest * maxShots : FILM.sceneMax;
  return { sceneMin: FILM.sceneMin, sceneMax: Math.max(FILM.sceneMin, Math.min(FILM.sceneMax, byModel)), maxScenes: FILM.maxScenes,
           clipLongest: longest, maxShots,
           promptMax: typeof promptMax === "number" && Number.isInteger(promptMax) && promptMax > 0 ? Math.min(FILM.promptMax, promptMax) : FILM.promptMax };
}

/** One chapter (or one part of a chapter too long for one call) that a call writes. */
export interface PlanPart {
  chapter_id: string;
  /** 1-based, in the outline's order: what a failure names. */
  chapter_n: number;
  title: string;
  /** Only this part's own beats (Lens L3): a part told the whole chapter's beats writes the whole chapter again. */
  beats: { at_s: number; text: string }[];
  seconds: number;
  part: number;
  parts: number;
  /** For a part after the first: the beat the part before it ends on, so the story continues from there. */
  previous: string | null;
}

export interface PlanWindow { n: number; parts: PlanPart[]; seconds: number; maxScenes: number }

/** The fewest scenes a part can be written in: each at most the longest scene. */
const fewest = (seconds: number, limits: PlanLimits) => Math.ceil(seconds / limits.sceneMax);

/**
 * A chapter's beats split between its parts by where they fall. A beat's at_s is read inside the chapter (0 .. seconds); one the
 * model wrote on the film's clock (start_s .. start_s + seconds) is moved onto the chapter's own.
 */
function beatsOf(c: OutlineChapter, from: number, to: number, last: boolean) {
  const start = c.start_s ?? 0;
  const seconds = c.seconds ?? 0;
  return c.beats.filter((b) => {
    const at = b.at_s >= start && b.at_s < start + seconds && start > 0 ? b.at_s - start : b.at_s;
    return at >= from && (at < to || last);
  });
}

/**
 * The calls a short outline's storyboard takes. A chapter longer than one call's room is written in parts whose seconds add up to the
 * chapter's exactly; consecutive parts are packed into one call while the fewest scenes they can be written in stays within
 * PLAN.windowScenes (Lens M2: packing by seconds alone gave two short chapters one scene between them).
 *
 * Each call's scene allowance is its share of the film's 60, never fewer than its parts need, at most 15, and all the calls'
 * allowances together never more than 60: an answer within its allowance can always be merged. Null when the outline cannot be
 * planned (no lengths, lengths that do not add up, or more than 60 scenes at the longest scene): said before any turn is taken.
 */
export function planWindows(outline: Scenario, limits: PlanLimits): PlanWindow[] | null {
  const target = outline.target_seconds;
  if (!outline.chapters.length || outline.chapters.some((c) => !c.seconds || c.seconds < limits.sceneMin)) return null;
  if (outline.chapters.reduce((a, c) => a + (c.seconds ?? 0), 0) !== target) return null;
  const scene = Math.min(limits.sceneMax, Math.max(PLAN.typicalSceneS, Math.ceil(target / limits.maxScenes)));
  // A part is at most what fills a call at the typical scene, and never more than 15 of the longest scenes can make.
  const cap = Math.max(limits.sceneMin, Math.min(PLAN.windowScenes * limits.sceneMax, Math.floor(PLAN.windowScenes * scene * PLAN.windowFill)));
  const parts: PlanPart[] = [];
  outline.chapters.forEach((c, i) => {
    const seconds = c.seconds as number;
    const k = Math.ceil(seconds / cap);
    let from = 0;
    let previous: string | null = null;
    for (let p = 0; p < k; p++) {
      // The remainder goes to the first parts: the parts add up to the chapter's seconds, never rounded away.
      const share = Math.floor(seconds / k) + (p < seconds % k ? 1 : 0);
      const beats = k > 1 ? beatsOf(c, from, from + share, p === k - 1) : c.beats;
      parts.push({ chapter_id: c.id, chapter_n: i + 1, title: c.title, beats, seconds: share, part: p + 1, parts: k, previous: p > 0 ? previous : null });
      if (beats.length) previous = beats[beats.length - 1].text;
      from += share;
    }
  });
  // More than 60 scenes even at the longest scene: no answer could be merged, so nothing is begun.
  if (parts.reduce((a, p) => a + fewest(p.seconds, limits), 0) > limits.maxScenes) return null;
  const windows: PlanWindow[] = [];
  let need = 0;
  for (const p of parts) {
    const last = windows[windows.length - 1];
    const n = fewest(p.seconds, limits);
    if (last && need + n <= PLAN.windowScenes) {
      last.parts.push(p);
      last.seconds += p.seconds;
      need += n;
    } else {
      windows.push({ n: windows.length + 1, parts: [p], seconds: p.seconds, maxScenes: 0 });
      need = n;
    }
  }
  const floor = windows.map((w) => w.parts.reduce((a, p) => a + fewest(p.seconds, limits), 0));
  windows.forEach((w, i) => {
    const share = Math.floor((limits.maxScenes * w.seconds) / target);
    w.maxScenes = Math.min(PLAN.windowScenes, Math.max(floor[i], share));
  });
  // Rounding and the floors can push the sum past 60: the roomiest calls give back first, never below what they need.
  let over = windows.reduce((a, w) => a + w.maxScenes, 0) - limits.maxScenes;
  while (over > 0) {
    const i = windows.reduce((best, w, k) => (w.maxScenes - floor[k] > windows[best].maxScenes - floor[best] ? k : best), 0);
    if (windows[i].maxScenes <= floor[i]) return null;
    windows[i].maxScenes -= 1;
    over -= 1;
  }
  return windows;
}

export function refsOf(outline: Scenario): SceneRefs {
  return { c: new Set(outline.characters.map((c) => c.id)), l: new Set(outline.locations.map((l) => l.id)), p: new Set(outline.props.map((p) => p.id)) };
}

export type WindowRead =
  | { ok: true; parts: SceneParts[][] }
  /** The plan's own safety rule (the prompt's "refused"). */
  | { ok: false; why: "refused" }
  /** Not the JSON asked for, a chapter missing, a scene without a picture, or a vendor named: the plan fails, not asked again. */
  | { ok: false; why: "invalid" }
  /** The lengths are wrong. `problem` is the server's own words (numbers and ids only), for the one re-ask. */
  | { ok: false; why: "length"; problem: string }
  /** Only a scene's whole prompt is over limits.promptMax (`chapter` 1-based, `scene` 1-based within it), for the one re-ask. */
  | { ok: false; why: "prompt"; problem: string; chapter: number; scene: number };

/**
 * The AI vendors and models by name, as one canonical word each (any script, look-alike letters folded first). Wider than the reply's
 * namesVendor on purpose: a plan's model may be Gemini (Breach BR-S1-05), and in a scene "Gemini" or "Bard" needs no "I am" in front
 * to be the vendor's name on screen.
 */
const VENDOR_NAMES: [RegExp, string][] = [
  [/(?<![\p{L}\p{N}])(?:claude|клод)(?![\p{L}])/giu, "claude"],
  [/anthropic|антропик/giu, "anthropic"],
  [/chat\s?-?\s?gpt|чат\s?-?\s?гпт/giu, "chatgpt"],
  [/(?<![\p{L}\p{N}])(?:gpt|гпт)(?:[-\s]?\d[\w.]*)?(?![\p{L}])/giu, "gpt"],
  [/open\s?-?\s?ai|опен\s?(?:аи|эй\s?ай)/giu, "openai"],
  [/deep\s?mind/giu, "deepmind"],
  [/deep\s?seek/giu, "deepseek"],
  [/(?<![\p{L}\p{N}])(?:gemini|джемини|гемини)(?![\p{L}])/giu, "gemini"],
  [/(?<![\p{L}\p{N}])(?:bard)(?![\p{L}])/giu, "bard"],
  [/google\s+(?:ai|deepmind)|гугл\s+аи/giu, "google ai"],
];
// "Google Gemini", "Anthropic's Claude", "OpenAI ChatGPT": a maker's name in front of the model's is still the model.
const VENDOR_ALT = `(?:(?:google|anthropic(?:'s)?|openai(?:'s)?|гугл)\\s+)?(?:${VENDOR_NAMES.map(([r]) => r.source).join("|")})`;
/**
 * An authorship claim: the film, a scene or a card saying a vendor made it. Always a failure, whatever the outline says (an outline
 * about OpenAI may show OpenAI; it may not have "written by OpenAI" on screen). en, ru, uz.
 */
const AUTHORSHIP = new RegExp(
  String.raw`(?:written|made|generated|created|storyboarded|directed|produced|powered|scripted)\s+(?:entirely\s+)?(?:by|with|using|on)\s+(?:the\s+)?(?:${VENDOR_ALT})`
  + String.raw`|(?:${VENDOR_ALT})(?:'s)?\s+(?:wrote|made|created|generated|storyboarded|directed|produced|scripted)`
  + String.raw`|(?:написан\p{L}*|создан\p{L}*|сделан\p{L}*|сгенерирован\p{L}*|снят\p{L}*)\s+(?:с\s+помощью\s+|при\s+помощи\s+|нейросетью\s+)?(?:${VENDOR_ALT})`
  + String.raw`|(?:${VENDOR_ALT})\s+(?:написал\p{L}*|создал\p{L}*|сделал\p{L}*|сгенерировал\p{L}*)`
  + String.raw`|(?:${VENDOR_ALT})\s+(?:tomonidan|yordamida)\s+(?:yozilgan|yaratilgan|tayyorlangan|ishlangan)`,
  "iu",
);

/** The canonical vendor names a text carries, by the table above, on the text as it is and on its folded copy. */
export function vendorNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of [text, foldForCheck(text)]) {
    for (const [r, name] of VENDOR_NAMES) {
      r.lastIndex = 0;
      if (r.test(t)) out.add(name);
      r.lastIndex = 0;
    }
  }
  return out;
}

/**
 * Whether a plan answer's text names a vendor it may not (Breach BR-S1-05). Only for plan answers; replies and cards keep namesVendor:
 *   - an authorship claim always fails;
 *   - a vendor name the chosen outline does not already carry fails (an injected chapter asked for it);
 *   - a name the outline carries passes: a film about "The rise of OpenAI" may show OpenAI.
 */
export function planNamesVendor(text: string, outlineText: string): boolean {
  if (!text) return false;
  if (AUTHORSHIP.test(text) || AUTHORSHIP.test(foldForCheck(text))) return true;
  const allowed = vendorNames(outlineText);
  for (const name of vendorNames(text)) if (!allowed.has(name)) return true;
  // A spelling the table does not know ("Anth-ropic", "Cl aude") that namesVendor still sees: only when the outline names none.
  return namesVendor(text) && allowed.size === 0 && !namesVendor(outlineText);
}

/** Everything of the chosen outline a plan answer may echo: its words are the person's and the proposal's, not the plan's. */
export function outlineText(o: Scenario): string {
  return [o.title, o.idea, o.story.logline, o.story.conflict,
          ...o.chapters.flatMap((c) => [c.title, ...c.beats.map((b) => b.text)]),
          ...o.characters.flatMap((c) => [c.name, c.description, c.image_prompt]),
          ...o.locations.flatMap((l) => [l.name, l.description, l.image_prompt]),
          ...o.props.flatMap((p) => [p.name, p.description])].join("\n");
}

/** One call's answer, checked against what that call was asked for. `outline` is the chosen outline's own text (outlineText).
 *  `promptOf` assembles a scene's whole prompt (logic scenePrompt, with the outline's characters, locations and style): a scene
 *  over limits.promptMax is a problem for the one re-ask, never cut. */
export function readWindow(text: string, w: PlanWindow, refs: SceneRefs, limits: PlanLimits, outline = "",
                           promptOf?: (s: SceneParts) => string): WindowRead {
  const json = extractJson(text);
  if (!json) return { ok: false, why: "invalid" };
  if (json.refused === true || (typeof json.refused === "string" && json.refused.trim() !== "")) return { ok: false, why: "refused" };
  const answered = arr(json.chapters).map(obj);
  const problems: string[] = [];
  const prompts: { chapter: number; at: number; text: string }[] = [];
  const out: SceneParts[][] = [];
  let count = 0;
  for (const p of w.parts) {
    const entry = answered.find((a) => typeof a.id === "string" && a.id.trim().toLowerCase() === p.chapter_id);
    if (!entry) return { ok: false, why: "invalid" };
    const raw = arr(entry.scenes);
    if (raw.length === 0) return { ok: false, why: "invalid" };
    // The model's own visual_prompt, measured before the reader caps it: a long one is sent back with the limit, never cut.
    const longRaw = raw.findIndex((r) => { const v = obj(r).visual_prompt; return typeof v === "string" && v.length > limits.promptMax; });
    if (longRaw >= 0) {
      prompts.push({ chapter: p.chapter_n, at: longRaw + 1,
                     text: `chapter ${p.chapter_id}: scene ${longRaw + 1}'s visual_prompt alone is over ${limits.promptMax} characters` });
    }
    // One past the window's room is enough to say "too many" below; the rest is not read.
    const scenes = raw.slice(0, PLAN.windowScenes + 1).map((s) => readSceneParts(s, "short", refs));
    if (scenes.some((s) => s === null)) return { ok: false, why: "invalid" };
    const ok = scenes as SceneParts[];
    // A vendor's name the outline does not carry, or any claim that a vendor made it: the plan fails rather than a picture or a
    // spoken line carrying it (an injected chapter can ask for either).
    if (ok.some((s) => [s.title, s.visual_prompt, ...s.dialogue.map((d) => d.line)].some((t) => planNamesVendor(t, outline)))) return { ok: false, why: "invalid" };
    count += ok.length;
    if (promptOf && longRaw < 0) {
      const over = ok.findIndex((s) => promptOf(s).length > limits.promptMax);
      if (over >= 0) {
        const n = promptOf(ok[over]).length;
        prompts.push({ chapter: p.chapter_n, at: over + 1,
                       text: `chapter ${p.chapter_id}: scene ${over + 1}'s whole prompt (its visual_prompt with its characters, setting, lines and style) is ${n} characters; it must be at most ${limits.promptMax}` });
      }
    }
    const bad = ok.findIndex((s) => s.seconds === null || s.seconds < limits.sceneMin || s.seconds > limits.sceneMax);
    if (bad >= 0) {
      problems.push(`chapter ${p.chapter_id}: scene ${bad + 1} is ${ok[bad].seconds ?? "missing a length"}${ok[bad].seconds === null ? "" : " s"}; every scene must be ${limits.sceneMin} to ${limits.sceneMax} s`);
    }
    const sum = ok.reduce((a, s) => a + (s.seconds ?? 0), 0);
    if (sum !== p.seconds) problems.push(`chapter ${p.chapter_id}: the scenes add up to ${sum} s; they must add up to exactly ${p.seconds} s`);
    out.push(ok);
  }
  if (count > w.maxScenes) problems.push(`this answer has ${count} scenes; at most ${w.maxScenes} are allowed`);
  if (problems.length) return { ok: false, why: "length", problem: [...problems, ...prompts.map((x) => x.text)].join(". ") };
  // Only a prompt over the limit: its own kind, so a second such answer is refused as prompt_too_long, not as a length mismatch.
  if (prompts.length) return { ok: false, why: "prompt", problem: prompts.map((x) => x.text).join(". "), chapter: prompts[0].chapter, scene: prompts[0].at };
  return { ok: true, parts: out };
}

export type MergeResult = { ok: true; scenario: Scenario } | { ok: false; why: "too_many_scenes" | "length" };

/** The windows' answers, in story order, as one storyboard: s1..sN, at most 60, adding up to the person's length. */
export function mergePlan(outline: Scenario, windows: PlanWindow[], answers: (SceneParts[][] | undefined)[]): MergeResult {
  // Every window answered, counted by index: `.some` skips the holes of a sparse array, so a window missing from it went unseen.
  if (answers.length !== windows.length) return { ok: false, why: "length" };
  for (let i = 0; i < windows.length; i++) {
    const a = answers[i];
    if (!a || a.length !== windows[i].parts.length) return { ok: false, why: "length" };
  }
  const flat = (answers as SceneParts[][][]).flat(2);
  if (flat.length > FILM.maxScenes) return { ok: false, why: "too_many_scenes" };
  const scenes = flat.map(({ seconds, ...s }, i): BriefScene => ({ ...s, id: `s${i + 1}`, n: i + 1, duration_s: seconds ?? 0 }));
  // Already true of every window; checked once more on the whole, because this is the number the person is quoted for.
  if (scenes.reduce((a, s) => a + s.duration_s, 0) !== outline.target_seconds) return { ok: false, why: "length" };
  return { ok: true, scenario: { ...outline, scenes } };
}

/** Request ids for one press: one per call, so a repeat of the press is a duplicate at the database, never a second turn (0199). */
export function planRequestId(base: string, w: number, reask = false): string {
  return `${base.slice(0, 56)}-w${w}${reask ? "r" : ""}`;
}

/**
 * How many of today's messages writing an outline's storyboard takes: one turn per window, and at most one re-ask each (G1). Said
 * "about" because the re-asks happen only when a chapter does not add up. Null for an outline with nothing to plan (a long video, or
 * a stored storyboard that already adds up). `choose` refuses a plan whose `at_most` today's turns cannot cover before the first
 * call, so a plan never stops halfway for the cap.
 */
export interface PlanTurns { about: number; at_most: number }

export function planTurns(outline: Scenario, limits: PlanLimits): PlanTurns | null {
  if (outline.scenes.length) return null;
  const w = planWindows(outline, limits);
  return w ? { about: w.length, at_most: w.length * 2 } : null;
}

/**
 * The same figure on proposed outlines, before anything is chosen. It is counted with the film's own 30 s scene limit, which is what
 * both clip models the server picks from allow (lib/brain/film-models: 15 s and 10 s shots × 3); `choose` counts again with the
 * model it actually picked and refuses up front if that is more than today's turns.
 */
export function withPlanTurns(scenarios: Scenario[], kind: "long" | "short" | undefined): Scenario[] {
  if (kind !== "short") return scenarios;
  return scenarios.map((s) => {
    const t = planTurns(s, planLimits(null));
    return t ? { ...s, plan_turns: t } : s;
  });
}
