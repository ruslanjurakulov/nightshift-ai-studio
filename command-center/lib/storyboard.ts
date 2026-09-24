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
  /** The Video IR scene id ("s000"), structured scenes only. */
  sceneId?: string;
  /** The factual claims this scene makes, with their ADVISORY fact-check
   *  status (structured scenes only; absent for rows written before claim
   *  linkage existed). */
  claims?: StoryboardClaim[];
}

/** The fact-check statuses the pipeline records (modules/fact_checker.py),
 *  plus "not_checked" — the checker never saw this sentence. */
export type ClaimStatus = "likely_accurate" | "likely_inaccurate" | "unverifiable" | "not_checked";

export interface StoryboardClaim {
  id: string;
  text: string;
  status: ClaimStatus;
  /** True unless the checker was confident the claim is accurate. Advisory
   *  only — a human approves every video regardless. */
  needsReview: boolean;
  reasoning?: string;
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
  id?: string;
  name?: string;
  type?: string;
  narration?: string;
  duration_hint?: number;
  keywords?: string[];
  claim_ids?: string[];
  claims?: VideoSceneClaim[];
}

/** One claim as the pipeline stores it inside a scene (modules/claim_scenes.py). */
export interface VideoSceneClaim {
  id?: string;
  text?: string;
  status?: string | null;
  reasoning?: string;
  requires_human_review?: boolean;
}

const KNOWN_VERDICTS: ReadonlySet<string> = new Set([
  "likely_accurate",
  "likely_inaccurate",
  "unverifiable",
]);

/**
 * Normalize one stored claim. Mirrors the pipeline's own rules so a malformed
 * row can never read as "accurate": a missing status is "not_checked", an
 * unknown verdict string is clamped to "unverifiable" (as fact_checker does),
 * and a claim needs review unless its status is "likely_accurate" AND the row
 * did not itself ask for review. Returns null when there is no claim text.
 */
export function normalizeClaim(c: VideoSceneClaim | null | undefined): StoryboardClaim | null {
  const text = (c?.text ?? "").trim();
  if (!text) return null;
  const raw = typeof c?.status === "string" ? c.status.trim() : "";
  const status: ClaimStatus = !raw || raw === "not_checked"
    ? "not_checked"
    : KNOWN_VERDICTS.has(raw)
      ? (raw as ClaimStatus)
      : "unverifiable";
  const needsReview = status !== "likely_accurate" || c?.requires_human_review === true;
  const reasoning = (c?.reasoning ?? "").trim();
  return {
    id: (c?.id ?? "").trim(),
    text,
    status,
    needsReview,
    reasoning: reasoning || undefined,
  };
}

/** How many claims a storyboard shows, and how many of them want a human. */
export function claimCounts(scenes: StoryboardScene[]): { total: number; needsReview: number } {
  let total = 0;
  let needsReview = 0;
  for (const s of scenes) {
    for (const c of s.claims ?? []) {
      total += 1;
      if (c.needsReview) needsReview += 1;
    }
  }
  return { total, needsReview };
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
  list.forEach((s, position) => {
    const text = (s?.narration ?? "").trim();
    const name = (s?.name ?? "").trim();
    if (!text && !name) return; // nothing to show for this entry
    const words = countWords(text);
    const hint = typeof s?.duration_hint === "number" ? Math.round(s.duration_hint) : 0;
    const durationExact = hint > 0;
    const estSeconds = durationExact ? hint : Math.max(1, Math.round(words / WORDS_PER_SECOND));
    cumulative += estSeconds;
    totalWords += words;
    const keywords = Array.isArray(s?.keywords)
      ? s!.keywords!.map((k) => String(k).trim()).filter(Boolean)
      : [];
    // The scene id is the section's position in the stored plan — the same
    // index the pipeline used — not the display number, which skips blanks.
    const sceneId = (typeof s?.id === "string" && s.id.trim()) || `s${String(position).padStart(3, "0")}`;
    const claims = Array.isArray(s?.claims)
      ? s!.claims!.map(normalizeClaim).filter((c): c is StoryboardClaim => c !== null)
      : undefined;
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
      sceneId,
      claims,
    });
  });
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
