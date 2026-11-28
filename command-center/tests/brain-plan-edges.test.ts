import { describe, expect, it } from "vitest";
import { FILM, buildBrief, filmFromBrief, readScenario, shotCount, type BrainSlots, type Scenario } from "@/lib/brain/logic";
import { PLAN, mergePlan, planLimits, planRequestId, planWindows, readWindow, refsOf, type PlanLimits, type PlanWindow } from "@/lib/brain/plan";

/**
 * The plan step's pure half at its edges (Probe on S1). What breaks if these fail: a 20-minute film is quoted for fewer scenes than a
 * film of that length can have; one malformed window is stretched into a shorter film; an old stored storyboard that does not add up
 * is priced; a long video is sent through the short plan; a scene is split into shots on a guessed clip length; an outline the code
 * itself accepted can never be planned, and every attempt spends the person's turns.
 */

const SHORT = (target: number): BrainSlots => ({ kind: "short", target_seconds: target, aspect: "9:16", style: "noir", language: "English", audience: "teens" });
const LONG = (target: number): BrainSlots => ({ kind: "long", target_seconds: target, aspect: "16:9", style: "documentary", language: "English", audience: "adults" });
const outlineRaw = (seconds: number[], o: Record<string, unknown> = {}) => ({
  title: "The lost caravan", idea: "A guard must save a caravan.", story: { logline: "l", conflict: "c" },
  characters: [{ id: "c1", name: "Aziz", description: "a guard", image_prompt: "young guard" }],
  locations: [{ id: "l1", name: "Dune", description: "red dunes", image_prompt: "dunes" }],
  props: [],
  chapters: seconds.map((s, i) => ({ id: `ch${i + 1}`, title: `Chapter ${i + 1}`, seconds: s, beats: [{ at_s: 0, text: "something happens" }] })),
  ...o,
});
const outline = (seconds: number[], target: number) => readScenario(outlineRaw(seconds), SHORT(target), { outline: true }) as Scenario;
const scene = (seconds: number, o: Record<string, unknown> = {}) => ({ title: "s", duration_s: seconds, visual_prompt: "riders on dunes", character_ids: ["c1"], location_id: "l1", ...o });

/** What an obedient model writes for one window: each part in as few scenes as the longest scene allows, adding up exactly. */
function obey(w: PlanWindow, limits: PlanLimits, dialogue = false): string {
  return JSON.stringify({ chapters: w.parts.map((p) => {
    const k = Math.ceil(p.seconds / limits.sceneMax);
    const lens = Array.from({ length: k }, (_, i) => Math.floor(p.seconds / k) + (i < p.seconds % k ? 1 : 0));
    return { id: p.chapter_id, scenes: lens.map((d, i) => scene(d, { title: `${p.chapter_id}.${p.part}.${i}`, dialogue: dialogue && i === 0 ? [{ character_id: "c1", line: "Hold!" }] : [] })) };
  }) });
}

describe("a 1200 s film: 40+ scenes over several windows", () => {
  it("ten 120 s chapters plan in several windows and merge into 40–60 scenes adding up to 1200 s exactly", () => {
    const o = outline(Array(10).fill(120), 1200);
    const limits = planLimits(null);
    const w = planWindows(o, limits)!;
    expect(w.length).toBeGreaterThan(1);
    expect(w.every((x) => x.maxScenes <= PLAN.windowScenes)).toBe(true);
    const answers = w.map((x) => {
      const r = readWindow(obey(x, limits), x, refsOf(o), limits);
      expect(r).toMatchObject({ ok: true });
      return r.ok ? r.parts : [];
    });
    const m = mergePlan(o, w, answers);
    expect(m.ok).toBe(true);
    const scenes = m.ok ? m.scenario.scenes : [];
    // 1200 s at the film's 30 s longest scene can never be fewer than 40 scenes, and is never more than 60.
    expect(scenes.length).toBeGreaterThanOrEqual(1200 / FILM.sceneMax);
    expect(scenes.length).toBeLessThanOrEqual(FILM.maxScenes);
    expect(scenes.reduce((a, s) => a + s.duration_s, 0)).toBe(1200);
    expect(scenes.map((s) => s.id)).toEqual(scenes.map((_, i) => `s${i + 1}`));
  });

  it("one 1200 s chapter is split into parts across windows, never rounded away", () => {
    const o = outline([1200], 1200);
    const w = planWindows(o, planLimits(null))!;
    expect(w.length).toBeGreaterThan(1);
    const parts = w.flatMap((x) => x.parts);
    expect(parts.every((p) => p.chapter_id === "ch1" && p.parts === parts.length)).toBe(true);
    expect(parts.reduce((a, p) => a + p.seconds, 0)).toBe(1200);
  });

  it("a 1200 s film on a clip model too short for 60 scenes is refused before any call (5 s × 3 shots = 15 s a scene)", () => {
    expect(planWindows(outline([600, 600], 1200), planLimits({ durations: [5], maxShots: 3 }))).toBeNull();
    // 7 s × 3 = 21 s a scene: 58 scenes, so it can be planned.
    expect(planWindows(outline([600, 600], 1200), planLimits({ durations: [7], maxShots: 3 }))).not.toBeNull();
  });

  it("every window it plans can be answered: one scene per chapter part fits the window's scene allowance", () => {
    // Found by a randomized sweep of 1200 s outlines: a window holding two short chapters is allowed fewer scenes than it has
    // chapters (its share of the 60 is floor(60 × 22 / 1200) = 1), so even a perfect answer is "too many scenes", is asked again,
    // and fails as plan_length_mismatch after spending every window's turn. The outline itself is one the code proposes.
    for (const seconds of [[3, 19, 1178], [10, 10, 1180], [33, 10, 199, 224, 240, 15, 131, 106, 42]]) {
      const target = seconds.reduce((a, b) => a + b, 0);
      const o = outline(seconds, target);
      expect(o).not.toBeNull();
      const limits = planLimits(null);
      const w = planWindows(o, limits)!;
      for (const x of w) {
        const needed = x.parts.reduce((a, p) => a + Math.ceil(p.seconds / limits.sceneMax), 0);
        expect(x.maxScenes, `outline ${seconds.join("+")}: window ${x.n} (${x.parts.map((p) => p.seconds).join("+")} s) needs ${needed} scenes`).toBeGreaterThanOrEqual(needed);
      }
    }
  });

  it("one request id per window of a 60-window press, all distinct and within 0199's 8–64 characters", () => {
    const base = `p${"x".repeat(80)}`;
    const ids = Array.from({ length: 60 }, (_, i) => [planRequestId(base, i + 1), planRequestId(base, i + 1, true)]).flat();
    expect(new Set(ids).size).toBe(120);
    expect(ids.every((id) => /^[A-Za-z0-9_-]{8,64}$/.test(id))).toBe(true);
  });
});

describe("a window's answer that is not the JSON asked for", () => {
  const o = outline([30, 30], 60);
  const limits = planLimits(null);
  const w = planWindows(o, limits)![0];
  for (const [name, text] of [
    ["truncated JSON", '{"chapters":[{"id":"ch1","scenes":[{"title":"a","duration_s":30,'],
    ["prose", "Sure! Here is your storyboard: chapter one opens on the dunes."],
    ["chapters not a list", JSON.stringify({ chapters: { ch1: [scene(30)] } })],
    ["a chapter with no scenes", JSON.stringify({ chapters: [{ id: "ch1", scenes: [] }, { id: "ch2", scenes: [scene(30)] }] })],
    ["a scene with no picture", JSON.stringify({ chapters: [{ id: "ch1", scenes: [scene(30, { visual_prompt: "   " })] }, { id: "ch2", scenes: [scene(30)] }] })],
    ["empty", ""],
  ] as const) {
    it(`${name} is invalid (the plan fails), never a length problem that is asked again or a shorter plan`, () => {
      expect(readWindow(text, w, refsOf(o), limits)).toEqual({ ok: false, why: "invalid" });
    });
  }

  it("a scene length written as a string is read; one written as words is a length problem named in numbers", () => {
    expect(readWindow(JSON.stringify({ chapters: [{ id: "ch1", scenes: [scene("30" as unknown as number)] }, { id: "ch2", scenes: [scene(30)] }] }), w, refsOf(o), limits).ok).toBe(true);
    const words = readWindow(JSON.stringify({ chapters: [{ id: "ch1", scenes: [scene("thirty" as unknown as number)] }, { id: "ch2", scenes: [scene(30)] }] }), w, refsOf(o), limits);
    expect(words).toMatchObject({ ok: false, why: "length" });
    expect(words.ok === false && words.why === "length" && words.problem).toMatch(/scene 1 is missing a length/);
  });

  it("more scenes than the window allows is a length problem, not silently cut", () => {
    const many = { chapters: [{ id: "ch1", scenes: Array.from({ length: 10 }, () => scene(3)) }, { id: "ch2", scenes: Array.from({ length: 10 }, () => scene(3)) }] };
    const r = readWindow(JSON.stringify(many), w, refsOf(o), limits);
    expect(r.ok === false && r.why === "length" && r.problem).toMatch(new RegExp(`at most ${w.maxScenes} are allowed`));
  });
});

describe("Unicode and very long input in a plan", () => {
  it("Uzbek, Cyrillic and emoji survive; half an emoji is dropped", () => {
    const o = outline([30], 30);
    const limits = planLimits(null);
    const w = planWindows(o, limits)![0];
    const r = readWindow(JSON.stringify({ chapters: [{ id: "ch1", scenes: [scene(30, {
      title: "Qoʻriqchi va karvon 🐫 — Страж",
      visual_prompt: "a caravan at dusk 🐫" + "\ud83d",
      dialogue: [{ character_id: "c1", line: "Toʻxta! Стой! 🛑" }],
    })] }] }), w, refsOf(o), limits, "", undefined, [], undefined, ["in_clip", "none"]);
    // The reader keeps every script in a line when in-clip speech is allowed (it is not, today: speechAllowed).
    expect(r.ok).toBe(true);
    const s = r.ok ? r.parts[0][0] : null;
    expect(s?.title).toBe("Qoʻriqchi va karvon 🐫 — Страж");
    expect(s?.dialogue[0].line).toBe("Toʻxta! Стой! 🛑");
    expect(s?.visual_prompt).toBe("a caravan at dusk 🐫");
  });

  it("a 20,000-character picture is not cut to fit (S9, 0218): it goes back to the model once, with the limit", () => {
    const o = outline([30], 30);
    const limits = planLimits(null);
    const w = planWindows(o, limits)![0];
    const r = readWindow(JSON.stringify({ chapters: [{ id: "ch1", scenes: [scene(30, { visual_prompt: "x".repeat(20_000) + "\ud83d" })] }] }), w, refsOf(o), limits);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why === "prompt" && r.problem).toContain(`over ${FILM.promptMax} characters`);
  });
});

describe("a payload stored before the plan step", () => {
  it("scenes that add up to the length are kept as the storyboard (no plan needed)", () => {
    const s = readScenario({ ...outlineRaw([]), chapters: [], scenes: [scene(20), scene(20), scene(20)] }, SHORT(60));
    expect(s?.scenes.map((x) => x.duration_s)).toEqual([20, 20, 20]);
  });

  it("scenes that do not add up are not a storyboard: an outline when its chapters add up, otherwise nothing", () => {
    expect(readScenario({ ...outlineRaw([]), chapters: [], scenes: [scene(20), scene(20)] }, SHORT(60))).toBeNull();
    const asOutline = readScenario({ ...outlineRaw([30, 30]), scenes: [scene(20), scene(20)] }, SHORT(60));
    expect(asOutline?.scenes).toEqual([]);
    expect(asOutline?.chapters.map((c) => c.seconds)).toEqual([30, 30]);
  });

  it("a scene longer than a film takes, or more than 60 scenes, is not a storyboard even when they add up", () => {
    expect(readScenario({ ...outlineRaw([]), chapters: [], scenes: [scene(35), scene(25)] }, SHORT(60))).toBeNull();
    expect(readScenario({ ...outlineRaw([]), chapters: [], scenes: Array.from({ length: 61 }, () => scene(10)) }, SHORT(610))).toBeNull();
  });
});

describe("a long-kind outline keeps its own path", () => {
  it("a long scenario is never planned: its scenes are informational, a fresh one has none, and it has no film to draft", () => {
    const fresh = readScenario(outlineRaw([300, 300], { scenes: [scene(30)] }), LONG(600), { outline: true })!;
    expect(fresh.scenes).toEqual([]);
    const stored = readScenario(outlineRaw([], { scenes: [scene(30), scene(90)] }), LONG(600))!;
    // Not held to the film's 3–30 s or to the length: Run now cuts its own scenes.
    expect(stored.scenes.map((s) => s.duration_s)).toEqual([30, 90]);
    expect(filmFromBrief(buildBrief("s", LONG(600), stored, "ready"))).toBeNull();
  });
});

describe("shots per scene from the clip model's lengths", () => {
  const brief = (seconds: number[], clipDialogue = false) => buildBrief("s", SHORT(seconds.reduce((a, b) => a + b, 0)), {
    ...outline([seconds.reduce((a, b) => a + b, 0)], seconds.reduce((a, b) => a + b, 0)),
    scenes: seconds.map((d, i) => ({ id: `s${i + 1}`, n: i + 1, title: "t", duration_s: d, visual_prompt: "v", dialogue: clipDialogue ? [{ character_id: "c1", line: "Hi" }] : [],
      character_ids: [], location_id: null, prop_ids: [], keyframe_model: null, clip_model: null })),
  }, "ready");

  it("unknown durations: no scene gets a shot_count, whatever its length", () => {
    for (const clip of [null, { durations: null, maxShots: 3 }, { durations: [], maxShots: 3 }]) {
      const f = filmFromBrief(brief([30, 10, 5]), clip)!;
      expect(f.scenes.every((s) => !("shot_count" in s))).toBe(true);
      expect(planLimits(clip).clipLongest).toBeNull();
    }
  });

  it("known durations: 30 s on a 10 s model is 3 shots, 10 s is 1, 11 s is 2, and the plan's longest scene is 30 s", () => {
    const clip = { durations: [5, 10], maxShots: 3 };
    expect(filmFromBrief(brief([30, 10, 11]), clip)!.scenes.map((s) => s.shot_count)).toEqual([3, 1, 2]);
    expect(planLimits(clip)).toMatchObject({ sceneMax: 30, clipLongest: 10, maxShots: 3 });
  });

  it("35 s on a 10 s model with max_shots 3 is refused by the plan before it is drafted (3 × 10 = 30 s is the most it makes)", () => {
    const o = outline([35], 35);
    const limits = planLimits({ durations: [10], maxShots: 3 });
    const w = planWindows(o, limits)!;
    const r = readWindow(JSON.stringify({ chapters: [{ id: "ch1", scenes: [scene(35)] }] }), w[0], refsOf(o), limits);
    expect(r.ok === false && r.why === "length" && r.problem).toMatch(/scene 1 is 35 s; every scene must be 3 to 30 s/);
    // And the shot count is capped at max_shots rather than grown past it: quote_film refuses such a scene by name.
    expect(shotCount(35, { durations: [10], maxShots: 3 })).toBe(3);
  });

  it("a 5 s model with max_shots 3 tells the plan 15 s: 16 s is a length problem, 15 s is 3 shots", () => {
    const limits = planLimits({ durations: [5], maxShots: 3 });
    expect(limits.sceneMax).toBe(15);
    const o = outline([16, 15], 31);
    const w = planWindows(o, limits)![0];
    const r = readWindow(JSON.stringify({ chapters: [{ id: "ch1", scenes: [scene(16)] }, { id: "ch2", scenes: [scene(15)] }] }), w, refsOf(o), limits);
    expect(r.ok === false && r.why === "length" && r.problem).toMatch(/chapter ch1: scene 1 is 16 s; every scene must be 3 to 15 s/);
    expect(shotCount(15, { durations: [5], maxShots: 3 })).toBe(3);
  });

  it("no scene asks for the clip's audio while the cut drops clip sound, a dialogue scene included (S1, BR-SG-01)", () => {
    const talk = filmFromBrief(brief([30, 3], true), { durations: [10], maxShots: 3 })!;
    expect(talk.scenes.every((s) => !("clip_params" in s))).toBe(true);
    expect(filmFromBrief(brief([30, 3]), null)!.scenes.every((s) => !("clip_params" in s))).toBe(true);
  });
});
