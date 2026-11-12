/**
 * Mute or bleep words: the pure model edits behind the captions panel's word list (docs/editor-render-fields.md
 * section 18). A bleep is a range of the FINAL MIX, in timeline seconds: `mute` makes it silent, `tone` silent with
 * a 1 kHz tone over it (modules/render_spec.py `bleep_filters`). The document keeps them in order and apart, at most
 * MAX_BLEEPS, each BLEEP_MIN_S..BLEEP_MAX_S long; every edit here keeps those rules, so what it returns validates.
 *
 * A word's time is its caption's time spread over the caption's words by their length, the rule the word-by-word
 * styles use (lib/captionStyleTable.ts `wordSpansMs`, the export's own): a caption carries one start and one end,
 * not a time per word, so a bleep is as close to the spoken word as the caption's timing is. The panel says so.
 */
import {
  BLEEP_MAX_S,
  BLEEP_MIN_S,
  MAX_BLEEPS,
  ms,
  type Bleep,
  type BleepMode,
  type EditorModel,
} from "@/lib/editor";
import { cueLines, wordSpansMs } from "@/lib/captionStyleTable";

export interface CueWord {
  /** The word as the caption shows it. */
  text: string;
  /** Its index among the caption's words. */
  index: number;
  start_s: number;
  end_s: number;
}

/** The caption's words with their times on the timeline (the export's spread: letters + 1 per word). */
export function cueWords(cue: { start_s: number; end_s: number; text: string }): CueWord[] {
  const words = cueLines(cue.text).flat();
  // The export's cue length: centiseconds, as libass times are (modules/ass_captions.py `_cue_ms`).
  const durMs = Math.max(10, (Math.round(cue.end_s * 100) - Math.round(cue.start_s * 100)) * 10);
  return wordSpansMs(words, durMs).map(([a, b], index) => ({
    text: words[index],
    index,
    start_s: ms(cue.start_s + a / 1000),
    end_s: ms(Math.min(cue.end_s, cue.start_s + b / 1000)),
  }));
}

/** Is the playhead inside a bleep? (The preview silences the picture's and the sounds' elements there.) */
export function bleepAt(bleeps: readonly Bleep[] | undefined, t: number): boolean {
  return Boolean(bleeps?.some((b) => t >= b.start_s && t < b.end_s));
}

/** The bleep that covers any of start..end, by index; -1 when none does. */
export function bleepOver(bleeps: readonly Bleep[] | undefined, start: number, end: number): number {
  return (bleeps ?? []).findIndex((b) => b.start_s < end && b.end_s > start);
}

export type BleepEdit =
  | { ok: true; model: EditorModel; change: "added" | "removed" }
  | { ok: false; reason: "full" | "no_room" };

function withBleeps(model: EditorModel, list: Bleep[]): EditorModel {
  if (list.length) return { ...model, bleeps: list };
  const { bleeps: _b, ...rest } = model;
  void _b;
  return rest;
}

/**
 * A word's bleep on or off. On a word a bleep already covers (any part of it), that bleep goes. Otherwise one is
 * added over the word: held to BLEEP_MIN_S..BLEEP_MAX_S (a short word grows at its end, a long one is cut), and held
 * inside the gap between its neighbours (bleeps never overlap; they may touch, so neighbouring words join into one
 * silence). Refused when MAX_BLEEPS are there, or the gap is too small for BLEEP_MIN_S.
 */
export function toggleWordBleep(
  model: EditorModel,
  word: { start_s: number; end_s: number },
  mode: BleepMode,
): BleepEdit {
  const list = model.bleeps ?? [];
  const hit = bleepOver(list, word.start_s, word.end_s);
  if (hit >= 0) return { ok: true, model: withBleeps(model, list.filter((_b, i) => i !== hit)), change: "removed" };
  if (list.length >= MAX_BLEEPS) return { ok: false, reason: "full" };
  const before = list.filter((b) => b.end_s <= word.start_s).at(-1);
  const after = list.find((b) => b.start_s >= word.end_s);
  const lo = Math.max(0, before ? before.end_s : 0);
  const hi = after ? after.start_s : Infinity;
  let start = Math.max(lo, ms(word.start_s));
  let end = Math.min(hi, ms(Math.min(word.end_s, word.start_s + BLEEP_MAX_S)));
  if (end - start < BLEEP_MIN_S) {
    end = Math.min(hi, ms(start + BLEEP_MIN_S));
    if (end - start < BLEEP_MIN_S) start = Math.max(lo, ms(end - BLEEP_MIN_S));
  }
  start = ms(start);
  end = ms(end);
  const length = ms(end - start);
  if (!(length >= BLEEP_MIN_S && length <= BLEEP_MAX_S)) return { ok: false, reason: "no_room" };
  const next = [...list, { start_s: start, end_s: end, mode }].sort((a, b) => a.start_s - b.start_s);
  return { ok: true, model: withBleeps(model, next), change: "added" };
}

/** One bleep's mode (the same model back when it already has it). */
export function setBleepMode(model: EditorModel, index: number, mode: BleepMode): EditorModel {
  const list = model.bleeps ?? [];
  if (!list[index] || list[index].mode === mode) return model;
  return withBleeps(model, list.map((b, i) => (i === index ? { ...b, mode } : b)));
}

export function removeBleep(model: EditorModel, index: number): EditorModel {
  const list = model.bleeps ?? [];
  if (!list[index]) return model;
  return withBleeps(model, list.filter((_b, i) => i !== index));
}
