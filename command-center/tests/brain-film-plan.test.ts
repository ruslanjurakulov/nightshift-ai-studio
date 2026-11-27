import { describe, expect, it } from "vitest";
import { filmChapters, filmPlanTurns, filmSlots, readFilmOutline } from "@/lib/brain/film-plan";
import { planLimits } from "@/lib/brain/plan";

/**
 * lib/brain/film-plan.ts, the pure half of the film editor's storyboard writer. What breaks if these fail: a project's chapters that
 * do not add up to its target_seconds (the storyboard would be another length); a cost shown before the press that the plan can
 * exceed (it would stop halfway for the cap); a model that re-times a chapter or drops one having it accepted.
 */

const film = { title: "The lost caravan", sourceKind: "topic", sourceText: "A guard and a caravan.", language: "en", aspect: "9:16", targetSeconds: 180 };

describe("the server's chapters", () => {
  it.each([10, 59, 60, 61, 90, 180, 299, 600, 1199, 1200])("%i s: whole chapters, each at least one scene, adding up exactly", (target) => {
    const ch = filmChapters(target)!;
    expect(ch.reduce((a, c) => a + c.seconds, 0)).toBe(target);
    expect(ch.every((c) => c.seconds >= 3)).toBe(true);
    expect(ch.length).toBeLessThanOrEqual(20);
  });

  it("the cost is known before any turn: one outline call plus each window, asked again at most once", () => {
    const t = filmPlanTurns(180, planLimits({ durations: [6, 10], maxShots: 3 }))!;
    expect(t).toEqual({ about: 1 + t.windows, at_most: 1 + 2 * t.windows, windows: t.windows });
    // More than 60 scenes at the clip model's longest scene, or outside the film's range: not plannable, before any turn.
    expect(filmPlanTurns(1200, planLimits({ durations: [5], maxShots: 3 }))).toBeNull();
    expect(filmPlanTurns(5000, planLimits(null))).toBeNull();
  });

  it("the project's settings become the plan's slots; a language the plan does not take leaves it unset", () => {
    expect(filmSlots(film)).toEqual({ kind: "short", target_seconds: 180, aspect: "9:16", language: "English" });
    expect(filmSlots({ ...film, language: "de" }).language).toBeUndefined();
  });
});

describe("the outline answer", () => {
  const chapters = filmChapters(180)!;
  const slots = filmSlots(film);
  const answer = (o: Record<string, unknown> = {}) => JSON.stringify({
    idea: "A guard saves a caravan.", story: { logline: "l", conflict: "c" },
    chapters: chapters.map((c) => ({ id: c.id, title: `T ${c.id}`, seconds: 999, beats: [{ at_s: 0, text: "b" }] })),
    characters: [{ id: "c1", name: "Aziz", description: "guard", image_prompt: "guard" }], locations: [], props: [], ...o,
  });

  it("keeps the server's lengths whatever the model wrote, and the project's own title", () => {
    const r = readFilmOutline(answer({ title: "Another title" }), film, chapters, slots);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outline.title).toBe("The lost caravan");
    expect(r.outline.chapters.map((c) => c.seconds)).toEqual(chapters.map((c) => c.seconds));
    expect(r.outline.target_seconds).toBe(180);
  });

  it("a chapter left out, an untitled one, a refusal or a vendor's name is not an outline", () => {
    expect(readFilmOutline(answer({ chapters: [] }), film, chapters, slots)).toEqual({ ok: false, why: "invalid" });
    expect(readFilmOutline(answer({ chapters: chapters.map((c) => ({ id: c.id, title: "" })) }), film, chapters, slots).ok).toBe(false);
    expect(readFilmOutline(JSON.stringify({ refused: "no" }), film, chapters, slots)).toEqual({ ok: false, why: "refused" });
    expect(readFilmOutline(answer({ idea: "Gemini shows the way." }), film, chapters, slots).ok).toBe(false);
    // A name the project's own words carry may be shown; a claim that a vendor made it never.
    const about = { ...film, sourceText: "The rise of OpenAI." };
    expect(readFilmOutline(answer({ idea: "How OpenAI grew." }), about, chapters, slots).ok).toBe(true);
    expect(readFilmOutline(answer({ idea: "Made by OpenAI." }), about, chapters, slots).ok).toBe(false);
  });
});
