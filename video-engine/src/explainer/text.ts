import type { ExplainerProps, ExplainerScene, Word } from "./types";

/** "MUTLAQO *TEKIN*" -> [{MUTLAQO }, {TEKIN, accent}]. An unclosed star is plain text. */
export const headlineParts = (text: string): { text: string; accent: boolean }[] => {
  const out: { text: string; accent: boolean }[] = [];
  const re = /\*([^*]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), accent: false });
    out.push({ text: m[1], accent: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), accent: false });
  return out.filter((p) => p.text.length > 0);
};

/**
 * The words of the caption line around time `t`: lines are fixed chunks of `size` words
 * (so a line does not scroll word by word), and the chunk shown is the one holding the
 * latest word already started.
 */
export const wordsForLine = (words: Word[], t: number, size: number): Word[] => {
  if (!words.length || size < 1) return [];
  let idx = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].start_s <= t) idx = i;
    else break;
  }
  if (idx < 0) return [];
  // A line stays up until the next word starts, but not past 1.5 s of silence.
  if (t > words[idx].end_s + 1.5) return [];
  const start = Math.floor(idx / size) * size;
  return words.slice(start, start + size);
};

/** The words spoken inside a scene: a word belongs to the scene its middle falls in. */
export const sceneWords = (words: Word[], s: ExplainerScene): Word[] =>
  words.filter((w) => {
    const mid = (w.start_s + w.end_s) / 2;
    return mid >= s.start_s && mid < s.end_s;
  });

/** A scene's frame window on the narration clock. Throws on times that cannot be drawn. */
export const sceneFrames = (s: ExplainerScene, fps: number): { from: number; duration: number } => {
  if (!(Number.isFinite(s.start_s) && Number.isFinite(s.end_s)) || s.end_s <= s.start_s || s.start_s < 0)
    throw new Error(`scene ${s.id}: bad times ${s.start_s}..${s.end_s}`);
  const from = Math.round(s.start_s * fps);
  return { from, duration: Math.max(1, Math.round(s.end_s * fps) - from) };
};

/** The whole video's length in frames, from the narration; refuses props a render would get wrong. */
export const explainerFrames = (p: ExplainerProps): number => {
  if (!(Number.isFinite(p.duration_s) && p.duration_s > 0)) throw new Error(`bad duration_s ${p.duration_s}`);
  if (!p.scenes.length) throw new Error("no scenes");
  for (const s of p.scenes) {
    sceneFrames(s, p.fps);
    if (s.end_s > p.duration_s + 0.05) throw new Error(`scene ${s.id} ends after the narration (${s.end_s} > ${p.duration_s})`);
  }
  return Math.max(1, Math.ceil(p.duration_s * p.fps));
};

/**
 * The counter's text at `progress` (0..1). It counts up only a value whose digits are unambiguous: a bare integer
 * ("750", "$750", "40%"). "1,500", "10 000" or "3,5" read differently by language, so they appear as written, never
 * re-punctuated. At progress 1 it is always exactly the value the narration said (CLAUDE.md rule 5).
 */
export const statShown = (value: string, progress: number): string => {
  const m = /^(\D*)(\d+)(\D*)$/.exec(value);
  if (!m || progress >= 1) return value;
  const p = Math.max(0, progress);
  const n = Math.round(parseInt(m[2], 10) * (1 - Math.pow(1 - p, 3)));
  return `${m[1]}${n}${m[3]}`;
};
