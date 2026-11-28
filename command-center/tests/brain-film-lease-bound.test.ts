import { describe, expect, it } from "vitest";
import { CAP, FILM, type Scenario } from "@/lib/brain/logic";
import { planLimits, planTurns } from "@/lib/brain/plan";
import { FILM_LEASE_MAX_TURNS, filmLeaseMaxTurns, filmPlanTurns } from "@/lib/brain/film-plan";

/**
 * Migration 0232 bounds a film lease's reservation by the FILM (ai_chat_film_plan_max_turns(target_seconds), refused above it, never
 * cut down). If either planner ever needs more than that bound, the database refuses a real plan as invalid_params: the button is
 * dead for that length. These keep the TypeScript mirror equal to the SQL's pinned values and both planners under it, for every
 * length the film takes and every clip shape a model can have (the bound is tight at 90 s, so drift is caught here first).
 */

/** Clip shapes the catalogue can hand a plan: a model's listed shot lengths and the film's shots per scene; null = no clip model. */
const DURATIONS = [[4], [5], [6], [8], [10], [12], [15], [16], [20], [5, 10], [6, 10], [4, 6, 8], [5, 8, 10], [3, 5]];
const SHAPES = [null, ...DURATIONS.flatMap((durations) => [1, 2, 3].map((maxShots) => ({ durations, maxShots })))];

/** A small seeded generator, so a failure names the case it found and runs the same next time. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function outline(target: number, lengths: number[]): Scenario {
  let at = 0;
  return {
    title: "t", idea: "i", story: { logline: "l", conflict: "c" }, characters: [], locations: [], props: [], scenes: [], target_seconds: target,
    chapters: lengths.map((s, i) => { const start_s = at; at += s; return { id: `ch${i + 1}`, title: `c${i + 1}`, start_s, seconds: s, beats: [] }; }),
  } as Scenario;
}

/** A random split of `target` into 1..20 chapters of at least FILM.sceneMin seconds each (what readScenario takes as an outline). */
function chapters(target: number, next: () => number): number[] {
  const most = Math.max(1, Math.min(CAP.chapters, Math.floor(target / FILM.sceneMin)));
  const n = 1 + Math.floor(next() * most);
  const lengths = Array.from({ length: n }, () => FILM.sceneMin);
  for (let rest = target - n * FILM.sceneMin; rest > 0; rest--) lengths[Math.floor(next() * n)] += 1;
  return lengths;
}

describe("0232's per-film bound on a plan's reservation", () => {
  it("the TypeScript mirror is the SQL's least(15, 1 + 2 x ceil(t / 24)), pinned at the lengths the lab pins", () => {
    expect(FILM_LEASE_MAX_TURNS).toBe(15);
    expect([60, 61, 90, 180, 600, 1200].map(filmLeaseMaxTurns)).toEqual([7, 7, 9, 15, 15, 15]);
    for (let t = FILM.targetMin; t <= FILM.targetMax; t++) expect(filmLeaseMaxTurns(t)).toBe(Math.min(15, 1 + 2 * Math.ceil(t / 24)));
  });

  it("the film route's worst case never passes the bound, for every length and clip shape", () => {
    let worst = 0;
    for (let t = FILM.targetMin; t <= FILM.targetMax; t++) {
      for (const shape of SHAPES) {
        const turns = filmPlanTurns(t, planLimits(shape));
        if (!turns) continue;
        worst = Math.max(worst, turns.at_most);
        if (turns.at_most > filmLeaseMaxTurns(t)) throw new Error(`film route: ${t} s, ${JSON.stringify(shape)} needs ${turns.at_most} > ${filmLeaseMaxTurns(t)}`);
      }
    }
    // Sentinel measured the film route's worst at exactly the cap: the bound is not loose, so a planner change shows here.
    expect(worst).toBe(FILM_LEASE_MAX_TURNS);
  });

  it("the chat's choose never passes it either: even chapters, one chapter, and seeded random chapters, every clip shape", () => {
    const next = rng(232);
    for (let t = FILM.targetMin; t <= FILM.targetMax; t++) {
      const even = (n: number) => Array.from({ length: n }, (_, i) => Math.floor(t / n) + (i < t % n ? 1 : 0));
      const splits = [[t], even(Math.min(3, Math.max(1, Math.floor(t / FILM.sceneMin)))), chapters(t, next), chapters(t, next)];
      for (const lengths of splits) {
        if (lengths.some((s) => s < FILM.sceneMin)) continue;
        for (const shape of SHAPES) {
          const turns = planTurns(outline(t, lengths), planLimits(shape));
          if (!turns) continue;
          if (turns.at_most > filmLeaseMaxTurns(t)) {
            throw new Error(`choose: ${t} s, chapters ${JSON.stringify(lengths)}, ${JSON.stringify(shape)} needs ${turns.at_most} > ${filmLeaseMaxTurns(t)}`);
          }
        }
      }
    }
  });
});
