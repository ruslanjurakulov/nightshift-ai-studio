// The VoiceExplainer's pure helpers (src/explainer/text.ts, looks.ts).
//
// What would break without these: a caption line that runs across the cut into the next
// sentence; a scene window that drifts from the narration clock; an unknown look drawn as
// the default instead of refused (CLAUDE.md rule 4); a *marked* headline word lost.
//
// Run (Node 22, no install needed):
//   node --experimental-strip-types --no-warnings --test tests/explainer.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";
import { LOOK_IDS, lookFor } from "../src/explainer/looks.ts";
import { explainerFrames, headlineParts, sceneFrames, sceneWords, wordsForLine } from "../src/explainer/text.ts";

const w = (text: string, s: number, e: number) => ({ text, start_s: s, end_s: e });
const scene = (id: string, s: number, e: number) => ({ id, start_s: s, end_s: e, kicker: "", headline: "x", accent: "", visual: { kind: "none" as const } });

test("a starred word is the accent, the rest plain; an unclosed star stays text", () => {
  assert.deepEqual(headlineParts("MUTLAQO *TEKIN*"), [{ text: "MUTLAQO ", accent: false }, { text: "TEKIN", accent: true }]);
  assert.deepEqual(headlineParts("$$ *$*"), [{ text: "$$ ", accent: false }, { text: "$", accent: true }]);
  assert.deepEqual(headlineParts("5 *USLUB"), [{ text: "5 *USLUB", accent: false }]);
});

test("a caption line is a fixed chunk that holds the latest started word, and clears after a silence", () => {
  const words = [w("a", 0, 0.4), w("b", 0.5, 0.9), w("c", 1.0, 1.4), w("d", 1.5, 1.9)];
  assert.deepEqual(wordsForLine(words, 0.2, 2).map((x) => x.text), ["a", "b"]);
  assert.deepEqual(wordsForLine(words, 1.2, 2).map((x) => x.text), ["c", "d"]);
  assert.deepEqual(wordsForLine(words, -1, 2), []);
  assert.deepEqual(wordsForLine(words, 5, 2), []);
});

test("a scene shows only its own words: a word belongs to the scene its middle falls in", () => {
  const words = [w("end.", 2.8, 3.4), w("Next", 3.5, 3.9)];
  assert.deepEqual(sceneWords(words, scene("e0", 0, 3.45)).map((x) => x.text), ["end."]);
  assert.deepEqual(sceneWords(words, scene("e1", 3.45, 6)).map((x) => x.text), ["Next"]);
});

test("scene frames follow the narration clock and refuse times that cannot be drawn", () => {
  assert.deepEqual(sceneFrames(scene("e0", 1.0, 2.5), 30), { from: 30, duration: 45 });
  assert.throws(() => sceneFrames(scene("e0", 2, 2), 30), /bad times/);
  assert.throws(() => sceneFrames(scene("e0", -1, 2), 30), /bad times/);
});

test("the video is as long as the narration; a scene past its end is refused", () => {
  const base = { width: 1080, height: 1920, fps: 30, look: "dusk" as const, narration: "", music: "", music_volume: 0, sfx: [], words: [], captions: true };
  assert.equal(explainerFrames({ ...base, duration_s: 10, scenes: [scene("e0", 0, 10)] }), 300);
  assert.throws(() => explainerFrames({ ...base, duration_s: 10, scenes: [scene("e0", 0, 12)] }), /ends after the narration/);
  assert.throws(() => explainerFrames({ ...base, duration_s: 10, scenes: [] }), /no scenes/);
});

test("an unknown look is refused, never drawn as the default", () => {
  assert.deepEqual(LOOK_IDS.sort(), ["dusk", "golden", "midnight", "neon", "paper"]);
  for (const id of LOOK_IDS) assert.equal(lookFor(id).id, id);
  assert.throws(() => lookFor("sepia"), /unknown look/);
  assert.throws(() => lookFor("__proto__"), /unknown look/);
});
