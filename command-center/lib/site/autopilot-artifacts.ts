/**
 * The files the landing's autopilot walk-through (components/site/AutopilotDemo.tsx) shows, copied out of the repository: the
 * sample script the render benchmark runs on (samples/demo_script.json, tools/render_benchmark.py) and the video engine's scene
 * fixtures (video-engine/fixtures/*.json, the props its smoke renders are made from). They live outside this app's folder, so
 * the bundle cannot import them; tests/autopilot-demo.test.tsx reads both from disk and fails if one word here differs from the
 * file, so nothing on that section can drift into an invented example.
 *
 * Only what each stage has a file for is here. There is no recording, no rendered video and no upload in the repository: those
 * stages show a mock of the app's screen, and the section says so on it.
 */

export const SCRIPT_FILE = "samples/demo_script.json";

/** samples/demo_script.json: what the topic, script, voice and visual stages show. */
export const DEMO_SCRIPT = {
  topic: "The Flannan Isles Lighthouse Mystery",
  title: "3 Men Vanished From This Lighthouse — The Log Book Made It Worse",
  titleAb: "The Lighthouse Where 3 Keepers Vanished Without a Trace",
  hookSentence: "Three men vanished from a locked lighthouse — and the log book they left behind only made it stranger.",
  tags: ["flannan isles", "lighthouse mystery", "unsolved mysteries", "history documentary", "true story", "disappearance", "scotland history", "unexplained"],
  thumbnailPromptA: "Storm-lashed lighthouse at night, single beam cutting through rain, dark cinematic, high contrast",
  thumbnailPromptB: "Close-up of an open weathered log book on a wooden table, candlelight, ominous shadows",
  thumbnailOverlayText: "STILL LOCKED",
  /** Each section's name and its `duration_hint`: the length the script asks for, not a measured one. */
  sections: [
    { name: "hook", durationHint: 15 },
    { name: "open_loop_plant", durationHint: 25 },
    { name: "the_light_goes_dark", durationHint: 45 },
    { name: "the_relief_crew", durationHint: 45 },
    { name: "the_log_book", durationHint: 50 },
    { name: "the_theories", durationHint: 45 },
    { name: "resolution", durationHint: 50 },
  ],
  /** The first section's narration exactly as the narrator stage reads it, cues included. */
  hookNarration:
    "[MUSIC:intro_high] [SFX:dramatic_sting] Three men walked into this lighthouse. [PAUSE:1.0] Nobody ever walked out. [SFX:deep_boom] [PAUSE:1.2] The lamp was polished. The beds were made. [PAUSE:0.8] And one meal was still sitting on the table. [SFX:eerie_wind] [PAUSE:1.0] But it's what they wrote in the log book [PAUSE:0.6] that nobody has ever been able to explain.",
  /** The footage search words of three sections (`keywords`), by section name. */
  keywords: [
    { section: "hook", words: ["storm waves lighthouse", "dark ocean night", "abandoned room candlelight"] },
    { section: "the_log_book", words: ["handwritten journal closeup", "candle flame dark room", "lightning storm sea"] },
    { section: "resolution", words: ["giant wave crashing rocks", "empty coat hook wall", "sunrise over ocean calm"] },
  ],
} as const;

/** video-engine/fixtures/evidence-card.json `claims`: two claims as the fact-check marks them. */
export const CLAIMS_FILE = "video-engine/fixtures/evidence-card.json";
export const CLAIMS = [
  { id: "c007a", text: "The lighthouse was first lit in 1899.", status: "likely_accurate", requiresHumanReview: false },
  { id: "c007b", text: "The three keepers were never found.", status: "unverifiable", requiresHumanReview: true },
] as const;
export type ClaimStatus = (typeof CLAIMS)[number]["status"];

/** video-engine/fixtures/title-card.json `words`: the first words of the hook, timed for the captions (seconds). */
export const WORDS_FILE = "video-engine/fixtures/title-card.json";
export const TIMED_WORDS = [
  { text: "Three", start: 0.2, end: 0.5 },
  { text: "men", start: 0.5, end: 0.8 },
  { text: "walked", start: 0.8, end: 1.2 },
] as const;

/** One scene of each fixture in video-engine/fixtures: its id, shot recipe, transition and narration. */
export const SCENES_DIR = "video-engine/fixtures";
export const SCENES = [
  { file: "title-card.json", id: "s000", recipe: "title_card", transition: "dip_to_black", narration: "Three men walked into this lighthouse." },
  { file: "map-zoom.json", id: "s004", recipe: "map_zoom", transition: "hard_cut", narration: "Twenty miles off the coast, the islands sit alone in the Atlantic." },
  {
    file: "timeline.json",
    id: "s005",
    recipe: "timeline",
    transition: "hard_cut",
    narration: "The lighthouse was built in 1899, and the three keepers vanished in December 1900. By 1971 the light was automated.",
  },
  {
    file: "quote-card.json",
    id: "s006",
    recipe: "quote_card",
    transition: "hard_cut",
    narration: 'Moore wrote: "the lamp was not lit, the clock had stopped and the table was set" in his report.',
  },
  { file: "evidence-card.json", id: "s007", recipe: "evidence_card", transition: "hard_cut", narration: "The lighthouse was first lit in 1899. The three keepers were never found." },
  { file: "lower-third.json", id: "s008", recipe: "slow_push", transition: "hard_cut", narration: "The relief vessel arrived on the twenty-sixth." },
] as const;

/** The stages, in the pipeline's order (main.py); which of them shows a file and which a mock of the app's screen. */
export const AUTOPILOT_STAGES = ["topic", "research", "script", "voice", "visuals", "render", "upload", "approve", "publish"] as const;
export type AutopilotStage = (typeof AUTOPILOT_STAGES)[number];
export const STAGE_EVIDENCE: Record<AutopilotStage, "file" | "mock" | "rules"> = {
  topic: "file",
  research: "file",
  script: "file",
  voice: "file",
  visuals: "file",
  render: "file",
  upload: "mock",
  approve: "mock",
  publish: "rules",
};
