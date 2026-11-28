import { describe, expect, it } from "vitest";
import {
  CLIP_PROMPT_SAVED,
  CLIP_SOUND_IN_CUT,
  NO_TEXT,
  speechAllowed,
  voiceQuotable,
  buildBrief,
  clipPrompt,
  filmFromBrief,
  keyframePrompt,
  mergeSlots,
  nextSlot,
  readModelAnswer,
  readScenario,
  readSlots,
  scenePrompt,
  speechBlocks,
  storyProblem,
  type BrainSlots,
  type Brief,
  type BriefScene,
  type Scenario,
} from "@/lib/brain/logic";
import { SPOKEN_CPS, STORY, looksOverLimit, mergePlan, planLimits, planTurns, planWindows, readWindow, refsOf, shotRules, spokenSeconds, withPlanTurns } from "@/lib/brain/plan";
import { filmLeaseMaxTurns, filmPlanTurns } from "@/lib/brain/film-plan";
import { PLAN_SYSTEM_PROMPT, SYSTEM_PROMPT, dataBlock, planDataBlock } from "@/lib/brain/prompt";
import { aiChatEn } from "@/lib/i18n/ai-chat/en";
import { aiChatRu } from "@/lib/i18n/ai-chat/ru";
import { aiChatUz } from "@/lib/i18n/ai-chat/uz";
import { LOOK, storyOutline, storyScene } from "./helpers/storyFixtures";

/**
 * S1 story grammar: one sentence becomes a story film with an arc, characters that stay the same, and planned shots. What breaks if
 * these fail: the answer to the last question proposes nothing and the person has to write again; a guessed aspect is asked as a
 * card anyway, or beats an answer the person gave; an outline without a payoff is proposed; a shot drifts because each scene
 * re-describes the character; an Uzbek film's prompts reach the image model in Uzbek; a voice-over runs over the cut; a film whose
 * speech nobody would hear is offered at Create; a plan takes more turns than 0232's lease allows.
 */

const SHORT = (t: number, language = "English"): BrainSlots => ({ kind: "short", target_seconds: t, aspect: "9:16", style: "cartoon", language: language as BrainSlots["language"], audience: "families" });
const story = (seconds: number[], o: Record<string, unknown> = {}, t = seconds.reduce((a, b) => a + b, 0)) =>
  readScenario(storyOutline(seconds, o), SHORT(t), { outline: true }) as Scenario;

/** 0232's ai_chat_film_plan_max_turns(t), through its TS mirror (lib/brain/film-plan): never a second copy of the formula. */
const leaseMaxTurns = filmLeaseMaxTurns;

describe("A: the answer to the last open question proposes in the same turn", () => {
  it("DATA names the open slots and says when one is left; the prompt tells the model to propose then", () => {
    const slots: BrainSlots = { kind: "short", target_seconds: 30, aspect: "9:16", style: "cartoon", language: "Uzbek" };
    const d = JSON.parse(dataBlock({ history: [], slots, askNext: nextSlot(slots), facts: { state: "none", source: null, name: "", statuses: {}, ownRecent: [], competitorTop: [], audienceAsks: [] }, locale: "uz", shortAvailable: true }).split("\n")[1]);
    expect(d).toMatchObject({ ask_next: "audience", open_slots: ["audience"], last_open_slot: true });
    expect(SYSTEM_PROMPT).toMatch(/last_open_slot/);
    expect(SYSTEM_PROMPT).toMatch(/propose the outlines in this same answer/);
  });

  it("the answer filling the last slot carries outlines, and they are read as a proposal, not dropped for a card", () => {
    const prev: BrainSlots = { kind: "short", target_seconds: 60, aspect: "9:16", style: "cartoon", language: "Uzbek" };
    const a = readModelAnswer(JSON.stringify({ reply: "Mana", slots: { audience: "oilalar" }, scenarios: [storyOutline([15, 15, 15, 15]), storyOutline([10, 20, 20, 10])] }), prev, "q");
    expect(a?.step).toBe("proposing");
    expect(a?.card).toBeNull();
    expect(a?.scenarios).toHaveLength(2);
  });
});

describe("B: aspect, language and audience may be inferred, shown as chips, and never beat what the person said", () => {
  it("one sentence fills kind, length and style as said and the other three as inferred: no question card at all", () => {
    const a = readModelAnswer(JSON.stringify({
      reply: "Mana", slots: { kind: "short", target_seconds: 30, style: "multfilm" },
      inferred: { aspect: "9:16", language: "Uzbek", audience: "oilalar" },
      scenarios: [storyOutline([8, 8, 7, 7]), storyOutline([6, 9, 9, 6])],
    }), {}, "q");
    expect(a?.slots).toMatchObject({ kind: "short", target_seconds: 30, aspect: "9:16", language: "Uzbek", audience: "oilalar" });
    expect(a?.slots.inferred).toEqual(["aspect", "language", "audience"]);
    expect(a?.card).toBeNull();
    expect(a?.step).toBe("proposing");
  });

  it("an explicit answer replaces an inference and clears its mark; an inference never overwrites an answer", () => {
    const guessed = mergeSlots({ kind: "short" }, {}, { aspect: "9:16" }).slots;
    expect(guessed).toMatchObject({ aspect: "9:16", inferred: ["aspect"] });
    const said = mergeSlots(guessed, { aspect: "16:9" }).slots;
    expect(said.aspect).toBe("16:9");
    expect(said.inferred).toBeUndefined();
    // A later guess cannot take the person's own answer back.
    expect(mergeSlots(said, {}, { aspect: "1:1" }).slots.aspect).toBe("16:9");
    // An inferred value the server cannot make is no value: the slot stays open and is asked as a card.
    const bad = mergeSlots({ kind: "short" }, {}, { aspect: "4:3", language: "Klingon" }).slots;
    expect(bad.aspect).toBeUndefined();
    expect(bad.language).toBeUndefined();
    expect(bad.inferred).toBeUndefined();
  });

  it("kind, length and style are never taken as inferences, and a long video's 16:9 is no guess", () => {
    const s = mergeSlots({}, {}, { kind: "short", target_seconds: 30, style: "x", aspect: "9:16" } as Record<string, unknown>).slots;
    expect(s.kind).toBeUndefined();
    expect(s.target_seconds).toBeUndefined();
    expect(s.style).toBeUndefined();
    const long = mergeSlots({ kind: "long" }, {}, { aspect: "9:16", language: "Russian" }).slots;
    expect(long.aspect).toBe("16:9");
    expect(long.inferred).toEqual(["language"]);
  });

  it("a card is asked only for what could not be inferred", () => {
    const a = readModelAnswer(JSON.stringify({ reply: "x", slots: { kind: "short", target_seconds: 30, style: "cartoon" },
      inferred: { language: "Uzbek", audience: "families" }, card: { question: "Which shape?", options: ["16:9", "9:16", "1:1"] } }), {}, "q");
    expect(a?.card?.slot).toBe("aspect");
  });

  it("the marks survive a store and a read, and only for slots that hold a value", () => {
    expect(readSlots({ kind: "short", aspect: "9:16", inferred: ["aspect", "audience", "kind"] })).toMatchObject({ aspect: "9:16", inferred: ["aspect"] });
  });

  it("a forced change (the chip) wins over whatever the model wrote this turn", () => {
    const prev: BrainSlots = { kind: "short", target_seconds: 30, style: "c", aspect: "9:16", language: "Uzbek", audience: "a", inferred: ["aspect", "language", "audience"] };
    const a = readModelAnswer(JSON.stringify({ reply: "ok", slots: { aspect: "1:1" } }), prev, "q", { force: { aspect: "16:9" } });
    expect(a?.slots.aspect).toBe("16:9");
    expect(a?.slots.inferred).toEqual(["language", "audience"]);
  });
});

describe("C: the outline keeps an arc, a hook and fixed looks", () => {
  it("beats out of order, a missing payoff or a missing longing are problems with the reason; a short film may skip longing", () => {
    expect(storyProblem(story([15, 15, 15, 15]))).toBeNull();
    const swapped = story([15, 15, 15, 15], { chapters: storyOutline([15, 15, 15, 15]).chapters as unknown[] });
    (swapped.chapters[1] as { beat?: string }).beat = "turn";
    (swapped.chapters[2] as { beat?: string }).beat = "longing";
    expect(storyProblem(swapped)).toMatch(/setup > turn > longing > payoff.*setup > longing > turn > payoff/);
    const noPayoff = story([15, 15, 15, 15]);
    noPayoff.chapters[3].beat = "turn";
    expect(storyProblem(noPayoff)).toMatch(/ending with payoff/);
    // 30 s with no longing: not a story at this length.
    expect(storyProblem(story([10, 10, 10]))).toMatch(/setup > longing > turn > payoff/);
    // 15 s: setup > turn > payoff is a whole arc.
    expect(storyProblem(story([5, 5, 5]))).toBeNull();
  });

  it("a missing hook, an incomplete look or a montage nobody ages in are problems too", () => {
    expect(storyProblem(story([15, 15, 15, 15], { hook: "" }))).toMatch(/hook/);
    const noLook = storyOutline([15, 15, 15, 15]);
    (noLook.characters as Record<string, unknown>[])[0].look = { ...LOOK, signature: "" };
    expect(storyProblem(readScenario(noLook, SHORT(60), { outline: true })!)).toMatch(/c1 need a complete "look"/);
    const noAges = storyOutline([15, 15, 15, 15]);
    delete (noAges.characters as Record<string, unknown>[])[1].age_stages;
    expect(storyProblem(readScenario(noAges, SHORT(60), { outline: true })!)).toMatch(/F3/);
  });

  it("a planted object pays off in the last third, after it is planted", () => {
    const good = story([15, 15, 15, 15], { planted_object: { text: "a thermos", prop_id: "p1", planted_chapter: "ch1", payoff_chapter: "ch4" } });
    expect(storyProblem(good)).toBeNull();
    const early = story([15, 15, 15, 15], { planted_object: { text: "a thermos", prop_id: "p1", planted_chapter: "ch1", payoff_chapter: "ch2" } });
    expect(storyProblem(early)).toMatch(/last third/);
  });

  it("a fresh proposal that breaks the grammar is dropped, and the reason is returned for the one re-ask", () => {
    const bad = storyOutline([15, 15, 15, 15], { hook: "" });
    const a = readModelAnswer(JSON.stringify({ reply: "x", scenarios: [bad, bad] }), SHORT(60), "q");
    expect(a?.scenarios).toEqual([]);
    expect(a?.storyProblem).toMatch(/hook/);
    // A stored proposal from before the grammar still reads (choose re-reads it without the check).
    expect(readScenario({ ...bad, chapters: [{ id: "ch1", title: "x", seconds: 60, beats: [] }] }, SHORT(60))).not.toBeNull();
  });

  it("the BRIEF carries the craft fields and the chapters' beats and emotions", () => {
    const b = buildBrief("s", SHORT(60), story([15, 15, 15, 15], { closing_card: "Dadamga", cover_title: "Uzoq shahar" }), "drafting");
    expect(b).toMatchObject({ format: "F3", hook: expect.any(String), closing_card: "Dadamga", cover_title: "Uzoq shahar", visual_style: "warm 2D cartoon" });
    expect(b.chapters!.map((c) => c.beat)).toEqual(["setup", "longing", "turn", "payoff"]);
    expect(b.characters![1].age_stages!.map((a) => a.id)).toEqual(["a1", "a2"]);
  });
});

const outline60 = () => story([15, 15, 15, 15]);
const limits60 = () => planLimits(null, null, 60);
const answerFor = (w: ReturnType<typeof planWindows>, i: number, scene: (k: number, p: { id: string; seconds: number }) => Record<string, unknown>[]) =>
  JSON.stringify({ chapters: w![i].parts.map((p) => ({ id: p.chapter_id, scenes: scene(0, { id: p.chapter_id, seconds: p.seconds }) })) });
const split = (seconds: number, size = 3) => {
  const k = Math.ceil(seconds / 5);
  return Array.from({ length: Math.max(k, Math.ceil(seconds / 5)) }, (_, i) => Math.floor(seconds / k) + (i < seconds % k ? 1 : 0)).filter((x) => x >= size);
};

describe("D: the shot grammar (ported from ViMax) is checked and folded into the prompts", () => {
  it("a chapter whose first shot is not wide is a rules problem for the re-ask; a whole answer reads", () => {
    const o = outline60();
    const w = planWindows(o, limits60())!;
    const rules = shotRules(o, "English");
    const good = answerFor(w, 0, (_, p) => split(p.seconds).map((d, i) => storyScene(d, i, i === 0 && p.id === "ch1" ? { hook: true } : {})));
    expect(readWindow(good, w[0], refsOf(o), limits60(), "", undefined, [], rules)).toMatchObject({ ok: true });
    const notWide = answerFor(w, 0, (_, p) => split(p.seconds).map((d, i) => storyScene(d, i, { shot: "close", ...(i === 0 ? { hook: true } : {}) })));
    const r = readWindow(notWide, w[0], refsOf(o), limits60(), "", undefined, [], rules);
    expect(r).toMatchObject({ ok: false, why: "rules" });
    expect((r as { problem: string }).problem).toMatch(/first scene must be a "wide" establishing shot/);
  });

  it("a missing frame, a staged character without its stage, and a film whose first shot lacks the hook are problems", () => {
    const o = outline60();
    const w = planWindows(o, limits60())!;
    const rules = shotRules(o, "English");
    const bad = answerFor(w, 0, (_, p) => split(p.seconds).map((d, i) => storyScene(d, i, { first_frame: "", in_frame: [{ character_id: "c2", age_stage: null }] })));
    const r = readWindow(bad, w[0], refsOf(o), limits60(), "", undefined, [], rules) as { why: string; problem: string };
    expect(r.why).toBe("rules");
    expect(r.problem).toMatch(/missing first_frame/);
    expect(r.problem).toMatch(/c2 without one of its age_stage ids \(a1, a2\)/);
    expect(r.problem).toMatch(/must carry the hook/);
  });

  it("the shot, camera, light, first frame and each in-frame look (at its age stage) are folded verbatim; the clip gets the move", () => {
    const o = outline60();
    const scene = { ...readScenario({ ...storyOutline([60]), scenes: [] }, SHORT(60))!, scenes: [] };
    void scene;
    const s: BriefScene = {
      id: "s1", n: 1, title: "t", duration_s: 4, visual_prompt: "the girl runs to the gate", dialogue: [], character_ids: ["c2"], location_id: "l1",
      prop_ids: [], keyframe_model: null, clip_model: null, shot: "wide", camera: { position: "gate, low angle", move: "push_in" },
      lighting: "golden hour backlight", first_frame: "a girl stands at an open gate, facing the road", motion: "slow push in; the girl in the yellow coat runs",
      last_frame: "the girl at the road", in_frame: [{ character_id: "c2", age_stage: "a2" }], speech: "voice_over", narration: "U kutdi.",
    };
    const stage = o.characters[1].age_stages![1];
    const film = { characters: o.characters, locations: o.locations, style: "multfilm", visual_style: o.visual_style };
    const kf = keyframePrompt(film, s);
    const clip = clipPrompt(film, s);
    for (const p of [kf, clip]) {
      expect(p).toContain("Wide establishing shot.");
      expect(p).toContain("gate, low angle");
      expect(p).toContain("Lighting: golden hour backlight");
      expect(p).toContain(`Qiz (${stage.label}): face ${stage.look.face}; hair ${stage.look.hair}; build ${stage.look.build}; outfit ${stage.look.outfit}; palette ${stage.look.palette}; signature ${stage.look.signature}`);
      expect(p).toContain("Setting: Bus stop. a village bus stop at dawn");
      expect(p).toContain("Style: warm 2D cartoon");
      expect(p).toContain("No one speaks; mouths closed.");
    }
    expect(kf).toContain("First frame: a girl stands at an open gate");
    expect(kf).not.toContain("slow push in");
    expect(clip).toContain("slow push in");
    expect(clip).toContain("Motion: slow push in; the girl in the yellow coat runs");
    expect(clip).not.toContain("First frame:");
    // The saved prompt (one column makes both today) carries both, and no spoken line.
    expect(scenePrompt(film, s)).toContain("First frame:");
    expect(scenePrompt(film, s)).toContain("Motion:");
  });

  it("an in-clip line reaches no prompt while one prompt makes both pictures, and 'mouths closed' is never said of an in-clip scene", () => {
    const o = outline60();
    const s: BriefScene = { id: "s1", n: 1, title: "t", duration_s: 4, visual_prompt: "the father hugs her", dialogue: [{ character_id: "c1", line: "Qizim!" }],
      character_ids: ["c1"], location_id: null, prop_ids: [], keyframe_model: null, clip_model: null, speech: "in_clip", shot: "two_shot" };
    const film = { characters: o.characters, locations: o.locations };
    expect(CLIP_PROMPT_SAVED).toBe(false);
    expect(clipPrompt(film, s)).not.toContain("Qizim");
    expect(keyframePrompt(film, s)).not.toContain("Qizim");
    expect(scenePrompt(film, s)).not.toContain("Qizim");
    expect(clipPrompt(film, s)).not.toContain("mouths closed");
  });

  it("on-screen words are text layers, never drawn: the prompt says no text, and the BRIEF lists every layer with the closing card", () => {
    const o = { ...outline60(), closing_card: "Barcha otalarga" };
    const scenes: BriefScene[] = [
      { id: "s1", n: 1, title: "", duration_s: 30, visual_prompt: "a bill on the table", dialogue: [], character_ids: [], location_id: null, prop_ids: [],
        keyframe_model: null, clip_model: null, text_layers: [{ text: "10 yil o'tib", position: "bottom" }] },
      { id: "s2", n: 2, title: "", duration_s: 30, visual_prompt: "sunset", dialogue: [], character_ids: [], location_id: null, prop_ids: [], keyframe_model: null, clip_model: null },
    ];
    const b = buildBrief("s", SHORT(60), { ...o, scenes }, "ready");
    expect(b.text_layers).toEqual([{ scene_id: "s1", text: "10 yil o'tib", position: "bottom" }, { scene_id: "s2", text: "Barcha otalarga", position: "center" }]);
    expect(scenePrompt(b, scenes[0])).toContain("No text, no letters, no signage.");
  });

  it("BR-SG-05: every prompt says no text, the closing card's scene and a scene with no layer of its own included", () => {
    const o = outline60();
    const plain = { id: "s1", n: 1, title: "", duration_s: 4, visual_prompt: "sunset", dialogue: [], character_ids: [], location_id: null, prop_ids: [],
                    keyframe_model: null, clip_model: null } as BriefScene;
    const film = { characters: o.characters, locations: o.locations };
    for (const f of [keyframePrompt, clipPrompt, scenePrompt]) expect(f(film, plain)).toContain(NO_TEXT);
  });

  it("a shot chains to the one before it only inside its chapter, never across", () => {
    const o = story([10, 10], { chapters: (storyOutline([10, 10]).chapters as Record<string, unknown>[]) }, 20);
    const w = planWindows(o, planLimits(null, null, 20))!;
    const parts = w.map((win) => win.parts.map((p) => [3, p.seconds - 3].map((d, i) => ({ ...(storyScene(d, i) as object), seconds: d, chapter_id: p.chapter_id,
      dialogue: [], character_ids: ["c1"], location_id: "l1", prop_ids: [], keyframe_model: null, clip_model: null, visual_prompt: "v", title: "t" }))));
    const m = mergePlan(o, w, parts as never);
    expect(m.ok).toBe(true);
    const sc = (m as { scenario: Scenario }).scenario.scenes;
    expect(sc.map((s) => s.chain_from)).toEqual([null, "s1", null, "s3"]);
  });
});

describe("E: visual prompts are English whatever the film's language", () => {
  it("an Uzbek film's plan is told to write its visual fields in English and its words in Uzbek", () => {
    const o = outline60();
    const d = JSON.parse(planDataBlock({ outline: o, parts: [], window: { n: 1, of: 1 }, limits: { sceneMin: 3, sceneMax: 5, maxScenes: 15 },
                                         style: "multfilm", language: "Uzbek", aspect: "9:16" }).split("\n")[1]);
    expect(d.visual_language).toBe("English");
    expect(d.film.language).toBe("Uzbek");
    expect(d.film.visual_style).toBe("warm 2D cartoon");
    expect(PLAN_SYSTEM_PROMPT).toMatch(/Write "visual_prompt", "first_frame", "last_frame", "motion", "lighting" and "camera.position" in English/);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/write "title", "narration", "dialogue" and "text_layers" in DATA "film.language"/);
    expect(PLAN_SYSTEM_PROMPT).not.toMatch(/Write the titles, prompts and lines in DATA "film.language"/);
    expect(SYSTEM_PROMPT).toMatch(/"look" written in English/);
  });
});

describe("G': how each scene is heard, and what Create refuses by name", () => {
  it("a voice-over too long to be said in its seconds is a narration problem (its own kind, for its own refusal)", () => {
    expect(spokenSeconds("bir ikki uch tort besh olti yetti sakkiz", "Uzbek")).toBe(4);
    const o = outline60();
    const w = planWindows(o, limits60())!;
    const rules = shotRules(o, "Uzbek");
    const long = "Ota har kuni ertalab uzoq shaharga ketadi va qizi uni deraza oldida kutib turadi har kuni";
    const ans = answerFor(w, 0, (_, p) => split(p.seconds).map((d, i) => storyScene(d, i, { speech: "voice_over", narration: long, ...(i === 0 && p.id === "ch1" ? { hook: true } : {}) })));
    // Only a film with a quotable voice may speak over its shots (speechAllowed(true)); today none has one.
    const r = readWindow(ans, w[0], refsOf(o), limits60(), "", undefined, [], rules, speechAllowed(true));
    expect(r).toMatchObject({ ok: false, why: "narration", chapter: 1, scene: 1 });
    expect((r as { problem: string }).problem).toMatch(/takes about \d+\.\d s to say; it must fit in/);
  });

  it("a voice-over scene saves its narration; NO scene asks for clip sound while the cut drops it, an in-clip one included", () => {
    const o = outline60();
    const base = { dialogue: [], character_ids: [], location_id: null, prop_ids: [], keyframe_model: null, clip_model: null, title: "t", visual_prompt: "v" };
    const scenes: BriefScene[] = [
      { ...base, id: "s1", n: 1, duration_s: 20, speech: "voice_over", narration: "Ota ketdi." },
      { ...base, id: "s2", n: 2, duration_s: 20, speech: "in_clip", dialogue: [{ character_id: "c1", line: "Qizim" }] },
      { ...base, id: "s3", n: 3, duration_s: 20, speech: "none" },
    ];
    const b = buildBrief("s", SHORT(60, "Uzbek"), { ...o, scenes }, "ready");
    const f = filmFromBrief(b)!;
    expect(f.scenes[0]).toMatchObject({ narration: "Ota ketdi." });
    expect(f.scenes[0]).not.toHaveProperty("clip_params");
    expect(f.scenes[1]).toMatchObject({ narration: "" });
    expect(f.scenes[1]).not.toHaveProperty("clip_params");
    expect(f.scenes[2]).toMatchObject({ narration: "" });
    expect(f.scenes[2]).not.toHaveProperty("clip_params");
    expect(b.voice.mode).toBe("narration");
  });

  it("while no film voice can be priced and the cut drops clip sound, each is refused by its own name, in one fixed check", () => {
    const sc = (speech: BriefScene["speech"]): BriefScene => ({ id: "s", n: 1, title: "", duration_s: 3, visual_prompt: "v", dialogue: speech === "in_clip" ? [{ character_id: "c1", line: "x" }] : [],
      character_ids: [], location_id: null, prop_ids: [], keyframe_model: null, clip_model: null, speech, ...(speech === "voice_over" ? { narration: "x" } : {}) });
    expect(CLIP_SOUND_IN_CUT).toBe(false);
    expect(speechBlocks([sc("voice_over")], false)).toEqual(["voice_unavailable"]);
    expect(speechBlocks([sc("voice_over")], true)).toEqual([]);
    expect(speechBlocks([sc("in_clip")], true)).toEqual(["clip_sound_not_kept"]);
    expect(speechBlocks([sc("none")], false)).toEqual([]);
  });

  it("only what can be made is planned: today that is wordless, on the chat and the film editor alike (one helper)", () => {
    expect(speechAllowed(false)).toEqual(["none"]);
    expect(speechAllowed(true)).toEqual(["none", "voice_over"]);
    expect(voiceQuotable(null)).toBe(false);
    expect(voiceQuotable({ source: "channel" })).toBe(false);
    expect(voiceQuotable({ source: "creative_tts", model: "m", voice_id: "v" })).toBe(true);
    const d = JSON.parse(planDataBlock({ outline: outline60(), parts: [], window: { n: 1, of: 1 }, limits: { sceneMin: 3, sceneMax: 5, maxScenes: 15 }, style: null,
                                         language: "English", aspect: null }).split("\n")[1]);
    expect(d.speech_allowed).toEqual(["none"]);
  });

  it("an in-clip or voice-over answer is a speech problem for the one re-ask, on a story outline and a project's own", () => {
    for (const [o, lim, rules] of [[outline60(), limits60(), shotRules(outline60(), "English")],
                                   [readScenario({ ...storyOutline([30, 30]), format: undefined }, SHORT(60), { outline: true })!, planLimits(null), undefined]] as const) {
      const w = planWindows(o, lim)!;
      for (const speak of [{ speech: "voice_over", narration: "x" }, { speech: "in_clip", dialogue: [{ character_id: "c1", line: "Hi" }] }]) {
        const ans = answerFor(w, 0, (_, p) => split(p.seconds).map((d, i) => storyScene(d, i, { ...speak, ...(i === 0 && p.id === "ch1" ? { hook: true } : {}) })));
        const r = readWindow(ans, w[0], refsOf(o), lim, "", undefined, [], rules) as { why: string; problem: string };
        expect(r.why).toBe("speech");
        expect(r.problem).toMatch(/can only be planned with "speech" in \["none"\]/);
      }
    }
  });

  it("BR-SG-01: no saved scene ever asks for clip audio while CLIP_SOUND_IN_CUT is false, whatever its speech", () => {
    expect(CLIP_SOUND_IN_CUT).toBe(false);
    const o = outline60();
    const kinds: (BriefScene["speech"] | undefined)[] = ["in_clip", "voice_over", "none", undefined];
    const scenes: BriefScene[] = kinds.flatMap((k, i) => [true, false].map((lines, j) => ({
      id: `s${i * 2 + j + 1}`, n: i * 2 + j + 1, title: "", duration_s: 7, visual_prompt: "v", character_ids: ["c1"], location_id: null, prop_ids: [],
      keyframe_model: null, clip_model: null, dialogue: lines ? [{ character_id: "c1", line: "Hi" }] : [], ...(k ? { speech: k } : {}), narration: "n" })));
    const f = filmFromBrief(buildBrief("s", SHORT(56), { ...o, target_seconds: 56, scenes }, "ready"))!;
    expect(f.scenes.some((s) => (s.clip_params as { audio?: unknown } | undefined)?.audio === true)).toBe(false);
    expect(JSON.stringify(f.scenes)).not.toContain('"Hi"');
  });

  it("BR-SG-04: hyphen- and underscore-joined words are words, and a script without spaces is counted by its characters", () => {
    expect(spokenSeconds(Array.from({ length: 40 }, (_, k) => `w${k}`).join("-"), "English")).toBe(16);
    expect(spokenSeconds("a_b_c_d_e", "English")).toBe(2);
    expect(spokenSeconds("父亲在远方的城市工作", "English")).toBe(10 / SPOKEN_CPS);
  });

  it("a wordless film (F5) that speaks is a rules problem", () => {
    const o = story([15, 15, 15, 15], { format: "F5" });
    const w = planWindows(o, limits60())!;
    const ans = answerFor(w, 0, (_, p) => split(p.seconds).map((d, i) => storyScene(d, i, { speech: "voice_over", narration: "a", ...(i === 0 ? { hook: true } : {}) })));
    expect((readWindow(ans, w[0], refsOf(o), limits60(), "", undefined, [], shotRules(o, "English")) as { problem: string }).problem).toMatch(/wordless/);
  });
});

describe("F: about 3 s a shot, and every plan within 0232's turn bound", () => {
  it("a 100 s story film is 3 windows of at most 15 scenes, aiming at 26–34 shots in all: film route 7 turns, choose 6, bound 11", () => {
    const o = story([20, 30, 30, 20]);
    const lim = planLimits(null, null, 100);
    expect(lim).toMatchObject({ sceneMin: 3, sceneMax: STORY.sceneMax, story: true });
    const w = planWindows(o, lim)!;
    expect(w).toHaveLength(3);
    for (const x of w) expect(x.maxScenes).toBeLessThanOrEqual(15);
    const aim = w.reduce((a, x) => a + (x.aim ?? 0), 0);
    expect(aim).toBeGreaterThanOrEqual(26);
    expect(aim).toBeLessThanOrEqual(34);
    expect(planTurns(o, lim)).toEqual({ about: 3, at_most: 6 });
    expect(leaseMaxTurns(100)).toBe(11);
    expect(filmPlanTurns(100, lim)!.at_most).toBe(7);
  });

  it("a story outline's proposal counts its turns with the story pacing; a legacy one keeps the 3–30 s scenes", () => {
    expect(withPlanTurns([story([20, 30, 30, 20])], "short")[0].plan_turns).toEqual({ about: 3, at_most: 6 });
    const legacy = readScenario({ ...storyOutline([20, 30, 30, 20]), format: undefined }, SHORT(100), { outline: true })!;
    expect(withPlanTurns([legacy], "short")[0].plan_turns).toEqual({ about: 1, at_most: 2 });
  });

  // Chapter layouts a model may write for a length: even, front-heavy, many short, one long.
  const layouts = (t: number): number[][] => {
    const even = (n: number) => Array.from({ length: n }, (_, i) => Math.floor(t / n) + (i < t % n ? 1 : 0));
    const out = [even(1), even(2), even(3), even(4), even(Math.min(20, Math.floor(t / 3)))];
    if (t >= 12) out.push([3, 3, 3, t - 9]);
    if (t >= 20) out.push([t - 9, 3, 3, 3]);
    if (t >= 40) out.push([7, Math.floor((t - 14) / 2), Math.ceil((t - 14) / 2), 7]);
    return out.filter((l) => l.every((s) => s >= 3));
  };
  const clips = [null, { durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], maxShots: 3 }, { durations: [5, 10], maxShots: 3 }];

  it("for every length 10–1200 s, every layout and both clip models: choose ≤ 2·windows and the film route's 1 + 2·windows stay within the bound", () => {
    const over: unknown[] = [];
    let planned = 0;
    for (let t = 10; t <= 1200; t++) {
      const bound = leaseMaxTurns(t);
      for (const clip of clips) {
        for (const storyFilm of [true, false]) {
          const lim = planLimits(clip, null, storyFilm ? t : null);
          for (const l of layouts(t)) {
            const o = readScenario(storyOutline(l, storyFilm ? {} : { format: undefined }), SHORT(t), { outline: true });
            if (!o) continue;
            const w = planWindows(o, lim);
            const turns = planTurns(o, lim);
            if (!w || !turns) continue;
            planned += 1;
            if (turns.at_most > bound || w.some((x) => x.maxScenes > 15)) over.push({ t, l, storyFilm, at_most: turns.at_most, bound });
          }
          const film = filmPlanTurns(t, lim);
          if (film && film.at_most > bound) over.push({ t, film: film.at_most, bound, storyFilm });
        }
      }
    }
    expect(planned).toBeGreaterThan(10_000);
    expect(over).toEqual([]);
  }, 180_000);
});

describe("i18n: every new string in en, ru and uz, Uzbek with its own apostrophes", () => {
  const keys = ["voiceOverNote", "inClipNote", "wordlessNote", "blockedSaved", "wordlessAsk", "wordlessAskText", "seeStoryboard", "inferredChip", "inferredChipLabel", "inferredHeading", "changeQuestion", "changeOwn", "changeCancel"] as const;
  it("has each key, the speech refusals and the new errors in all three", () => {
    for (const d of [aiChatEn, aiChatRu, aiChatUz]) {
      for (const k of keys) expect(typeof d[k]).toBe("string");
      expect(Object.keys(d.speechBlocked).sort()).toEqual(["clip_sound_not_kept", "voice_unavailable"]);
      expect(Object.keys(d.slotNames).sort()).toEqual(["aspect", "audience", "kind", "language", "style", "target_seconds"]);
      for (const e of ["story_arc_invalid", "narration_too_long", "plan_shot_rules"] as const) expect(d.errors[e]).toBeTruthy();
      expect(d).not.toHaveProperty("clipAudioNote");
    }
    const uz = JSON.stringify([aiChatUz.speechBlocked, aiChatUz.errors.story_arc_invalid, aiChatUz.errors.narration_too_long, aiChatUz.errors.plan_shot_rules,
                               aiChatUz.inferredChip, aiChatUz.changeQuestion, aiChatUz.voiceOverNote, aiChatUz.wordlessNote]);
    expect(uz).not.toMatch(/[oOgG]'/);
    expect(uz).toMatch(/ʻ/);
  });

  it("the speech refusals name the reason, not a remedy that does not exist", () => {
    expect(aiChatEn.speechBlocked.voice_unavailable).toMatch(/voice model that isn't available/);
    expect(aiChatEn.speechBlocked.clip_sound_not_kept).toMatch(/Clip sound is not yet kept in the final film/);
  });
});

describe("Lens M3: look sheets that could never fit a shot's prompt are refused before any turn", () => {
  it("fits with ordinary looks; three huge looks in one shot are over the limit, with the numbers to say so", () => {
    expect(looksOverLimit(outline60(), "multfilm", 2000)).toBeNull();
    const huge = { face: "f".repeat(160), hair: "h".repeat(160), build: "b".repeat(160), outfit: "o".repeat(160), palette: "p".repeat(160), signature: "s".repeat(160) };
    const o = story([15, 15, 15, 15], { characters: [1, 2, 3].map((i) => ({ id: `c${i}`, name: `N${i}`, description: "d", image_prompt: "i", look: huge })),
                                       hook: "h" });
    const over = looksOverLimit(o, "multfilm", 2000);
    expect(over).toMatchObject({ limit: 2000, in_frame: 3 });
    expect(over!.length).toBeGreaterThan(2000);
  });

  it("the new refusals and the planned-wordless line exist in all three languages", () => {
    for (const d of [aiChatEn, aiChatRu, aiChatUz]) {
      expect(d.plannedWordless).toBeTruthy();
      for (const e of ["speech_not_available", "looks_too_long"] as const) expect(d.errors[e]).toBeTruthy();
      expect(d.errors.story_arc_invalid).toContain("{messages}");
      for (const t of Object.values(d.speechBlocked)) expect(t).not.toMatch(/charged|списано|yechilmadi/);
    }
    // Pixel m1/m4: languages and shapes named in each UI language; Uzbek with its own ʻ, never the ASCII apostrophe.
    for (const d of [aiChatEn, aiChatRu, aiChatUz]) {
      expect(Object.keys(d.languageNames).sort()).toEqual(["English", "Russian", "Uzbek"]);
      expect(Object.keys(d.aspectNames).sort()).toEqual(["16:9", "1:1", "9:16"]);
    }
    expect(aiChatUz.languageNames.Uzbek).toBe("Oʻzbekcha");
    expect(aiChatRu.languageNames.Russian).toBe("Русский");
    expect(JSON.stringify([aiChatUz.languageNames, aiChatUz.aspectNames, aiChatUz.wordlessAsk, aiChatUz.blockedSaved, aiChatUz.seeStoryboard])).not.toMatch(/'/);
    expect(aiChatRu.blockedSaved).toContain("Цена не рассчитана");
    expect(JSON.stringify(aiChatRu.errors)).not.toContain("Ничего не оценено");
    expect(aiChatRu.errors.plan_shot_rules.match(/кадр/g) ?? []).toHaveLength(1);
    expect(aiChatEn.errors.story_arc_invalid).not.toMatch(/setup|longing|payoff|hook/);
    expect(aiChatEn.plannedWordless).toBe("This story is planned without spoken lines: voices and in-clip sound aren't available for films yet.");
  });
});

// The type is the BRIEF contract: the new fields are optional, so a BRIEF stored before them is still one.
const legacy: Brief = { version: 1, session_id: "s", status: "ready", kind: "short", language: "English", audience: null, style: null, aspect: "16:9",
                        target_seconds: 60, voice: { mode: "clip_audio" }, music: { mode: "off" }, handoff: null };
void legacy;
