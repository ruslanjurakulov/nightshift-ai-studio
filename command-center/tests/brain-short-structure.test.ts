import { describe, expect, it } from "vitest";
import { buildBrief, filmFromBrief, readModelAnswer, readScenario, unsafeBrief, type BrainSlots } from "@/lib/brain/logic";
import { SYSTEM_PROMPT, dataBlock } from "@/lib/brain/prompt";

/**
 * A short film / ad proposal follows the structure the most-watched AI shorts share (Atlas, 21 Nov): a hook in the first second of
 * scene 1, one protagonist with a goal, three acts in order, a decided ending, a target shot length per scene. A long video keeps its
 * own pipeline and none of it. The video's language is the person's choice, never the app's locale.
 */

const SHORT: BrainSlots = { kind: "short", target_seconds: 60, aspect: "9:16", style: "desert action", language: "Uzbek", audience: "teens" };
const LONG: BrainSlots = { kind: "long", target_seconds: 300, aspect: "16:9", style: "noir", language: "English", audience: "history fans" };

const structure = {
  hook: { seen: "An arrow splits the water skin in Aziz's hand", heard: "a horse screams" },
  protagonist: { character_id: "c1", goal: "get the caravan to the well before dusk" },
  stakes: "the children in the last wagon have no water left",
  turn: "Aziz gives his horse to the oldest child and walks",
  ending: { type: "cliffhanger", text: "the well is already guarded" },
};
const scenes = [
  { title: "Ambush", duration_s: 12, act: 1, beat: "The caravan is hit", shot_s: 0.8, visual_prompt: "arrow hits a water skin, close-up", character_ids: ["c1"] },
  { title: "Thirst", duration_s: 12, act: 1, beat: "No water left", shot_s: 2.5, visual_prompt: "empty skins" },
  { title: "Chase", duration_s: 12, act: 2, beat: "Riders close in", shot_s: 1, visual_prompt: "riders on dunes" },
  { title: "The horse", duration_s: 12, act: 2, beat: "Aziz gives his horse", shot_s: 3, visual_prompt: "a boy on a horse" },
  { title: "The well", duration_s: 12, act: 3, beat: "Guards at the well", shot_s: 3.5, visual_prompt: "torches at a well" },
];
const scen = (o: Record<string, unknown> = {}) => ({
  title: "The last well", idea: "A guard walks a caravan through an ambush to the last well.", story: { logline: "l", conflict: "c" },
  characters: [{ id: "c1", name: "Aziz", description: "a young guard", image_prompt: "young guard, sand" }],
  locations: [], props: [], chapters: [], structure, scenes, ...o,
});
const answer = (s: unknown[]) => JSON.stringify({ reply: "Here are ideas", scenarios: s });

describe("a short film scenario carries the structure, checked by the server", () => {
  it("keeps the hook, protagonist, acts, beats, ending and shot lengths of a short proposal", () => {
    const a = readModelAnswer(answer([scen(), scen()]), SHORT, "q")!;
    expect(a.step).toBe("proposing");
    const s = a.scenarios[0];
    expect(s.structure).toEqual(structure);
    expect(s.scenes.map((x) => x.act)).toEqual([1, 1, 2, 2, 3]);
    expect(s.scenes[0]).toMatchObject({ beat: "The caravan is hit", shot_s: 0.8 });
  });

  it("drops a short proposal without a hook: a slow opener is the failure the structure exists to stop", () => {
    const noHook = scen({ structure: { ...structure, hook: { seen: "", heard: "" } } });
    expect(readScenario(noHook, SHORT, { requireStructure: true })).toBeNull();
    const a = readModelAnswer(answer([noHook, noHook]), SHORT, "q")!;
    expect(a.scenarios).toEqual([]);
    expect(a.step).toBe("asking");
  });

  it("the hook belongs to the first scene: scene 1 must open act 1, and the hook leads scene 1's clip prompt only", () => {
    // In order and with acts 2 and 3, but opening in act 2: only the "scene 1 opens act 1" rule refuses it.
    const lateStart = scen({ scenes: scenes.map((x, i) => ({ ...x, act: i < 3 ? 2 : 3 })) });
    expect(readScenario(lateStart, SHORT, { requireStructure: true })).toBeNull();
    const b = buildBrief("sess", SHORT, readScenario(scen(), SHORT, { requireStructure: true }), "ready");
    const f = filmFromBrief(b)!;
    expect(String(f.scenes[0].visual_prompt).startsWith(`Opening second: ${structure.hook.seen}. Heard: ${structure.hook.heard}`)).toBe(true);
    for (const later of f.scenes.slice(1)) expect(String(later.visual_prompt)).not.toContain("Opening second");
  });

  it("needs all three acts, in order: two acts, or an act that goes back, is not a proposal", () => {
    const twoActs = scen({ scenes: scenes.map((x) => ({ ...x, act: x.act === 3 ? 2 : x.act })) });
    expect(readScenario(twoActs, SHORT, { requireStructure: true })).toBeNull();
    const noMiddle = scen({ scenes: scenes.map((x) => ({ ...x, act: x.act === 2 ? 3 : x.act })) });
    expect(readScenario(noMiddle, SHORT, { requireStructure: true })).toBeNull();
    const backwards = scen({ scenes: [scenes[0], scenes[2], scenes[1], scenes[3], scenes[4]] });
    expect(readScenario(backwards, SHORT, { requireStructure: true })).toBeNull();
    const missing = scen({ scenes: [{ ...scenes[0], act: undefined }, ...scenes.slice(1)] });
    expect(readScenario(missing, SHORT, { requireStructure: true })).toBeNull();
  });

  it("needs one protagonist who is a character of the film, with a goal, and an ending that is payoff or cliffhanger", () => {
    expect(readScenario(scen({ structure: { ...structure, protagonist: { character_id: "ghost", goal: "g" } } }), SHORT, { requireStructure: true })).toBeNull();
    expect(readScenario(scen({ structure: { ...structure, protagonist: { character_id: "c1", goal: "" } } }), SHORT, { requireStructure: true })).toBeNull();
    expect(readScenario(scen({ structure: { ...structure, ending: { type: "happy", text: "" } } }), SHORT, { requireStructure: true })).toBeNull();
    expect(readScenario(scen({ structure: { ...structure, ending: { type: "payoff", text: "" } } }), SHORT, { requireStructure: true })?.structure?.ending.type).toBe("payoff");
  });

  it("a shot target stays within 0.5–4 s and within its scene, and is unknown (null) when not given, never a default", () => {
    const s = readScenario(scen({ scenes: [{ ...scenes[0], shot_s: 0.1 }, { ...scenes[1], shot_s: 99 }, { ...scenes[2], shot_s: undefined }, scenes[3], scenes[4]] }), SHORT)!;
    expect(s.scenes.map((x) => x.shot_s).slice(0, 3)).toEqual([0.5, 4, null]);
  });

  it("a stored proposal from before the structure can still be chosen (choose re-reads without requiring it)", () => {
    const old = scen({ structure: undefined });
    expect(readScenario(old, SHORT)).not.toBeNull();
    expect(readScenario(old, SHORT)?.structure).toBeUndefined();
    expect(filmFromBrief(buildBrief("s", SHORT, readScenario(old, SHORT), "ready"))!.scenes[0].visual_prompt).not.toContain("Opening second");
  });

  it("the hook and the other structure text pass the same safety floor as the scenes", () => {
    const bad = readScenario(scen({ structure: { ...structure, hook: { seen: "a naked man runs", heard: "" } } }), SHORT, { requireStructure: true });
    expect(unsafeBrief(buildBrief("s", SHORT, bad, "ready"))).toBe(true);
  });
});

describe("a long video is unaffected", () => {
  it("long proposals need no structure, and their scenes and BRIEF carry none of it even when the model writes it", () => {
    const plain = scen({ structure: undefined, scenes: scenes.map(({ act: _a, beat: _b, shot_s: _s, ...rest }) => rest) });
    const a = readModelAnswer(answer([plain, scen()]), LONG, "q")!;
    expect(a.step).toBe("proposing");
    expect(a.scenarios).toHaveLength(2);
    for (const s of a.scenarios) {
      expect(s.structure).toBeUndefined();
      for (const sc of s.scenes) expect(Object.keys(sc).sort()).toEqual(
        ["character_ids", "clip_model", "dialogue", "duration_s", "id", "keyframe_model", "location_id", "n", "prop_ids", "title", "visual_prompt"]);
    }
    const b = buildBrief("s", LONG, a.scenarios[1], "ready");
    expect(b.structure).toBeUndefined();
    expect(filmFromBrief(b)).toBeNull();
  });
});

describe("the video's language comes from the person's choice, never the app's locale", () => {
  const facts = { state: "none" as const, source: null, name: "c", statuses: {}, ownRecent: [], competitorTop: [], audienceAsks: [] };
  it("content_language is the chosen language even when the app is in another one, and unknown until chosen", () => {
    const chosen = JSON.parse(dataBlock({ history: [], slots: SHORT, askNext: null, facts, locale: "ru", shortAvailable: true }).replace(/^[^{]*/, ""));
    expect(chosen.content_language).toBe("Uzbek");
    expect(chosen.app_language).toBe("ru");
    const notYet = JSON.parse(dataBlock({ history: [], slots: { kind: "short" }, askNext: "target_seconds", facts, locale: "uz", shortAvailable: true }).replace(/^[^{]*/, ""));
    expect(notYet.content_language).toBeNull();
  });

  it("the prompt tells the model to write the video in content_language and never to take the language from app_language", () => {
    expect(SYSTEM_PROMPT).toMatch(/write every scenario's titles, idea, story, structure, beats and dialogue in it/);
    expect(SYSTEM_PROMPT).toMatch(/"app_language" is only the language of the app's buttons: never use it to fill "language"/);
  });

  it("the film's language is the chosen one, whatever the app's locale", () => {
    const b = buildBrief("s", { ...SHORT, language: "English" }, readScenario(scen(), SHORT, { requireStructure: true }), "ready");
    expect(filmFromBrief(b)!.settings.language).toBe("en");
  });
});

describe("the prompt asks for the short-film structure and keeps it off long videos", () => {
  it("names the hook in the first second, one protagonist with a goal, three acts, shot lengths and the two endings", () => {
    expect(SYSTEM_PROMPT).toMatch(/FIRST SECOND of scene 1/);
    expect(SYSTEM_PROMPT).toMatch(/Never a slow or wide establishing shot/);
    expect(SYSTEM_PROMPT).toMatch(/ONE main character .* with ONE clear goal/);
    expect(SYSTEM_PROMPT).toMatch(/every scene has "act" 1, 2 or 3, in order, scene 1 in act 1/);
    expect(SYSTEM_PROMPT).toMatch(/"shot_s"/);
    expect(SYSTEM_PROMPT).toMatch(/"payoff" .* or "cliffhanger"/);
    expect(SYSTEM_PROMPT).toMatch(/A long video \("long"\) has its own pipeline: leave "structure", "act", "beat" and "shot_s" out of it/);
  });
});
