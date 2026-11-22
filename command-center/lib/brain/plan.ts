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
 *   - a plan with any chapter missing is never returned, so it is never priced.
 */

import {
  FILM,
  extractJson,
  namesVendor,
  readSceneParts,
  type BriefScene,
  type ClipShape,
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
}

export function planLimits(clip: ClipShape | null): PlanLimits {
  const longest = clip?.durations?.length ? Math.max(...clip.durations) : null;
  const maxShots = Math.max(1, clip?.maxShots ?? FILM.maxShots);
  // A scene longer than this is one quote_film refuses ("scene_too_long_for_model"): the plan is told so up front.
  const byModel = longest ? longest * maxShots : FILM.sceneMax;
  return { sceneMin: FILM.sceneMin, sceneMax: Math.max(FILM.sceneMin, Math.min(FILM.sceneMax, byModel)), maxScenes: FILM.maxScenes,
           clipLongest: longest, maxShots };
}

/** One chapter (or one part of a chapter too long for one call) that a call writes. */
export interface PlanPart {
  chapter_id: string;
  /** 1-based, in the outline's order: what a failure names. */
  chapter_n: number;
  title: string;
  beats: { at_s: number; text: string }[];
  seconds: number;
  part: number;
  parts: number;
}

export interface PlanWindow { n: number; parts: PlanPart[]; seconds: number; maxScenes: number }

/**
 * The calls a short outline's storyboard takes: consecutive chapters packed into windows of at most PLAN.windowScenes scenes. A
 * chapter longer than one window is written in parts whose seconds add up to the chapter's exactly. Null when the outline has no
 * lengths to plan to (it would not have been proposed).
 */
export function planWindows(outline: Scenario, limits: PlanLimits): PlanWindow[] | null {
  const target = outline.target_seconds;
  if (!outline.chapters.length || outline.chapters.some((c) => !c.seconds || c.seconds < limits.sceneMin)) return null;
  if (outline.chapters.reduce((a, c) => a + (c.seconds ?? 0), 0) !== target) return null;
  // A clip model whose shots are short can make the film impossible within 60 scenes: said, never planned and refused later.
  if (Math.ceil(target / limits.sceneMax) > limits.maxScenes) return null;
  const scene = Math.min(limits.sceneMax, Math.max(PLAN.typicalSceneS, Math.ceil(target / limits.maxScenes)));
  const cap = Math.max(limits.sceneMin, Math.floor(PLAN.windowScenes * scene * PLAN.windowFill));
  const parts: PlanPart[] = [];
  outline.chapters.forEach((c, i) => {
    const seconds = c.seconds as number;
    const k = Math.ceil(seconds / cap);
    for (let p = 0; p < k; p++) {
      // The remainder goes to the first parts: the parts add up to the chapter's seconds, never rounded away.
      const share = Math.floor(seconds / k) + (p < seconds % k ? 1 : 0);
      parts.push({ chapter_id: c.id, chapter_n: i + 1, title: c.title, beats: c.beats, seconds: share, part: p + 1, parts: k });
    }
  });
  const windows: PlanWindow[] = [];
  for (const p of parts) {
    const last = windows[windows.length - 1];
    if (last && last.seconds + p.seconds <= cap) {
      last.parts.push(p);
      last.seconds += p.seconds;
    } else {
      windows.push({ n: windows.length + 1, parts: [p], seconds: p.seconds, maxScenes: 0 });
    }
  }
  for (const w of windows) {
    // The film's 60 scenes shared by length, and never fewer than the window needs at its longest scene.
    const share = Math.floor((limits.maxScenes * w.seconds) / target);
    w.maxScenes = Math.min(PLAN.windowScenes, Math.max(Math.ceil(w.seconds / limits.sceneMax), share));
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
  | { ok: false; why: "length"; problem: string };

const arr = (v: unknown) => (Array.isArray(v) ? v : []);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** One call's answer, checked against what that call was asked for. */
export function readWindow(text: string, w: PlanWindow, refs: SceneRefs, limits: PlanLimits): WindowRead {
  const json = extractJson(text);
  if (!json) return { ok: false, why: "invalid" };
  if (json.refused === true || (typeof json.refused === "string" && json.refused.trim() !== "")) return { ok: false, why: "refused" };
  const answered = arr(json.chapters).map(obj);
  const problems: string[] = [];
  const out: SceneParts[][] = [];
  let count = 0;
  for (const p of w.parts) {
    const entry = answered.find((a) => typeof a.id === "string" && a.id.trim().toLowerCase() === p.chapter_id);
    if (!entry) return { ok: false, why: "invalid" };
    const raw = arr(entry.scenes);
    if (raw.length === 0) return { ok: false, why: "invalid" };
    // One past the window's room is enough to say "too many" below; the rest is not read.
    const scenes = raw.slice(0, PLAN.windowScenes + 1).map((s) => readSceneParts(s, "short", refs));
    if (scenes.some((s) => s === null)) return { ok: false, why: "invalid" };
    const ok = scenes as SceneParts[];
    // The assistant naming its vendor inside a plan is the same leak as in a reply (an injected chapter can ask for it): the plan
    // fails rather than a picture or a spoken line carrying it.
    if (ok.some((s) => [s.title, s.visual_prompt, ...s.dialogue.map((d) => d.line)].some((t) => t && namesVendor(t)))) return { ok: false, why: "invalid" };
    count += ok.length;
    const bad = ok.findIndex((s) => s.seconds === null || s.seconds < limits.sceneMin || s.seconds > limits.sceneMax);
    if (bad >= 0) {
      problems.push(`chapter ${p.chapter_id}: scene ${bad + 1} is ${ok[bad].seconds ?? "missing a length"}${ok[bad].seconds === null ? "" : " s"}; every scene must be ${limits.sceneMin} to ${limits.sceneMax} s`);
    }
    const sum = ok.reduce((a, s) => a + (s.seconds ?? 0), 0);
    if (sum !== p.seconds) problems.push(`chapter ${p.chapter_id}: the scenes add up to ${sum} s; they must add up to exactly ${p.seconds} s`);
    out.push(ok);
  }
  if (count > w.maxScenes) problems.push(`this answer has ${count} scenes; at most ${w.maxScenes} are allowed`);
  if (problems.length) return { ok: false, why: "length", problem: problems.join(". ") };
  return { ok: true, parts: out };
}

export type MergeResult = { ok: true; scenario: Scenario } | { ok: false; why: "too_many_scenes" | "length" };

/** The windows' answers, in story order, as one storyboard: s1..sN, at most 60, adding up to the person's length. */
export function mergePlan(outline: Scenario, windows: PlanWindow[], answers: SceneParts[][][]): MergeResult {
  if (answers.length !== windows.length || answers.some((a, i) => !a || a.length !== windows[i].parts.length)) return { ok: false, why: "length" };
  const flat = answers.flat(2);
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
