/**
 * Turn a video's stored narration into a storyboard — the scene-by-scene plan
 * of what the video actually says, in order.
 *
 * The pipeline writes each video's `script_text` as its full narration with one
 * paragraph per section (main.py stores `Script.full_narration()`, which joins
 * every section's clean narration with a blank line). So the blank-line breaks
 * ARE the scene boundaries the writer chose — splitting on them recovers the
 * storyboard without persisting anything new.
 *
 * Pure and deterministic (no network, no DB), so it is unit-tested directly and
 * runs the same on the server as it renders the page and in the browser.
 */

export interface StoryboardScene {
  /** 1-based scene number, in narration order. */
  index: number;
  /** The scene's narration, trimmed. */
  text: string;
  /** A short heading — the scene's first sentence, capped — for scanning. */
  beat: string;
  /** Word count of the narration. */
  words: number;
  /** Estimated on-screen seconds at a typical narration pace. */
  estSeconds: number;
  /** Cumulative seconds at the END of this scene (its point on the timeline). */
  cumulativeSeconds: number;
}

export interface Storyboard {
  scenes: StoryboardScene[];
  totalWords: number;
  totalSeconds: number;
}

/** Words per second of spoken narration. ~150 wpm is a normal documentary pace,
 * so 2.5 w/s — used only to estimate a scene's on-screen length for the timeline;
 * the real cut timing lives in the render, this is a reading aid. */
const WORDS_PER_SECOND = 2.5;

function countWords(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

/** The first sentence of a scene, capped, as a scannable heading. Falls back to
 * a hard character cap when the scene has no sentence break. */
function firstSentence(text: string, cap = 90): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  const stop = trimmed.search(/[.!?](\s|$)/);
  const sentence = stop >= 0 ? trimmed.slice(0, stop + 1) : trimmed;
  return sentence.length > cap ? sentence.slice(0, cap - 1).trimEnd() + "…" : sentence;
}

/**
 * Parse `script_text` into an ordered storyboard. Blank lines separate scenes;
 * empty fragments are dropped, so trailing whitespace or doubled breaks never
 * produce a phantom scene. Returns an empty storyboard for null/blank input, so
 * the caller can simply check `scenes.length`.
 */
export function parseStoryboard(scriptText: string | null | undefined): Storyboard {
  const raw = (scriptText ?? "").trim();
  if (!raw) return { scenes: [], totalWords: 0, totalSeconds: 0 };

  const parts = raw
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const scenes: StoryboardScene[] = [];
  let cumulative = 0;
  let totalWords = 0;
  parts.forEach((text, i) => {
    const words = countWords(text);
    const estSeconds = Math.max(1, Math.round(words / WORDS_PER_SECOND));
    cumulative += estSeconds;
    totalWords += words;
    scenes.push({
      index: i + 1,
      text,
      beat: firstSentence(text),
      words,
      estSeconds,
      cumulativeSeconds: cumulative,
    });
  });

  return { scenes, totalWords, totalSeconds: cumulative };
}

/** m:ss for a duration in seconds (e.g. 95 → "1:35"). */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}
