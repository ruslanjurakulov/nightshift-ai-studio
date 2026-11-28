import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as after from "@/lib/brain/logic";
import { mergePlan, planLimits, planWindows, readWindow, refsOf, shotRules } from "@/lib/brain/plan";

/**
 * docs/studio/story-grammar-before-after.md, generated, never hand-written: one Uzbek sentence, the FAKE model output each branch's
 * prompt asks for, run through each branch's REAL readers and prompt folders. No vendor is called.
 *
 *   regenerate:  STORY_DOC_MAIN=<a checkout of main>/command-center/lib/brain/logic.ts npx vitest run tests/story-before-after.test.ts
 *   otherwise:   this test checks that the committed doc's "after" half is what this branch's code makes of the same output.
 *
 * "Before" is main's lib/brain/logic.ts (readScenario, buildBrief, filmFromBrief, scenePrompt): main writes a storyboard in its own
 * plan step from the same reader, so its scenes are read here as a stored storyboard that adds up to the length.
 */

const SENTENCE = "Uzoq shaharda ishlaydigan ota va ulgʻayib borayotgan qizi haqida taʼsirli 30 soniyalik multfilm";
const DOC = join(__dirname, "..", "..", "docs", "studio", "story-grammar-before-after.md");

/** What main's prompt asks for: chapters with free beats, a free description per character, scenes in the film's language. */
const BEFORE = {
  slots: { kind: "short", target_seconds: 30, aspect: "9:16", style: "multfilm", language: "Uzbek", audience: "oilalar" },
  scenario: {
    title: "Uzoqdagi dada", idea: "Ota uzoq shaharda ishlaydi, qizi uni kutib ulgʻayadi.", story: { logline: "Ota va qiz masofa orqali", conflict: "Masofa" },
    chapters: [{ id: "ch1", title: "Xayrlashuv", seconds: 15, beats: [{ at_s: 0, text: "Ota avtobusga chiqadi" }] },
               { id: "ch2", title: "Qaytish", seconds: 15, beats: [{ at_s: 0, text: "Ota qaytadi, qiz katta boʻlgan" }] }],
    characters: [{ id: "c1", name: "Dada", description: "moʻylovli, koʻk kurtkali ota", image_prompt: "ota" },
                 { id: "c2", name: "Malika", description: "ikki ortiq sochli qiz", image_prompt: "qiz" }],
    locations: [{ id: "l1", name: "Bekat", description: "qishloq avtobus bekati", image_prompt: "bekat" }], props: [],
    scenes: [
      { title: "Xayr", duration_s: 8, visual_prompt: "Ota bekatda qiziga qoʻl silkitadi", character_ids: ["c1", "c2"], location_id: "l1",
        dialogue: [{ character_id: "c1", line: "Tez qaytaman, qizim!" }] },
      { title: "Kutish", duration_s: 7, visual_prompt: "Qiz deraza oldida kutadi", character_ids: ["c2"], location_id: "l1", dialogue: [] },
      { title: "Yillar", duration_s: 7, visual_prompt: "Qiz maktabga boradi, katta boʻlgan", character_ids: ["c2"], location_id: "l1", dialogue: [] },
      { title: "Uchrashuv", duration_s: 8, visual_prompt: "Ota qaytadi, ular quchoqlashadi", character_ids: ["c1", "c2"], location_id: "l1",
        dialogue: [{ character_id: "c2", line: "Dada!" }] },
    ],
  },
};

const LOOK_DAD = { face: "warm oval face, thick black moustache, tired kind eyes", hair: "short black hair, greying at the temples", build: "tall, broad shoulders",
                   outfit: "navy work jacket, grey trousers, brown boots", palette: "navy, grey, warm brown", signature: "a red thermos on his shoulder strap" };
const look = (o: Partial<typeof LOOK_DAD>) => ({ ...LOOK_DAD, ...o });
const LOOK_GIRL = look({ face: "round face, big dark eyes", hair: "two long black braids with yellow ribbons", build: "small", outfit: "yellow coat, red boots",
                         palette: "yellow, red, black", signature: "a yellow paper star pinned to her coat" });

/** What this branch's prompt asks for: a format, an arc, looks in English, and a storyboard of ~3 s shots in English. */
const AFTER = {
  answer: {
    reply: "Mana ikki ssenariy.",
    slots: { kind: "short", target_seconds: 30, style: "multfilm" },
    inferred: { aspect: "9:16", language: "Uzbek", audience: "oilalar" },
    scenarios: [0, 1].map((k) => ({
      title: k ? "Qogʻoz yulduz" : "Uzoqdagi dada", idea: "Ota uzoq shaharda ishlaydi, qizi uni kutib ulgʻayadi.", story: { logline: "Ota va qiz masofa orqali", conflict: "Masofa" },
      format: "F3", visual_style: "warm hand-drawn 2D cartoon, soft paper texture", hook: "Avtobus eshigi ota bilan qiz orasida yopiladi.",
      planted_object: { text: "qogʻoz yulduz", prop_id: "p1", planted_chapter: "ch1", payoff_chapter: "ch4" }, twist: "time_skip",
      closing_card: "Uzoqdagi barcha otalarga", cover_title: "Uzoqdagi dada", speech_intent: "voice_over",
      chapters: [
        { id: "ch1", title: "Xayrlashuv", seconds: 6, beat: "setup", emotion: "qaygʻu", music_cue: "a single soft dutar", beats: [{ at_s: 0, text: "Avtobus eshigi yopiladi" }] },
        { id: "ch2", title: "Sogʻinch", seconds: 8, beat: "longing", emotion: "sogʻinch", music_cue: "the dutar, slower", beats: [{ at_s: 0, text: "Qiz har kech derazada" }] },
        { id: "ch3", title: "Yillar", seconds: 8, beat: "turn", emotion: "kutish", music_cue: "strings rise", beats: [{ at_s: 0, text: "Oʻn yil oʻtadi" }] },
        { id: "ch4", title: "Uchrashuv", seconds: 8, beat: "payoff", emotion: "quvonch", music_cue: "full theme", beats: [{ at_s: 0, text: "Ota yulduzni koʻradi" }] },
      ],
      characters: [
        { id: "c1", name: "Dada", description: "moʻylovli ota", image_prompt: "a father in a navy work jacket", look: LOOK_DAD },
        { id: "c2", name: "Malika", description: "qizi", image_prompt: "a girl with two braids", look: LOOK_GIRL,
          age_stages: [{ id: "a1", label: "6 yosh", look: LOOK_GIRL }, { id: "a2", label: "16 yosh", look: look({ ...LOOK_GIRL, build: "slim teenager", hair: "one long black braid with a yellow ribbon", outfit: "school uniform, yellow scarf" }) }] },
      ],
      locations: [{ id: "l1", name: "Bekat", description: "qishloq avtobus bekati", image_prompt: "a village bus stop at dawn, poplar trees, dusty road" }],
      props: [{ id: "p1", name: "Qogʻoz yulduz", description: "sariq qogʻoz yulduz" }],
    })),
  },
  /** The plan answer for the first window (the whole 30 s film is one window). */
  plan: (shot: (i: number) => Record<string, unknown>) => ({ chapters: [
    { id: "ch1", scenes: [shot(0), shot(1)] },
    { id: "ch2", scenes: [shot(2), shot(3)] },
    { id: "ch3", scenes: [shot(4), shot(5)] },
    { id: "ch4", scenes: [shot(6), shot(7)] },
  ] }),
};
const SHOTS = [
  { duration_s: 3, shot: "wide", camera: { position: "bus stop, eye level", move: "static" }, hook: true, title: "Eshik yopiladi",
    first_frame: "Wide shot of a village bus stop at dawn; a bus on the right, its door open; a man in a navy jacket on the step facing left; a small girl in a yellow coat on the left facing right",
    visual_prompt: "The bus door closes between the father and his daughter", motion: "Static camera. The door slides shut; the girl in the yellow coat steps forward",
    last_frame: "The bus door is shut; the girl stands alone on the left, facing the bus", in_frame: [{ character_id: "c1", age_stage: null }, { character_id: "c2", age_stage: "a1" }], location_id: "l1",
    speech: "none", speech_intent: "voice_over", lighting: "cold blue dawn, warm bus window light", variation: "small", sfx: "bus door hiss" },
  { duration_s: 3, shot: "close", camera: { position: "bus stop, eye level", move: "push_in" }, title: "Yulduz",
    first_frame: "Close-up of the girl's hands holding a yellow paper star", visual_prompt: "She lifts the paper star toward the bus window",
    motion: "Slow push in; the small hands in the yellow sleeves lift the star", last_frame: "The star is held up against the frame's center",
    in_frame: [{ character_id: "c2", age_stage: "a1" }], speech: "none", lighting: "cold blue dawn", variation: "small", sfx: "engine fading" },
  { duration_s: 4, shot: "wide", camera: { position: "bedroom, window", move: "static" }, title: "Deraza",
    first_frame: "Wide shot of a small bedroom at night; a window on the right; the girl on a stool on the left, facing the window",
    visual_prompt: "The girl waits at the window", motion: "Static camera. The girl in the yellow coat leans her chin on her hands",
    last_frame: "The girl leans on the windowsill", in_frame: [{ character_id: "c2", age_stage: "a1" }], speech: "none", speech_intent: "voice_over",
    lighting: "moonlight from the window", variation: "small", sfx: "crickets" },
  { duration_s: 4, shot: "insert", camera: { position: "bedroom, window", move: "static" }, title: "Kalendar",
    first_frame: "Insert of a wall calendar with crossed-out days", visual_prompt: "A pencil crosses out one more day",
    motion: "Static camera. A small hand crosses out a square", last_frame: "One more square crossed out", in_frame: [], speech: "none",
    lighting: "warm lamp", variation: "small", sfx: "pencil scratch", text_layers: [{ text: "Yana bir kun", position: "top" }] },
  { duration_s: 4, shot: "wide", camera: { position: "school gate", move: "pan" }, title: "Oʻn yil", first_frame: "Wide shot of a school gate in autumn",
    visual_prompt: "The grown girl walks out of the school gate", motion: "Pan right; the teenage girl with one braid walks out", last_frame: "The girl at the gate",
    in_frame: [{ character_id: "c2", age_stage: "a2" }], speech: "none", lighting: "golden autumn afternoon", variation: "medium", sfx: "school bell",
    text_layers: [{ text: "Oʻn yil oʻtib", position: "bottom" }] },
  { duration_s: 4, shot: "medium", camera: { position: "school gate", move: "static" }, title: "Telefon", first_frame: "Medium shot of the girl holding a phone",
    visual_prompt: "She reads a message and smiles", motion: "Static camera. The girl with one braid lifts her eyes", last_frame: "The girl smiles",
    in_frame: [{ character_id: "c2", age_stage: "a2" }], speech: "none", speech_intent: "voice_over", lighting: "golden autumn afternoon", variation: "small", sfx: "phone chime" },
  { duration_s: 4, shot: "wide", camera: { position: "bus stop, eye level", move: "static" }, title: "Bekat", first_frame: "Wide shot of the same bus stop at dusk; a bus on the right",
    visual_prompt: "The father steps down from the bus", motion: "Static camera. The man in the navy jacket steps down, grey at the temples", last_frame: "The father on the road",
    in_frame: [{ character_id: "c1", age_stage: null }], speech: "none", lighting: "warm dusk", variation: "small", sfx: "bus brakes" },
  { duration_s: 4, shot: "two_shot", camera: { position: "bus stop, eye level", move: "push_in" }, title: "Quchoq", first_frame: "Two-shot: father on the right, daughter on the left, facing each other",
    visual_prompt: "He sees the paper star pinned to her scarf; they embrace", motion: "Slow push in; the two embrace", last_frame: "Father and daughter embrace in the center",
    in_frame: [{ character_id: "c1", age_stage: null }, { character_id: "c2", age_stage: "a2" }], speech: "none", speech_intent: "voice_over",
    lighting: "warm dusk", variation: "small", sfx: "music swells" },
];

/** Short on purpose (the PR body quotes it): one line per top-level key, or per array item. */
function fence(o: unknown): string {
  const body = Array.isArray(o)
    ? `[\n${o.map((x) => `  ${JSON.stringify(x)}`).join(",\n")}\n]`
    : `{\n${Object.entries(o as Record<string, unknown>).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n")}\n}`;
  return "```json\n" + body + "\n```";
}

type Logic = typeof after;

/** main's half: the same sentence, main's readers on main-shaped output. */
function beforeHalf(main: Logic): string {
  const slots = main.readSlots(BEFORE.slots);
  const sc = main.readScenario(BEFORE.scenario, slots)!;
  const brief = main.buildBrief("doc", slots, sc, "ready");
  const film = main.filmFromBrief(brief)!;
  return [
    "## Before (main)",
    "",
    "Outline as main reads it (no arc, no looks, no format):",
    "",
    fence({ chapters: sc.chapters.map((c) => ({ id: c.id, title: c.title, seconds: c.seconds })),
            characters: sc.characters.map((c) => ({ id: c.id, name: c.name, description: c.description })), voice: brief.voice }),
    "",
    `Storyboard: ${film.scenes.length} scenes for 30 s (${film.scenes.map((s) => `${s.planned_seconds} s`).join(", ")}).`,
    "",
    "Scene 1's saved prompt (main makes the key frame AND the clip from it):",
    "",
    "```text\n" + String(film.scenes[0].visual_prompt) + "\n```",
    "",
    `clip_params: ${JSON.stringify(film.scenes[0].clip_params ?? null)}, narration: ${JSON.stringify(film.scenes[0].narration)}`,
  ].join("\n");
}

/** This branch's half: the same sentence, this branch's readers on this branch's output. */
function afterHalf(): string {
  const a = after.readModelAnswer(JSON.stringify(AFTER.answer), {}, "q")!;
  const outline = a.scenarios[0];
  const limits = planLimits(null, null, outline.target_seconds);
  const windows = planWindows(outline, limits)!;
  const read = readWindow(JSON.stringify(AFTER.plan((i) => SHOTS[i])), windows[0], refsOf(outline), limits, "", undefined, [], shotRules(outline, "Uzbek"));
  if (!read.ok) throw new Error(`the fake plan answer does not read: ${JSON.stringify(read)}`);
  const merged = mergePlan(outline, windows, [read.parts]);
  if (!merged.ok) throw new Error("the fake plan does not merge");
  const brief = after.buildBrief("doc", a.slots, merged.scenario, "ready");
  const film = after.filmFromBrief(brief)!;
  const s1 = brief.scenes![0];
  const fold = { characters: brief.characters, locations: brief.locations, style: brief.style, visual_style: brief.visual_style };
  return [
    "## After (this branch)",
    "",
    `Slots from the one sentence: ${JSON.stringify({ ...a.slots })} (step: ${a.step}, card: ${a.card ? a.card.slot : "none"}).`,
    "",
    "Outline:",
    "",
    fence({ format: outline.format, speech_intent: outline.speech_intent, hook: outline.hook, planted_object: outline.planted_object, twist: outline.twist, closing_card: outline.closing_card,
            chapters: outline.chapters.map((c) => ({ id: c.id, title: c.title, seconds: c.seconds, beat: c.beat, emotion: c.emotion })),
            characters: outline.characters.map((c) => ({ id: c.id, name: c.name, look: c.look, age_stages: c.age_stages?.map((x) => x.label) })) }),
    "",
    `Storyboard: ${brief.scenes!.length} shots for 30 s (${brief.scenes!.map((s) => `${s.duration_s} s ${s.shot}`).join(", ")}), ${windows.length} plan call(s). The first four:`,
    "",
    fence(brief.scenes!.slice(0, 4).map((s) => ({ id: s.id, chapter: s.chapter_id, chain_from: s.chain_from, shot: s.shot, camera: s.camera, speech: s.speech,
                                                  speech_intent: s.speech_intent, in_frame: s.in_frame, text_layers: s.text_layers }))),
    "",
    `Voice: ${JSON.stringify(brief.voice)}: planned wordless, because only "none" can be made today (speech_allowed); each scene keeps its \`speech_intent\` (here voice_over) for when a film voice can be priced.`,
    "",
    "Scene 1's key-frame prompt:",
    "",
    "```text\n" + after.keyframePrompt(fold, s1) + "\n```",
    "",
    "Scene 1's clip prompt:",
    "",
    "```text\n" + after.clipPrompt(fold, s1) + "\n```",
    "",
    `Saved to film_scenes: narration ${JSON.stringify(film.scenes[0].narration)}, clip_params ${JSON.stringify(film.scenes[0].clip_params ?? null)}.`,
  ].join("\n");
}

const header = [
  "# Story grammar: before and after",
  "",
  "<!-- Generated by command-center/tests/story-before-after.test.ts. Do not edit by hand. -->",
  "",
  `One sentence: “${SENTENCE}”.`,
  "",
  "Both halves are FAKE model output (shaped by each branch's own prompt) run through each branch's REAL readers and prompt folders; no",
  "model was called.",
  "",
].join("\n");

describe("docs/studio/story-grammar-before-after.md", () => {
  it("is what the code makes of the same sentence (regenerated with STORY_DOC_MAIN)", async () => {
    const mainPath = process.env.STORY_DOC_MAIN;
    if (mainPath) {
      const main = (await import(/* @vite-ignore */ mainPath)) as Logic;
      writeFileSync(DOC, `${header}\n${beforeHalf(main)}\n\n${afterHalf()}\n`);
    }
    const doc = readFileSync(DOC, "utf8");
    expect(doc).toContain(afterHalf());
    expect(doc).toContain("## Before (main)");
    expect(SENTENCE).toContain("ʻ");
  });
});
