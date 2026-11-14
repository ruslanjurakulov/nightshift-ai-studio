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
import { explainerFrames, headlineParts, sceneFrames, sceneWords, statShown, wordsForLine } from "../src/explainer/text.ts";

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

test("the counter ends on exactly the value said, and only counts an unambiguous integer", () => {
  for (const v of ["$1,500", "1,000,000", "3,5", "10 000", "750", "$750", "40%", "4.3K"]) assert.equal(statShown(v, 1), v);
  assert.equal(statShown("750", 0), "0");
  assert.equal(statShown("$750", 0.5), "$656");
  for (const v of ["$1,500", "3,5", "10 000", "4.3K"]) assert.equal(statShown(v, 0.3), v);
});

// ── motion (src/explainer/motion.ts) ─────────────────────────────────────
//
// What would break without these: a mouth that moves in the narration's pauses (or a face that lip-syncs nothing); a
// blink that lands differently in two render chunks and makes a face twitch at the seam; an exit transition that eats
// into the next sentence or past the end of the narration; a hand-over cut off by the next scene.

import {
  BLINK_MAX_GAP_S,
  BLINK_MIN_GAP_S,
  WALK_S,
  accentLineAt,
  accentSpokenAt,
  blinkTimes,
  exitFrames,
  exitProgress,
  eyeOpenness,
  handover,
  hash01,
  mouthOpenness,
  pushIn,
  seedOf,
  speakerIndex,
} from "../src/explainer/motion.ts";
import { alpha, mix } from "../src/explainer/looks.ts";

test("the mouth is shut between words and moves only while a word is being said", () => {
  const words = [w("salom", 1.0, 1.5), w("dunyo", 2.0, 2.6)];
  for (const t of [0, 0.99, 1.5, 1.75, 1.99, 2.6, 5]) assert.equal(mouthOpenness(words, t), 0, `t=${t}`);
  const inside = [1.05, 1.2, 1.3, 2.1, 2.3, 2.5].map((t) => mouthOpenness(words, t));
  for (const v of inside) assert.ok(v >= 0 && v <= 1);
  assert.ok(Math.max(...inside) > 0.5, "the jaw opens properly somewhere inside a word");
  // It eases at a word's edges instead of snapping open on the first frame.
  assert.ok(mouthOpenness(words, 1.001) < 0.1);
  assert.ok(mouthOpenness(words, 1.499) < 0.1);
});

test("blinks are deterministic, 2-5 s apart, and the eyes are open almost all the time", () => {
  for (const seed of [1, 42, seedOf("e003"), 4294967295]) {
    const times = blinkTimes(seed, 60);
    assert.deepEqual(times, blinkTimes(seed, 60));
    assert.ok(times[0] >= 0.5 && times[0] <= 2.0, `first blink ${times[0]}`);
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      assert.ok(gap >= BLINK_MIN_GAP_S && gap <= BLINK_MAX_GAP_S, `gap ${gap}`);
    }
    let open = 0;
    for (let f = 0; f < 1800; f++) open += eyeOpenness(seed, f / 30) === 1 ? 1 : 0;
    assert.ok(open / 1800 > 0.9);
  }
  // Two people in one scene do not blink in step.
  assert.notDeepEqual(blinkTimes(seedOf("e001"), 20), blinkTimes(seedOf("e001") + 977, 20));
  assert.equal(eyeOpenness(7, 3.21), eyeOpenness(7, 3.21));
});

test("the hash is a pure function into [0, 1)", () => {
  for (let i = 0; i < 1000; i++) {
    const v = hash01(i, 3);
    assert.ok(v >= 0 && v < 1);
    assert.equal(v, hash01(i, 3));
  }
  assert.notEqual(hash01(1, 2), hash01(2, 1));
});

test("the starred word pops when it is said; never said, it has no time", () => {
  const words = [w("Mana", 0.5, 0.8), w("shunday,", 0.9, 1.4), w("o‘zi", 2, 2.2), w("chizadi.", 2.3, 2.9)];
  assert.equal(accentSpokenAt("SHUNDAY", words), 0.9);
  assert.equal(accentSpokenAt("o'zi", words), 2);
  assert.equal(accentSpokenAt("chiz", words), 2.3, "a stem of four letters matches a word with an ending");
  assert.equal(accentSpokenAt("$", words), null);
  assert.equal(accentSpokenAt("ma", [w("mana", 0, 1)]), null, "a short stem must match exactly");
  assert.equal(accentSpokenAt("", words), null);
});

test("the accent line arrives as it is said, and always early enough to be read", () => {
  const words = [w("vaqt", 10.5, 10.9), w("ketadi.", 11.0, 11.6)];
  assert.ok(Math.abs(accentLineAt("vaqt ketadi.", words, 9, 4) - 1.4) < 1e-9);
  assert.equal(accentLineAt("boshqa gap", words, 9, 4), 0.6);
  assert.equal(accentLineAt("ketadi", words, 0, 3), 2.0, "said too late: clamped to a second before the scene ends");
  assert.equal(accentLineAt("x", [], 0, 1.2), 0.3);
});

test("an exit happens inside the scene's own frames and never lengthens it", () => {
  for (const d of [3, 10, 48, 90, 200]) {
    const n = exitFrames(d, 30);
    assert.ok(n <= Math.floor(d / 3) && n <= 9);
    assert.equal(exitProgress(0, d, 30, false), 0);
    if (n > 0) {
      assert.equal(exitProgress(d - 1 - n, d, 30, false), 0);
      assert.equal(exitProgress(d - 1, d, 30, false), 1, "fully gone on the scene's own last frame");
    }
    // The last scene holds: the video ends on a full frame, not a blur.
    for (let f = 0; f < d; f++) assert.equal(exitProgress(f, d, 30, true), 0);
  }
});

test("the camera pushes in from 1.00 to 1.06, starting gently", () => {
  assert.equal(pushIn(0, 100), 1);
  assert.ok(Math.abs(pushIn(100, 100) - 1.06) < 1e-9);
  assert.ok(pushIn(5, 100) - 1 < 0.001, "eased: almost still on the first frames");
});

test("a hand-over waits for a walk-in and lands at least half a second before the scene ends", () => {
  for (const seconds of [1.6, 2.5, 3.4, 4.3, 8]) {
    for (const walks of [false, true]) {
      const h = handover(seconds, walks);
      assert.ok(h.reach < h.travel && h.travel < h.land);
      assert.ok(h.land <= seconds - 0.5 + 1e-9, `${seconds}s walks=${walks}: lands at ${h.land}`);
    }
  }
  assert.ok(handover(6, true).reach >= WALK_S, "nobody hands over a phone mid-stride");
});

test("one mouth follows the narration: the person acting it out, else the first", () => {
  assert.equal(speakerIndex(["sit", "wave"]), 1);
  assert.equal(speakerIndex(["point", "cheer"]), 0);
  assert.equal(speakerIndex(["sad", "think", "stand"]), 2);
  assert.equal(speakerIndex(["walk", "sit"]), 0);
  assert.equal(speakerIndex([]), -1);
});

test("look colours mix exactly and refuse a colour they cannot read", () => {
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mix("#ff0000", "#0000ff", 0), "#ff0000");
  assert.equal(alpha("#35d07f", 0.5), "rgba(53,208,127,0.5)");
  assert.throws(() => mix("red", "#000000", 0.5), /rrggbb/);
});
