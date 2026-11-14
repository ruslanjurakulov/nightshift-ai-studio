import type { Pose, Word } from "./types";

/**
 * The explainer's motion, as pure functions of time.
 *
 * Every render of the same props must give the same pixels: the video is rendered in chunks by separate processes
 * (modules/voice_explainer.render), and a blink or a dust mote that depended on Math.random or the clock would jump
 * at every chunk seam. So nothing here reads anything but its arguments, and "random" is an integer hash.
 */

/** A 32-bit integer hash of (a, b) -> [0, 1). Same inputs, same output, on every machine. */
export const hash01 = (a: number, b = 0): number => {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
};

/** A stable integer seed from a string (a scene id), so two scenes do not blink in step. */
export const seedOf = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeOutCubic = (x: number): number => 1 - Math.pow(1 - clamp01(x), 3);
export const easeInOutCubic = (x: number): number => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
/** Overshoots a little past 1 before settling: a "pop" without a spring's long tail. */
export const easeOutBack = (x: number): number => {
  const t = clamp01(x);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** 0 -> 1 over [start, start + length] frames, eased. */
export const ramp = (frame: number, start: number, length: number, ease: (x: number) => number = easeOutCubic): number =>
  ease(length <= 0 ? (frame >= start ? 1 : 0) : (frame - start) / length);

export const BLINK_S = 0.16;
export const BLINK_MIN_GAP_S = 2;
export const BLINK_MAX_GAP_S = 5;

/** The moments (seconds from the scene's start) a face with this seed starts a blink, up to `until`. */
export const blinkTimes = (seed: number, until: number): number[] => {
  const out: number[] = [];
  // The first blink comes early enough to be seen in a 3 s scene, but never on the very first frames.
  let t = 0.5 + hash01(seed, 0) * 1.5;
  for (let k = 1; t <= until && k < 10000; k++) {
    out.push(t);
    t += BLINK_MIN_GAP_S + hash01(seed, k) * (BLINK_MAX_GAP_S - BLINK_MIN_GAP_S);
  }
  return out;
};

/** How open the eyes are at `t` seconds (1 open, ~0 shut): a quick close-and-open at each blink time. */
export const eyeOpenness = (seed: number, t: number): number => {
  if (t < 0) return 1;
  for (const b of blinkTimes(seed, t)) {
    const p = (t - b) / BLINK_S;
    if (p >= 0 && p < 1) return 0.08 + 0.92 * Math.abs(1 - 2 * p);
  }
  return 1;
};

/** A syllable is about a sixth of a second in conversational speech; the jaw opens and closes about that often. */
const SYLLABLE_S = 0.17;

/**
 * How open a talking mouth is at `t` (absolute seconds on the narration clock): 0 between words, and inside a word a
 * jaw that opens and closes at a syllable's pace, eased in and out at the word's edges so it never snaps. Driven by
 * the recording's own word timings, so the mouth moves exactly while the narration speaks and is still in its pauses.
 */
export const mouthOpenness = (words: Word[], t: number): number => {
  for (const w of words) {
    if (t < w.start_s) break;
    if (t >= w.end_s) continue;
    const len = Math.max(0.01, w.end_s - w.start_s);
    const p = t - w.start_s;
    // Whole syllables per word, at least one, so the last one closes as the word ends.
    const syllables = Math.max(1, Math.round(len / SYLLABLE_S));
    const jaw = Math.abs(Math.sin((Math.PI * p * syllables) / len));
    const edge = Math.min(1, p / 0.05, (w.end_s - t) / 0.05);
    return clamp01((0.25 + 0.75 * jaw) * edge);
  }
  return 0;
};

/** Lower-case letters and digits only, apostrophes unified: "Shunday," == "shunday", "o‘zi" == "o'zi". */
export const normWord = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, "")
    .replace(/^'+|'+$/g, "");

/**
 * When the headline's starred word is said in this scene (absolute seconds), or null when the narration never says
 * it (a "$" headline, a paraphrase): then it pops on its entrance instead. A spoken form that merely starts with the
 * marked word counts ("chizadi" for "chiz"), because Uzbek and Russian add endings; a two-letter stem would match
 * too much, so stems shorter than four letters must match exactly.
 */
export const accentSpokenAt = (accent: string, words: Word[]): number | null => {
  const target = normWord(accent.split(/\s+/)[0] ?? "");
  if (!target) return null;
  for (const w of words) {
    const n = normWord(w.text);
    if (!n) continue;
    if (n === target || (target.length >= 4 && n.startsWith(target))) return w.start_s;
  }
  return null;
};

/** Frames a scene uses to leave: never more than a third of a short scene, so a 1.6 s scene still reads. */
export const exitFrames = (durationFrames: number, fps: number): number =>
  Math.max(0, Math.min(Math.round(fps * 0.3), Math.floor(durationFrames / 3)));

/**
 * 0 while the scene is fully on screen, rising to 1 on its last frame. The exit happens INSIDE the scene's own window:
 * a transition never lengthens a scene, so the picture can never run past the narration or behind the next sentence.
 * The last scene does not leave: the video ends on a full frame.
 */
export const exitProgress = (frame: number, durationFrames: number, fps: number, isLast: boolean): number => {
  if (isLast) return 0;
  const n = exitFrames(durationFrames, fps);
  if (n <= 0) return 0;
  return easeInOutCubic((frame - (durationFrames - 1 - n)) / n);
};

/** The camera's slow push-in over a scene: 1.00 -> 1.06, eased at the start so a cut does not lurch. */
export const pushIn = (frame: number, durationFrames: number): number =>
  1 + 0.06 * easeInOutCubic(frame / Math.max(1, durationFrames));

/**
 * Which person's mouth follows the narration. One at most: two faces lip-syncing one voice reads as a glitch. The one
 * acting it out (pointing, waving, cheering) speaks before one standing, sitting, thinking or sad; ties go to the
 * first. -1 for an empty cast.
 */
const TALK_ORDER: Pose[] = ["point", "wave", "cheer", "stand", "walk", "sit", "think", "sad"];
export const speakerIndex = (poses: Pose[]): number => {
  let best = -1;
  for (let i = 0; i < poses.length; i++) {
    const r = TALK_ORDER.indexOf(poses[i]);
    if (best < 0 || (r >= 0 && r < TALK_ORDER.indexOf(poses[best]))) best = i;
  }
  return best;
};

/**
 * When the italic accent line arrives (seconds from the scene's start): as its first word is said when the narration
 * says it here, else a beat after the headline. Never so late that it cannot be read before the scene leaves.
 */
export const accentLineAt = (accentLine: string, words: Word[], sceneStart: number, seconds: number): number => {
  const said = accentSpokenAt(accentLine, words);
  const at = said === null ? 0.6 : said - sceneStart - 0.1;
  return Math.max(0.3, Math.min(at, seconds - 1.0));
};

/** How long a walk-in takes (pose `walk`): from the nearer edge of the frame to the person's place. */
export const WALK_S = 1.7;

/**
 * The hand-over of a hand-held prop between the first two people (seconds from the scene's start): the giver reaches,
 * the prop travels, it lands. It waits for a walk-in to finish, and it always lands at least half a second before the
 * scene ends, so the receiver's reaction is seen and not cut off by the next sentence.
 */
export const handover = (seconds: number, someoneWalks: boolean): { reach: number; travel: number; land: number } => {
  const wanted = someoneWalks ? WALK_S + 0.2 : 0.7;
  const reach = Math.max(0.1, Math.min(wanted, seconds - 1.4));
  return { reach, travel: reach + 0.35, land: reach + 0.85 };
};
