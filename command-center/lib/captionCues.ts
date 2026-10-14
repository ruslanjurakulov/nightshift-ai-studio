/**
 * Captions typed or imported by hand: the free way to get cues into a project
 * (a transcript is the priced one, lib/captions.ts). The cues are ordinary
 * editor data afterwards — edit, restyle, delete, export — and nothing here
 * contacts a server, prices or spends.
 *
 * A subtitle file is data from outside: it is read, cleaned and bounded here
 * (size, cue count, text length, no markup, no overlap) before it can become a
 * caption, exactly like text a person types.
 */
import { MAX_CUES, MAX_TEXT, ms, type EditorModel } from "@/lib/editor";
import {
  DEFAULT_PRESET,
  captionIdPrefix,
  captionsOf,
  setCaptions,
  styleFor,
  withinPicture,
  type Captions,
  type Cue,
} from "@/lib/captions";

/** A line of a subtitle file is read up to this many characters (a cue holds MAX_TEXT). */
const LINE_CAP = 4 * MAX_TEXT;

/** A subtitle file larger than this is refused unread (a long film's captions are well under it). */
export const IMPORT_MAX_BYTES = 1_000_000;
/** A typed caption is this long on screen unless the picture ends sooner. */
export const NEW_CUE_S = 2;
/** The shortest a new caption may be; less room than this and it is not added. */
export const MIN_NEW_CUE_S = 0.4;

const TIME = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;
const ARROW = new RegExp(`(${TIME.source})\\s*-->\\s*(${TIME.source})`);

function seconds(h: string | undefined, m: string, s: string, f: string): number {
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(f.padEnd(3, "0")) / 1000;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", nbsp: " ", quot: '"', apos: "'" };

/** A cue's words from a subtitle file: markup and styling blocks removed, entities decoded, control characters dropped. */
function cleanText(lines: readonly string[]): string {
  const joined = lines
    .map((l) =>
      // Cut first, by code point: the patterns below are only as cheap as the line is short,
      // and a file is data from outside (a line of 100 000 "<" must not hang the page).
      Array.from(l)
        .slice(0, LINE_CAP)
        .join("")
        .replace(/<[^<>]*>/g, "")
        .replace(/\{[^{}]*\}/g, "")
        .replace(/&(amp|lt|gt|nbsp|quot|apos);/g, (_m, n: string) => ENTITIES[n])
        .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
  return Array.from(joined).slice(0, MAX_TEXT).join("");
}

export interface ParsedCue {
  start_s: number;
  end_s: number;
  text: string;
}

export interface ParsedCaptions {
  cues: ParsedCue[];
  /** Blocks with a time line that could not be used (no words, no length, a time we cannot read, or squeezed out by a neighbour). */
  skipped: number;
}

/** SubRip (.srt) or WebVTT (.vtt) text → cues in time order, none overlapping. Never throws. */
export function parseCaptionFile(raw: string): ParsedCaptions {
  const text = String(raw ?? "")
    .replace(/^\ufeff/, "")
    .replace(/\r\n?/g, "\n");
  const found: ParsedCue[] = [];
  let skipped = 0;
  for (const block of text.split(/\n[ \t]*\n/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue; // a header, a NOTE, a STYLE block, a stray number
    const m = ARROW.exec(lines[at]);
    // The groups of the two TIME patterns: [1] whole first time, 2-5 its parts, [6] second time, 7-10 its parts.
    const words = cleanText(lines.slice(at + 1));
    if (!m || !words) {
      skipped += 1;
      continue;
    }
    const start = ms(seconds(m[2], m[3], m[4], m[5]));
    const end = ms(seconds(m[7], m[8], m[9], m[10]));
    if (!(end > start)) {
      skipped += 1;
      continue;
    }
    found.push({ start_s: start, end_s: end, text: words });
  }
  found.sort((a, b) => a.start_s - b.start_s || a.end_s - b.end_s);
  const cues: ParsedCue[] = [];
  for (const c of found) {
    const prev = cues[cues.length - 1];
    if (prev && prev.end_s > c.start_s) {
      // Overlapping cues would stack two lines on one spot: the earlier one ends where the next begins.
      if (c.start_s - prev.start_s >= 0.1) prev.end_s = c.start_s;
      else {
        cues.pop();
        skipped += 1;
      }
    }
    cues.push({ ...c });
  }
  if (cues.length > MAX_CUES) {
    skipped += cues.length - MAX_CUES;
    cues.length = MAX_CUES;
  }
  return { cues, skipped };
}

/**
 * The captions an imported file makes for this project: fresh ids, the cues
 * cut to the picture's end, the project's current style kept (or the default
 * look when there are no captions yet). null when nothing is left to show.
 */
export function captionsFromImport(
  model: EditorModel,
  parsed: ParsedCaptions,
  pictureEnd: number,
): Captions | null {
  const prefix = captionIdPrefix(model);
  const cues: Cue[] = parsed.cues.map((c, i) => ({ id: `${prefix}${i + 1}`, ...c }));
  const kept = withinPicture(cues, pictureEnd);
  if (kept.length === 0) return null;
  const style = captionsOf(model)?.style ?? styleFor(DEFAULT_PRESET, model.width, model.height);
  return { style, cues: kept };
}

/** An id no caption of the model has: `cap1`, `cap2`… past the highest in use. */
function freshCueId(model: EditorModel, existing: readonly Cue[]): string {
  const prefix = captionIdPrefix(model);
  const used = new Set(existing.map((c) => c.id));
  let n = existing.length + 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/**
 * A new caption after the last one (or at the start), `NEW_CUE_S` long, cut at
 * the picture's end. null when the picture leaves less than `MIN_NEW_CUE_S`
 * for it or the project already holds the most captions a document takes.
 */
export function addCue(model: EditorModel, text: string, pictureEnd: number): EditorModel | null {
  const cur = captionsOf(model);
  const cues = cur?.cues ?? [];
  if (cues.length >= MAX_CUES) return null;
  const start = cues.length ? cues[cues.length - 1].end_s : 0;
  const end = ms(Math.min(start + NEW_CUE_S, pictureEnd));
  if (end - start < MIN_NEW_CUE_S) return null;
  const style = cur?.style ?? styleFor(DEFAULT_PRESET, model.width, model.height);
  const cue: Cue = { id: freshCueId(model, cues), start_s: ms(start), end_s: end, text: Array.from(text).slice(0, MAX_TEXT).join("") };
  return setCaptions(model, { style, cues: [...cues, cue] });
}
