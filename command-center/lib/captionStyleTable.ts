/**
 * Animated caption styles: the closed list and the pure maths — no imports
 * from the editor, so the document validator (lib/editor.ts) can use the list.
 *
 * A style is a NAME stored on the captions (`captions.style.preset`) plus the
 * few looks a person may change (colour, highlight colour, size, position).
 * What it DOES — how a line enters, which word is lit, the box, the glow — is
 * fixed in the export (modules/caption_styles.py, written as libass tags by
 * modules/ass_captions.py) and approximated in the browser preview
 * (lib/captionStylePreview.ts). The table below is also
 * samples/caption_styles.json; tests/caption-styles.test.ts and
 * tests/test_caption_styles.py pin both copies to that file.
 */
import type { Anchor } from "@/lib/editor";

/** The closed list (modules/caption_styles.py STYLE_IDS). */
export const CAPTION_STYLE_IDS = [
  "karaoke",
  "pop_in",
  "boxed",
  "big_centre",
  "lower_third",
  "outlined",
  "neon",
  "typewriter",
  "line_slide",
  "clean",
] as const;
export type CaptionStyleId = (typeof CAPTION_STYLE_IDS)[number];

export function isCaptionStyleId(v: unknown): v is CaptionStyleId {
  return typeof v === "string" && (CAPTION_STYLE_IDS as readonly string[]).includes(v);
}

/** What a person may change on a style. */
export const CAPTION_TWEAKS = ["color", "highlight_color", "size", "y"] as const;
export type CaptionTweak = (typeof CAPTION_TWEAKS)[number];

/** The size a person may pick, in output pixels (the document itself allows 8–512). */
export const CAPTION_SIZE_MIN = 24;
export const CAPTION_SIZE_MAX = 200;
/** How high or low a style may be put: its anchor stays inside the picture. */
export const CAPTION_Y_MIN = 0.1;
export const CAPTION_Y_MAX = 0.97;

export interface CaptionStyleDef {
  id: CaptionStyleId;
  font: "DejaVu Sans" | "DejaVu Serif" | "Liberation Sans" | "Liberation Serif";
  bold: boolean;
  /** Text height as a share of the frame's SHORT side. */
  size_frac: number;
  color: string;
  highlight_color: string;
  outline_color: string;
  outline_width: number;
  /** Where the style's anchor sits, as fractions of the frame. */
  x: number;
  y: number;
  anchor: Anchor;
  /** The tweaks the panel shows for this style. */
  uses: readonly CaptionTweak[];
}

const ALL: readonly CaptionTweak[] = ["color", "highlight_color", "size", "y"];
const PLAIN: readonly CaptionTweak[] = ["color", "size", "y"];

export const CAPTION_STYLES: readonly CaptionStyleDef[] = [
  { id: "karaoke", font: "DejaVu Sans", bold: true, size_frac: 0.062, color: "#FFFFFF", highlight_color: "#FFD400", outline_color: "#000000", outline_width: 4, x: 0.5, y: 0.78, anchor: "bottom", uses: ALL },
  { id: "pop_in", font: "DejaVu Sans", bold: true, size_frac: 0.078, color: "#FFFFFF", highlight_color: "#FFD400", outline_color: "#000000", outline_width: 5, x: 0.5, y: 0.74, anchor: "bottom", uses: PLAIN },
  { id: "boxed", font: "DejaVu Sans", bold: true, size_frac: 0.058, color: "#FFFFFF", highlight_color: "#FFD400", outline_color: "#000000", outline_width: 0, x: 0.5, y: 0.8, anchor: "bottom", uses: ALL },
  { id: "big_centre", font: "DejaVu Sans", bold: true, size_frac: 0.12, color: "#FFFFFF", highlight_color: "#FFD400", outline_color: "#000000", outline_width: 8, x: 0.5, y: 0.5, anchor: "center", uses: ALL },
  { id: "lower_third", font: "DejaVu Sans", bold: true, size_frac: 0.048, color: "#FFFFFF", highlight_color: "#1E6BFF", outline_color: "#000000", outline_width: 0, x: 0.06, y: 0.88, anchor: "bottom-left", uses: ALL },
  { id: "outlined", font: "DejaVu Sans", bold: true, size_frac: 0.09, color: "#FFFFFF", highlight_color: "#FF3B30", outline_color: "#000000", outline_width: 8, x: 0.5, y: 0.7, anchor: "bottom", uses: ALL },
  { id: "neon", font: "DejaVu Sans", bold: true, size_frac: 0.075, color: "#FFFFFF", highlight_color: "#00E5FF", outline_color: "#000000", outline_width: 2, x: 0.5, y: 0.72, anchor: "bottom", uses: ALL },
  { id: "typewriter", font: "DejaVu Sans", bold: true, size_frac: 0.058, color: "#FFFFFF", highlight_color: "#FFD400", outline_color: "#000000", outline_width: 3, x: 0.5, y: 0.8, anchor: "bottom", uses: PLAIN },
  { id: "line_slide", font: "DejaVu Sans", bold: true, size_frac: 0.06, color: "#FFFFFF", highlight_color: "#FFD400", outline_color: "#000000", outline_width: 4, x: 0.5, y: 0.85, anchor: "bottom", uses: PLAIN },
  { id: "clean", font: "Liberation Sans", bold: false, size_frac: 0.05, color: "#FFFFFF", highlight_color: "#FFD400", outline_color: "#000000", outline_width: 0, x: 0.5, y: 0.92, anchor: "bottom", uses: PLAIN },
];

export function styleDef(id: CaptionStyleId): CaptionStyleDef {
  return CAPTION_STYLES.find((s) => s.id === id) ?? CAPTION_STYLES[0];
}

/** The document's caption-style fields. */
export interface CaptionStyleFields {
  font: CaptionStyleDef["font"];
  size: number;
  color: string;
  outline_color: string;
  outline_width: number;
  bold: boolean;
  y: number;
  highlight_color: string;
  preset: CaptionStyleId;
}

/** The text size a style gives a frame: a whole number inside the range a person may pick. */
export function sizeFor(id: CaptionStyleId, width: number, height: number): number {
  const v = Math.round(Math.min(width, height) * styleDef(id).size_frac);
  return Math.min(CAPTION_SIZE_MAX, Math.max(CAPTION_SIZE_MIN, v));
}

/** What applying a style writes into the captions' style (modules/caption_styles.py defaults_for). */
export function styleDefaults(id: CaptionStyleId, width: number, height: number): CaptionStyleFields {
  const s = styleDef(id);
  return {
    font: s.font,
    size: sizeFor(id, width, height),
    color: s.color,
    outline_color: s.outline_color,
    outline_width: s.outline_width,
    bold: s.bold,
    y: s.y,
    highlight_color: s.highlight_color,
    preset: id,
  };
}

// ── words and their times (modules/caption_styles.py, same integer maths) ─────

/** A cue lit word by word is spread over at most this many words (the export's cap). */
export const MAX_STYLED_WORDS = 40;
/** Words lit one by one in a whole document, in cue order (modules/caption_styles.py WORD_BUDGET). */
export const WORD_BUDGET = 6000;
export const MAX_TYPE_STEPS = 40;

export function cueLines(text: string): string[][] {
  const lines: string[][] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const words = raw.split(/\s+/).filter((w) => w.length > 0);
    if (words.length) lines.push(words);
  }
  return lines;
}

/** For each cue (its word count, in document order): is it lit word by word? Same rule as the export. */
export function perWordFlags(counts: readonly number[]): boolean[] {
  let left = WORD_BUDGET;
  return counts.map((n) => {
    const ok = n > 0 && n <= MAX_STYLED_WORDS && n <= left;
    if (ok) left -= n;
    return ok;
  });
}

/** The ids of the cues the export lights word by word (the rest are written plain). */
export function perWordCueIds(cues: readonly { id: string; text: string }[]): Set<string> {
  const flags = perWordFlags(cues.map((c) => cueLines(c.text).reduce((n, ln) => n + ln.length, 0)));
  return new Set(cues.filter((_c, i) => flags[i]).map((c) => c.id));
}

/** `[start, end]` ms per word inside the cue: its share is its length plus one. */
export function wordSpansMs(words: readonly string[], durationMs: number): [number, number][] {
  const total = Math.max(0, Math.trunc(durationMs));
  const weights = words.map((w) => Array.from(w).length + 1);
  const whole = weights.reduce((a, b) => a + b, 0);
  const out: [number, number][] = [];
  let acc = 0;
  let prev = 0;
  for (const w of weights) {
    acc += w;
    const end = Math.floor((total * acc + Math.floor(whole / 2)) / whole);
    out.push([prev, end]);
    prev = end;
  }
  return out;
}

export function luminance(hex: string): number {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return (0.299 * n(1) + 0.587 * n(3) + 0.114 * n(5)) / 255;
}

/** Black or white, whichever reads on `hex`. */
export function textOn(hex: string): "#000000" | "#FFFFFF" {
  return luminance(hex) > 0.55 ? "#000000" : "#FFFFFF";
}

/** `[first atom, ms into the cue]`: the typewriter's reveal runs. */
export function typeSchedule(nAtoms: number, durationMs: number): [number, number][] {
  const n = Math.max(0, Math.trunc(nAtoms));
  if (n === 0) return [];
  const steps = Math.max(1, Math.min(MAX_TYPE_STEPS, n));
  const per = Math.ceil(n / steps);
  const window = Math.max(steps, Math.min(Math.floor((Math.trunc(durationMs) * 7) / 10), 60 * n));
  const out: [number, number][] = [];
  for (let first = 0; first < n; first += per) {
    out.push([first, Math.floor((window * Math.floor(first / per)) / steps)]);
  }
  return out;
}

/** How many atoms the typewriter has shown `elapsedMs` into the cue. */
export function typedAtoms(nAtoms: number, durationMs: number, elapsedMs: number): number {
  const schedule = typeSchedule(nAtoms, durationMs);
  let shown = 0;
  schedule.forEach(([, at], i) => {
    if (at <= elapsedMs) shown = i + 1 < schedule.length ? schedule[i + 1][0] : nAtoms;
  });
  return shown;
}
