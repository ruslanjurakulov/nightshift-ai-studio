/**
 * The film editor's "Write the storyboard with AI" (docs/studio/NIGHTSHIFT_AI.md, "Writing a project's storyboard"), the pure half:
 * which chapters an existing project's storyboard is planned in, how many of today's messages that takes, and how the one outline
 * call's answer is read. No network, no database: lib/server/brain/film-plan.ts makes the calls, each an ordinary 0199 turn under
 * 0211's lease, and the chapters' scenes are written by the chat's own plan step (lib/server/brain/plan.ts writeStoryboard).
 *
 * Why the chapters' lengths are the SERVER's here and not the model's: the chat's outline comes from a proposal the person already
 * saw, so its plan's cost is known before the press. A project has no outline yet. If the model chose the chapter lengths, the number
 * of plan calls (and so the messages it takes) would be known only after the first call had been paid for, and a plan could stop
 * halfway for the daily cap. With the lengths fixed up front, every window is known before any turn (planWindows on the skeleton),
 * the cap check is the chat's own (`plan_over_cap`), and the storyboard adds up to the project's target_seconds by construction
 * (G1). The model writes only the words: titles, beats, characters, places.
 *
 * That check is a read, said before the press. The press itself takes migration 0232's film lease (lib/server/brain/film-lease):
 * one plan per PROJECT, whoever presses, with the worst case reserved under the workspace's cap lock, so a plan that begins can
 * finish (Breach BR-FILM-02/03). Before 0232 is applied the read is all there is: a plan may stop halfway for the cap when other chats
 * or plans use today's messages meanwhile, and one plan at a time is per PERSON (the route checks all of the person's conversations
 * for the project): two editors pressing on the same empty project within ~5 min: one plan is superseded, its turns are spent, the
 * project is never double-written. The project's reference pictures and refs are not used by the writer yet: it reads the title,
 * the source text (whole, up to SOURCE_MAX code points), the language, the aspect and the length.
 */

import { CAP, FILM, extractJson, arr, filmLength, obj, plain, readScenario, unsafeText, type BrainSlots, type Scenario } from "@/lib/brain/logic";
import { HOME_LANGUAGES } from "@/lib/home";
import { outlineText, planNamesVendor, planWindows, type PlanLimits } from "@/lib/brain/plan";

/**
 * The marker a project's conversation carries in its BRIEF (0199 has no film column, and no migration is needed for this): how the
 * same conversation is found again, and how the chat's own reads (/api/brain, the history list) leave it out.
 */
export const FILM_PLAN_KEY = "film_plan";

/**
 * The longest source text the writer reads, in code points: sent whole or refused before any turn (`source_too_long`), never cut
 * (Lens H1: a 4,000-character cut planned a script's first pages as if they were all of it).
 */
export const SOURCE_MAX = 40_000;

/** About a minute per chapter: the chat's outlines are written the same way (three 60 s chapters for a 3-minute film). */
export const FILM_CHAPTER_SECONDS = 60;

/** What of a project the plan reads: its own settings, as the database stored them (film_json). */
export interface FilmPlanSource {
  title: string;
  sourceKind: string;
  sourceText: string;
  language: string;
  aspect: string;
  targetSeconds: number;
}

/** The chapters a project's storyboard is planned in: ids and lengths that add up to `target` exactly, each at least one scene. */
export function filmChapters(target: number): { id: string; seconds: number }[] | null {
  if (!Number.isInteger(target) || target < FILM.sceneMin) return null;
  const n = Math.min(CAP.chapters, Math.max(1, Math.round(target / FILM_CHAPTER_SECONDS)));
  if (Math.floor(target / n) < FILM.sceneMin) return null;
  // The remainder goes to the first chapters: the lengths add up to the target, never rounded away.
  return Array.from({ length: n }, (_, i) => ({ id: `ch${i + 1}`, seconds: Math.floor(target / n) + (i < target % n ? 1 : 0) }));
}

/** The project's settings as the plan's slots. A length or language the plan cannot take leaves that slot unset. */
export function filmSlots(f: FilmPlanSource): BrainSlots {
  const language = HOME_LANGUAGES.find((l) => l.id === f.language)?.value;
  const aspect = f.aspect === "16:9" || f.aspect === "9:16" || f.aspect === "1:1" ? f.aspect : undefined;
  return { kind: "short", target_seconds: filmLength(f.targetSeconds), ...(aspect ? { aspect } : {}), ...(language ? { language } : {}) };
}

/** An outline with only the server's chapters: what planWindows counts the calls of before any turn. */
function skeleton(target: number, chapters: { id: string; seconds: number }[]): Scenario {
  let at = 0;
  return {
    title: "", idea: "", story: { logline: "", conflict: "" }, characters: [], locations: [], props: [], scenes: [], target_seconds: target,
    chapters: chapters.map((c) => { const start_s = at; at += c.seconds; return { id: c.id, title: c.id, start_s, seconds: c.seconds, beats: [] }; }),
  };
}

export interface FilmPlanTurns { about: number; at_most: number; windows: number }

/**
 * How many of today's messages writing this project's storyboard takes: the outline call, then one call per window, each window
 * asked again at most once (G1). Null when the length cannot be planned (outside the film's range, or more than 60 scenes at the clip
 * model's longest scene): said before any turn, as `not_plannable`.
 */
export function filmPlanTurns(target: number, limits: PlanLimits): FilmPlanTurns | null {
  if (filmLength(target) === undefined) return null;
  const chapters = filmChapters(target);
  if (!chapters) return null;
  const w = planWindows(skeleton(target, chapters), limits);
  return w ? { about: 1 + w.length, at_most: 1 + 2 * w.length, windows: w.length } : null;
}

/** The project's own words, which a plan answer may echo (a film about OpenAI may show OpenAI); nothing else may name a vendor. */
export function filmText(f: FilmPlanSource): string {
  return [f.title, f.sourceText].join("\n");
}

/** The project's own title or source text carries what is never made here (logic.ts unsafeText): refused before any turn. */
export function unsafeFilm(f: FilmPlanSource): boolean {
  return unsafeText(f.title) || unsafeText(f.sourceText);
}

export type FilmOutlineRead = { ok: true; outline: Scenario } | { ok: false; why: "refused" | "invalid" };

/**
 * The outline call's answer, read through the chat's own scenario reader (prices, links and invisible characters out, ids checked)
 * with the server's chapter lengths put back: the model was told them, and they are the server's, not the model's. A chapter left
 * out or left untitled, a missing idea, or a vendor the project's own words do not name (or any claim that a vendor made it) is not
 * an outline: the plan fails by name, and nothing is planned from it.
 */
export function readFilmOutline(text: string, f: FilmPlanSource, chapters: { id: string; seconds: number }[], slots: BrainSlots,
                                extraClaimNames: readonly string[] = []): FilmOutlineRead {
  const json = extractJson(text);
  if (!json) return { ok: false, why: "invalid" };
  if (json.refused === true || (typeof json.refused === "string" && json.refused.trim() !== "")) return { ok: false, why: "refused" };
  const answered = arr(json.chapters).map(obj);
  const merged = [];
  for (const c of chapters) {
    const entry = answered.find((a) => typeof a.id === "string" && a.id.trim().toLowerCase() === c.id);
    if (!entry) return { ok: false, why: "invalid" };
    merged.push({ id: c.id, title: entry.title, seconds: c.seconds, beats: entry.beats });
  }
  // The project's own title is the person's: kept as it is, the model's only when the project has none. "None" as plain() reads it:
  // a title of only U+3164 or zero-width characters is empty, not a title (trim() keeps those).
  const title = plain(f.title, 100) ? f.title : json.title;
  const outline = readScenario({ ...json, title, chapters: merged }, slots, { outline: true });
  if (!outline || outline.chapters.length !== chapters.length || outline.target_seconds !== slots.target_seconds) return { ok: false, why: "invalid" };
  if (planNamesVendor(outlineText(outline), filmText(f), extraClaimNames)) return { ok: false, why: "invalid" };
  return { ok: true, outline };
}
