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
  /** The section's own name (structured scenes only), e.g. "Hook". */
  name?: string;
  /** The section type (structured scenes only): "hook" | "story". */
  sceneType?: string;
  /** The b-roll search keywords that drove this scene's footage (structured
   *  scenes only). */
  keywords?: string[];
  /** True when the scene's length is the pipeline's own duration, not an
   *  estimate from word count. */
  durationExact?: boolean;
}

export interface Storyboard {
  scenes: StoryboardScene[];
  totalWords: number;
  totalSeconds: number;
  /** Where the storyboard came from: the video's structured scene plan
   *  (migration 0011) when present, else the narration split on blank lines. */
  source: "structured" | "narration";
}

/** One structured scene as the pipeline persists it (migration 0011). Every
 *  field is optional — an older row or a partial record must never throw. */
export interface VideoScene {
  name?: string;
  type?: string;
  narration?: string;
  duration_hint?: number;
  keywords?: string[];
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
  if (!raw) return { scenes: [], totalWords: 0, totalSeconds: 0, source: "narration" };

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

  return { scenes, totalWords, totalSeconds: cumulative, source: "narration" };
}

/**
 * Build a storyboard from the video's STRUCTURED scene plan (migration 0011),
 * when the pipeline stored one. Richer than the narration split: each scene
 * carries its own name, type and b-roll keywords, and its length is the
 * pipeline's intended `duration_hint` rather than a word-count estimate (only
 * falling back to the estimate when a scene has no usable hint).
 *
 * Tolerant of partial data — a scene with no narration but a name still shows,
 * an absent duration is estimated, a non-array/empty input yields an empty
 * storyboard — so a malformed or half-written row never throws.
 */
export function scenesToStoryboard(scenes: VideoScene[] | null | undefined): Storyboard {
  const list = Array.isArray(scenes) ? scenes : [];
  const out: StoryboardScene[] = [];
  let cumulative = 0;
  let totalWords = 0;
  for (const s of list) {
    const text = (s?.narration ?? "").trim();
    const name = (s?.name ?? "").trim();
    if (!text && !name) continue; // nothing to show for this entry
    const words = countWords(text);
    const hint = typeof s?.duration_hint === "number" ? Math.round(s.duration_hint) : 0;
    const durationExact = hint > 0;
    const estSeconds = durationExact ? hint : Math.max(1, Math.round(words / WORDS_PER_SECOND));
    cumulative += estSeconds;
    totalWords += words;
    const keywords = Array.isArray(s?.keywords)
      ? s!.keywords!.map((k) => String(k).trim()).filter(Boolean)
      : [];
    out.push({
      index: out.length + 1,
      text,
      beat: name || firstSentence(text),
      words,
      estSeconds,
      cumulativeSeconds: cumulative,
      name: name || undefined,
      sceneType: (s?.type ?? "").trim() || undefined,
      keywords: keywords.length ? keywords : undefined,
      durationExact,
    });
  }
  return { scenes: out, totalWords, totalSeconds: cumulative, source: "structured" };
}

/**
 * The best storyboard available for a video: its structured scene plan when the
 * pipeline stored one, otherwise the narration split on blank lines. A single
 * entry point so callers don't repeat the fallback.
 */
export function buildStoryboard(
  scenes: VideoScene[] | null | undefined,
  scriptText: string | null | undefined,
): Storyboard {
  const structured = scenesToStoryboard(scenes);
  return structured.scenes.length > 0 ? structured : parseStoryboard(scriptText);
}

/** m:ss for a duration in seconds (e.g. 95 → "1:35"). */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}
