/**
 * Auto-captions (migration 0059), the pure half — client-safe and unit-tested
 * (tests/captions.test.ts).
 *
 * What the database keeps is a TRACK: the words a provider heard, each with
 * its start and end second (caption_tracks, made by a priced "captions" job).
 * Everything else is made here, in the browser, for free and never stored
 * anywhere but the editor's own document:
 *
 *   words  ──segment──▶  cues (lines on screen, never overlapping)
 *   cues   ──▶  doc.captions {style, cues}  (rendered burned-in by the ffmpeg
 *               engine, exactly as an exported video's captions already are)
 *   cues   ──▶  SRT / WebVTT files to download
 *
 * Nothing here prices, holds or spends anything: the price comes from
 * /api/creative/quote (the database) and a job is started only by the
 * person's priced press (components/editor/CaptionsPanel.tsx).
 */
import { CAPTION_LANGUAGES, type CaptionLanguage, isUuid } from "@/lib/creative/operations";
import {
  MAX_CUES,
  MAX_TEXT,
  ms,
  type EditorModel,
  type SoundClip,
  type VideoClip,
} from "@/lib/editor";

// ── languages ───────────────────────────────────────────────────────────────

export { CAPTION_LANGUAGES, type CaptionLanguage };

export function isCaptionLanguage(v: unknown): v is CaptionLanguage {
  return typeof v === "string" && (CAPTION_LANGUAGES as readonly string[]).includes(v);
}

/** The language a job starts in: the one the app is read in, else English. */
export function defaultCaptionLanguage(locale: unknown): CaptionLanguage {
  return isCaptionLanguage(locale) ? locale : "en";
}

/** The longest recording captions take (0059's source check; the database still decides). */
export const CAPTIONS_MAX_SECONDS = 1800;

// ── the track the database kept ─────────────────────────────────────────────

export interface CaptionWord {
  t: string;
  s: number;
  e: number;
}

export interface CaptionTrackSummary {
  id: string;
  /** A base language tag, "und" when neither the person nor the provider named one. */
  language: string;
  durationS: number;
  wordCount: number;
  createdAt: string;
  assetId: string | null;
}

export interface CaptionTrack extends CaptionTrackSummary {
  words: CaptionWord[];
}

/** Columns a member reads (RLS shows the tracks of completed jobs of their organization). */
export const TRACK_SUMMARY_COLUMNS = "id,language,duration_s,word_count,created_at,asset_id";
export const TRACK_COLUMNS = `${TRACK_SUMMARY_COLUMNS},words`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Words as stored, defended again: a malformed or backwards word is dropped, never shown. */
export function coerceWords(v: unknown): CaptionWord[] {
  if (!Array.isArray(v)) return [];
  const out: CaptionWord[] = [];
  let prevEnd = 0;
  for (const w of v) {
    if (!isObj(w) || typeof w.t !== "string") continue;
    const s = num(w.s);
    const e = num(w.e);
    const t = w.t.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, "").trim();
    if (!t || s === null || e === null || s < 0 || e <= s) continue;
    if (s < prevEnd - 0.0005) continue;
    out.push({ t, s: ms(s), e: ms(e) });
    prevEnd = e;
  }
  return out;
}

export function coerceTrackSummary(row: unknown): CaptionTrackSummary | null {
  if (!isObj(row) || !isUuid(row.id) || typeof row.language !== "string" || !/^[a-z]{2,3}$/.test(row.language)) return null;
  const durationS = num(typeof row.duration_s === "string" ? Number(row.duration_s) : row.duration_s);
  const wordCount = num(row.word_count);
  if (durationS === null || durationS <= 0 || wordCount === null || wordCount < 1) return null;
  return {
    id: row.id,
    language: row.language,
    durationS,
    wordCount,
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
    assetId: isUuid(row.asset_id) ? row.asset_id : null,
  };
}

export function coerceTrack(row: unknown): CaptionTrack | null {
  const head = coerceTrackSummary(row);
  if (!head || !isObj(row)) return null;
  const words = coerceWords(row.words);
  return words.length ? { ...head, words } : null;
}

// ── cues ────────────────────────────────────────────────────────────────────

export interface Cue {
  id: string;
  start_s: number;
  end_s: number;
  text: string;
}

export interface CaptionStyle {
  font: "DejaVu Sans" | "DejaVu Serif" | "Liberation Sans" | "Liberation Serif";
  size: number;
  color: string;
  outline_color: string;
  outline_width: number;
  bold: boolean;
  /** Where the caption's bottom edge sits, as a share of the frame's height. */
  y: number;
}

export interface Captions {
  style: CaptionStyle;
  cues: Cue[];
}

/** The shortest a cue stays on screen (a cue shorter than this flashes). */
export const MIN_CUE_S = 0.4;
/** A caption never runs longer than this on screen. */
export const MAX_CUE_S = 7;
/** A pause this long between two words starts a new caption. */
export const PAUSE_S = 0.7;
/** The most characters per second a viewer can read; a cue that is faster is held longer when the next cue allows. */
export const MAX_CPS: Record<string, number> = { en: 17, ru: 15, uz: 15 };
const DEFAULT_CPS = 15;
/** How much longer than its words a cue may be held to be readable. */
const MAX_HOLD_S = 1.5;

export interface PresetSegmentation {
  /** Lines of text on screen at once. */
  maxLines: number;
  /** Words in one caption (a short-form "pop" style shows a few at a time). */
  maxWords: number;
}

export interface CaptionPreset {
  id: "classic" | "bold" | "pop" | "clean";
  /** Share of the frame's SHORT side the text is tall (so a portrait and a landscape frame read alike). */
  sizeFrac: number;
  style: Omit<CaptionStyle, "size">;
  segmentation: PresetSegmentation;
}

/**
 * The burned-in looks. Fonts are the render worker's closed list (DejaVu and
 * Liberation, both with Cyrillic and the Latin letters Uzbek needs) — a
 * family it does not have would be silently replaced by libass. Colours are
 * plain #RRGGBB with a dark outline: readable on any picture, and the only
 * thing the renderer draws (no boxes).
 */
export const CAPTION_PRESETS: readonly CaptionPreset[] = [
  {
    id: "classic",
    sizeFrac: 0.062,
    style: { font: "DejaVu Sans", color: "#FFFFFF", outline_color: "#000000", outline_width: 3, bold: true, y: 0.9 },
    segmentation: { maxLines: 2, maxWords: 12 },
  },
  {
    id: "bold",
    sizeFrac: 0.078,
    style: { font: "DejaVu Sans", color: "#FFE600", outline_color: "#000000", outline_width: 5, bold: true, y: 0.8 },
    segmentation: { maxLines: 2, maxWords: 6 },
  },
  {
    id: "pop",
    sizeFrac: 0.1,
    style: { font: "DejaVu Sans", color: "#FFFFFF", outline_color: "#000000", outline_width: 6, bold: true, y: 0.72 },
    segmentation: { maxLines: 1, maxWords: 3 },
  },
  {
    id: "clean",
    sizeFrac: 0.05,
    style: { font: "Liberation Sans", color: "#FFFFFF", outline_color: "#000000", outline_width: 2, bold: false, y: 0.92 },
    segmentation: { maxLines: 2, maxWords: 14 },
  },
];

export type CaptionPresetId = CaptionPreset["id"];
export const DEFAULT_PRESET: CaptionPresetId = "classic";

export function isPresetId(v: unknown): v is CaptionPresetId {
  return CAPTION_PRESETS.some((p) => p.id === v);
}

export function presetOf(id: CaptionPresetId): CaptionPreset {
  return CAPTION_PRESETS.find((p) => p.id === id) ?? CAPTION_PRESETS[0];
}

/** The style a preset gives a frame of this size (a whole-number size inside the renderer's range). */
export function styleFor(id: CaptionPresetId, width: number, height: number): CaptionStyle {
  const p = presetOf(id);
  const size = Math.min(200, Math.max(24, Math.round(Math.min(width, height) * p.sizeFrac)));
  return { ...p.style, size };
}

/** The preset a style came from, when it is exactly one of them for this frame; else null (a hand-made look). */
export function presetMatching(style: unknown, width: number, height: number): CaptionPresetId | null {
  if (!isObj(style)) return null;
  for (const p of CAPTION_PRESETS) {
    const s = styleFor(p.id, width, height);
    if ((Object.keys(s) as (keyof CaptionStyle)[]).every((k) => style[k] === s[k])) return p.id;
  }
  return null;
}

/**
 * Characters per line. A landscape frame holds about 42, a portrait one about
 * 26; Cyrillic letters are wider and Uzbek words longer, so those lines are a
 * little shorter. The presets' own size shrinks the line too: a bigger font
 * fits fewer letters.
 */
export function lineLimit(language: string, width: number, height: number, preset: CaptionPresetId): number {
  const portrait = height > width;
  let n = portrait ? 26 : 42;
  if (language === "ru") n *= 0.92;
  else if (language === "uz") n *= 0.95;
  n *= Math.min(1.3, Math.max(0.55, 0.062 / presetOf(preset).sizeFrac));
  return Math.max(8, Math.round(n));
}

const SENTENCE_END = /[.!?…。]["'»”)\]]*$/;
const CLAUSE_END = /[,;:—–]["'»”)\]]*$/;

/** Words into lines of at most `limit` characters (a single longer word stays whole on its own line). */
export function wrapLines(words: readonly string[], limit: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= limit) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export interface SegmentOptions {
  language: string;
  width: number;
  height: number;
  preset: CaptionPresetId;
  /** Ids start from here (`cap1`…); the editor passes names that no clip uses. */
  idPrefix?: string;
}

/**
 * Words -> cues. Deterministic: the same words and options give the same
 * cues. A cue ends at a sentence end, at a pause, at the preset's word limit
 * or when its text no longer fits in its lines; a clause end ends it early
 * once it is more than half full. Cues never overlap, each lasts at least
 * MIN_CUE_S when the next cue allows, and one that would be read too fast is
 * held a little longer (never into the next cue). Times are milliseconds.
 */
export function segmentWords(words: readonly CaptionWord[], opts: SegmentOptions): Cue[] {
  const preset = presetOf(opts.preset);
  const limit = lineLimit(opts.language, opts.width, opts.height, opts.preset);
  const capacity = limit * preset.segmentation.maxLines;
  const groups: CaptionWord[][] = [];
  let cur: CaptionWord[] = [];
  const fits = (g: readonly CaptionWord[]) => wrapLines(g.map((w) => w.t), limit).length <= preset.segmentation.maxLines;
  const chars = (g: readonly CaptionWord[]) => g.reduce((n, w) => n + w.t.length + 1, -1);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = w.s - prev.e;
      const next = [...cur, w];
      if (gap > PAUSE_S || cur.length >= preset.segmentation.maxWords || !fits(next) || w.e - cur[0].s > MAX_CUE_S) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
    if (SENTENCE_END.test(w.t) || (CLAUSE_END.test(w.t) && chars(cur) > capacity / 2)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);

  const prefix = opts.idPrefix ?? "cap";
  const cps = MAX_CPS[opts.language] ?? DEFAULT_CPS;
  const cues: Cue[] = [];
  groups.forEach((g, i) => {
    const text = wrapLines(g.map((x) => x.t), limit).join("\n");
    const start = ms(g[0].s);
    let end = Math.max(g[g.length - 1].e, start + MIN_CUE_S);
    const nextStart = i + 1 < groups.length ? groups[i + 1][0].s : Infinity;
    // Held longer to be readable, never past the next cue or past MAX_HOLD_S.
    const needed = text.replace(/\n/g, " ").length / cps;
    if (end - start < needed) end = Math.min(start + needed, g[g.length - 1].e + MAX_HOLD_S);
    end = Math.min(end, nextStart);
    if (ms(end) <= start) end = g[g.length - 1].e;
    cues.push({ id: `${prefix}${i + 1}`, start_s: start, end_s: ms(end), text });
  });
  // Rounding must never make two cues touch backwards.
  for (let i = 0; i + 1 < cues.length; i++) {
    if (cues[i].end_s > cues[i + 1].start_s) cues[i].end_s = cues[i + 1].start_s;
  }
  return cues.filter((c) => c.end_s > c.start_s && c.text.length > 0 && c.text.length <= MAX_TEXT).slice(0, MAX_CUES);
}

// ── from a recording's time to the timeline's ───────────────────────────────

/** The part of the editor model that decides where a recording's sound is heard. */
export type PlayedClip = Pick<VideoClip, "asset_id" | "start_s" | "in_s" | "out_s" | "speed"> & { audio?: boolean };

/**
 * The clips of the timeline that play `assetId`'s own sound: a video clip only
 * when its sound is on (a muted clip's words would be captions nobody hears),
 * and every music / sound clip of it.
 */
export function playedClips(model: Pick<EditorModel, "clips" | "sounds">, assetId: string): PlayedClip[] {
  const out: PlayedClip[] = [];
  const id = assetId.toLowerCase();
  for (const c of model.clips) if (c.asset_id.toLowerCase() === id && c.audio) out.push(c);
  for (const s of model.sounds as SoundClip[]) if (s.asset_id.toLowerCase() === id) out.push({ ...s, speed: 1 });
  return out.sort((a, b) => a.start_s - b.start_s);
}

/**
 * Words (in the recording's own seconds) laid on the timeline: each clip shows
 * the words inside its trim, moved to where it starts and scaled by its speed.
 * A word only partly inside a trim is kept when at least a fifth of a second
 * (or half of it) is — never a sliver of one. Sorted and made strictly
 * forward, so the cues made from them can never overlap.
 */
export function wordsOnTimeline(words: readonly CaptionWord[], clips: readonly PlayedClip[]): CaptionWord[] {
  const out: CaptionWord[] = [];
  for (const c of clips) {
    const speed = c.speed > 0 ? c.speed : 1;
    for (const w of words) {
      const a = Math.max(w.s, c.in_s);
      const b = Math.min(w.e, c.out_s);
      const inside = b - a;
      if (inside <= 0 || (inside < 0.2 && inside < (w.e - w.s) / 2)) continue;
      out.push({ t: w.t, s: ms(c.start_s + (a - c.in_s) / speed), e: ms(c.start_s + (b - c.in_s) / speed) });
    }
  }
  out.sort((x, y) => x.s - y.s || x.e - y.e);
  const forward: CaptionWord[] = [];
  let prevEnd = 0;
  for (const w of out) {
    const s = Math.max(w.s, prevEnd);
    if (w.e <= s) continue;
    forward.push({ t: w.t, s: ms(s), e: w.e });
    prevEnd = w.e;
  }
  return forward;
}

// ── the document ────────────────────────────────────────────────────────────

/** The cues and style the model holds, defended: a malformed document gives none. */
export function captionsOf(model: Pick<EditorModel, "captions">): Captions | null {
  const c = model.captions;
  if (!isObj(c) || !Array.isArray(c.cues)) return null;
  const cues: Cue[] = [];
  for (const q of c.cues) {
    if (!isObj(q) || typeof q.id !== "string" || typeof q.text !== "string") continue;
    const s = num(q.start_s);
    const e = num(q.end_s);
    if (s === null || e === null || e <= s) continue;
    cues.push({ id: q.id, start_s: s, end_s: e, text: q.text });
  }
  const st = isObj(c.style) ? c.style : {};
  const base = styleFor(DEFAULT_PRESET, 1080, 1920);
  const style = { ...base, ...(st as Partial<CaptionStyle>) };
  return { style, cues };
}

/** Ids no clip, text, sound or track of the model uses: `cap1`, `cap2`… */
export function captionIdPrefix(model: Pick<EditorModel, "clips" | "texts" | "sounds" | "keep">): string {
  const used = new Set<string>([
    "v1",
    ...model.clips.map((c) => c.id),
    ...model.texts.map((t) => t.id),
    ...model.sounds.map((x) => x.id),
    ...model.keep.flatMap((t) => [t.id, ...t.clips.map((c) => String(c.id))]),
  ]);
  // A track of the document may also be named like a cue (`a1`, `t1`): a cue prefix that cannot collide with them.
  for (const prefix of ["cap", "cue", "sub", "cc"]) {
    let clash = false;
    for (const id of used) if (id.startsWith(prefix)) clash = true;
    if (!clash) return prefix;
  }
  let n = 1;
  while ([...used].some((id) => id.startsWith(`cap${n}x`))) n += 1;
  return `cap${n}x`;
}

/** Cues cut to the picture's end (a caption past it would lengthen the video with black). */
export function withinPicture(cues: readonly Cue[], pictureEnd: number): Cue[] {
  const out: Cue[] = [];
  for (const c of cues) {
    if (c.start_s >= pictureEnd) continue;
    out.push(c.end_s > pictureEnd ? { ...c, end_s: ms(pictureEnd) } : c);
  }
  return out.filter((c) => c.end_s > c.start_s);
}

export function setCaptions(model: EditorModel, captions: Captions | null): EditorModel {
  if (!captions || captions.cues.length === 0) {
    if (model.captions === undefined) return model;
    const rest = { ...model };
    delete rest.captions;
    return rest;
  }
  return { ...model, captions: { style: captions.style, cues: captions.cues } };
}

export function setCaptionStyle(model: EditorModel, style: CaptionStyle): EditorModel {
  const cur = captionsOf(model);
  return cur ? setCaptions(model, { style, cues: cur.cues }) : model;
}

/** Edits one cue: its words (non-empty, at most 500 characters) or its times (inside the neighbours). */
export function updateCue(
  model: EditorModel,
  id: string,
  patch: Partial<Pick<Cue, "text" | "start_s" | "end_s">>,
): EditorModel {
  const cur = captionsOf(model);
  if (!cur) return model;
  const i = cur.cues.findIndex((c) => c.id === id);
  if (i < 0) return model;
  const c = cur.cues[i];
  const text = patch.text === undefined ? c.text : patch.text.slice(0, MAX_TEXT);
  const lo = i > 0 ? cur.cues[i - 1].end_s : 0;
  const hi = i + 1 < cur.cues.length ? cur.cues[i + 1].start_s : Infinity;
  let start = patch.start_s === undefined ? c.start_s : Math.max(lo, ms(patch.start_s));
  let end = patch.end_s === undefined ? c.end_s : Math.min(hi, ms(patch.end_s));
  if (end - start < 0.1) {
    // A cue keeps a visible length: move only the edge the person did not touch.
    if (patch.start_s !== undefined && patch.end_s === undefined) start = ms(end - 0.1);
    else end = ms(start + 0.1);
  }
  if (start < lo || end > hi || end <= start) return model;
  const next = cur.cues.slice();
  next[i] = { ...c, text, start_s: start, end_s: end };
  return setCaptions(model, { style: cur.style, cues: next });
}

export function removeCue(model: EditorModel, id: string): EditorModel {
  const cur = captionsOf(model);
  if (!cur) return model;
  return setCaptions(model, { style: cur.style, cues: cur.cues.filter((c) => c.id !== id) });
}

/** The cues on screen at `t`. */
export function cuesAt(model: Pick<EditorModel, "captions">, t: number): Cue[] {
  return (captionsOf(model)?.cues ?? []).filter((c) => t >= c.start_s && t < c.end_s);
}

/** Cues that are empty or longer than the document takes: the problems a person can fix. */
export function cueWarnings(cues: readonly Cue[]): Record<string, "empty" | "too_long"> {
  const out: Record<string, "empty" | "too_long"> = {};
  for (const c of cues) {
    if (!c.text.trim()) out[c.id] = "empty";
    else if (c.text.length > MAX_TEXT) out[c.id] = "too_long";
  }
  return out;
}

/**
 * The whole step from a transcript to the document's captions: the words laid
 * on the timeline, segmented for the preset and language, cut to the picture.
 * null when none of the recording's sound is heard on the timeline.
 */
export function captionsFromTrack(
  model: EditorModel,
  track: Pick<CaptionTrack, "words" | "language">,
  assetId: string,
  preset: CaptionPresetId,
  pictureEnd: number,
): Captions | null {
  const clips = playedClips(model, assetId);
  if (clips.length === 0) return null;
  const words = wordsOnTimeline(track.words, clips);
  const cues = withinPicture(
    segmentWords(words, {
      language: track.language,
      width: model.width,
      height: model.height,
      preset,
      idPrefix: captionIdPrefix(model),
    }),
    pictureEnd,
  );
  if (cues.length === 0) return null;
  return { style: styleFor(preset, model.width, model.height), cues };
}

// ── SRT and WebVTT ──────────────────────────────────────────────────────────

function clock(seconds: number, sep: "," | "."): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const f = total % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}

export const srtTime = (s: number) => clock(s, ",");
export const vttTime = (s: number) => clock(s, ".");

/** A cue's text made safe for a subtitle file: no blank line (it ends a cue), LF line breaks, no control characters. */
function plain(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁠-⁯﻿]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/** SubRip: numbered cues, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, a blank line between. Cues are in time order. */
export function buildSrt(cues: readonly Cue[]): string {
  return (
    sorted(cues)
      .map((c, i) => `${i + 1}\n${srtTime(c.start_s)} --> ${srtTime(c.end_s)}\n${plain(c.text)}\n`)
      .join("\n")
  );
}

/** WebVTT: the `WEBVTT` header, then cues. `&`, `<` and `>` are escaped and `-->` cannot appear in a cue's text. */
export function buildVtt(cues: readonly Cue[]): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/-->/g, "- ->");
  return (
    "WEBVTT\n\n" +
    sorted(cues)
      .map((c, i) => `${i + 1}\n${vttTime(c.start_s)} --> ${vttTime(c.end_s)}\n${esc(plain(c.text))}\n`)
      .join("\n")
  );
}

function sorted(cues: readonly Cue[]): Cue[] {
  return cues.filter((c) => plain(c.text) && c.end_s > c.start_s).slice().sort((a, b) => a.start_s - b.start_s || a.end_s - b.end_s);
}

/** A file name for a download: letters and digits of the title, the language, the extension. */
export function captionFileName(title: string, language: string, ext: "srt" | "vtt"): string {
  const base = title
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const lang = /^[a-z]{2,3}$/.test(language) ? language : "und";
  return `${base || "captions"}.${lang}.${ext}`;
}

// ── jobs ────────────────────────────────────────────────────────────────────

export interface CaptionJob {
  id: string;
  status: string;
  sourceAssetId: string | null;
  quoted: number;
  charged: number | null;
  errorCode: string | null;
  trackId: string | null;
  createdAt: string;
}

/** Captions jobs among raw creative_jobs rows (the Studio's feed ignores them: they live in the editor). */
export function coerceCaptionJobs(rows: unknown): CaptionJob[] {
  if (!Array.isArray(rows)) return [];
  const out: CaptionJob[] = [];
  for (const r of rows) {
    if (!isObj(r) || r.capability !== "captions" || !isUuid(r.id) || typeof r.status !== "string") continue;
    const params = isObj(r.params) ? r.params : {};
    const result = isObj(r.result) ? r.result : {};
    const q = num(typeof r.quoted_credits === "string" ? Number(r.quoted_credits) : r.quoted_credits);
    const c = num(typeof r.charged_credits === "string" ? Number(r.charged_credits) : r.charged_credits);
    out.push({
      id: r.id,
      status: r.status,
      sourceAssetId: isUuid(params.source_asset_id) ? params.source_asset_id : null,
      quoted: q ?? 0,
      charged: c,
      errorCode: typeof r.error_code === "string" ? r.error_code : null,
      trackId: isUuid(result.track_id) ? result.track_id : null,
      createdAt: typeof r.created_at === "string" ? r.created_at : "",
    });
  }
  return out;
}

/** The params of a captions job: the recording, and the language only when the person named one. */
export function captionParams(assetId: string, language: CaptionLanguage | null): Record<string, string> {
  return language ? { source_asset_id: assetId, language } : { source_asset_id: assetId };
}

/** Why the recording of a clip cannot be captioned here, or null (the database decides again at the quote). */
export function recordingProblem(a: { kind: string; durationS: number | null } | undefined): "unknown" | "too_long" | "not_recording" | null {
  if (!a) return "unknown";
  if (a.kind !== "video" && a.kind !== "audio") return "not_recording";
  if (a.durationS === null || !(a.durationS > 0)) return "unknown";
  if (a.durationS > CAPTIONS_MAX_SECONDS) return "too_long";
  return null;
}
