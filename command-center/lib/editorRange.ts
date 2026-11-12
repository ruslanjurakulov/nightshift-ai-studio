/**
 * In / out marks on the timeline and the edits that use them (range delete: ripple or lift; insert at the
 * playhead), and the one-click J / L cut. All of it is built from operations the editor already had
 * (`splitClip`, `detachClipAudio`) and the document's existing fields: a lift leaves a GAP on the picture lane
 * (`gap_s` in the editor's model, the clips' own `start_s` in the document), which both validators accept and
 * the export renders as black with no sound, no decode and no cost. Nothing new reaches the database or the render.
 *
 * The marks themselves are editor state, never saved with the project (a document field would need both
 * validators and the schema: that is the stored-markers batch, not this one).
 */
import {
  MAX_AUDIO_CLIPS,
  MAX_EDITOR_CLIPS,
  MAX_EDITOR_SOUNDS,
  MIN_CLIP_S,
  audioInputs,
  canInsertClip,
  clipAt,
  clipEnd,
  crossfadeOf,
  detachClipAudio,
  detachProblem,
  freshId,
  gapOf,
  layout,
  ms,
  soundLength,
  splitClip,
  withStarts,
  type DetachProblem,
  type EditorAsset,
  type EditorModel,
  type SoundClip,
  type SourceLength,
  type VideoClip,
} from "@/lib/editor";

/** The timeline's in and out marks, in timeline seconds; null = not set. */
export interface Marks {
  in: number | null;
  out: number | null;
}
export const NO_MARKS: Marks = { in: null, out: null };

/** A mark set at timeline time `t`, on a frame of the project's rate and inside the timeline. */
export function setMark(marks: Marks, which: "in" | "out", t: number, fps: number, total: number): Marks {
  const f = fps > 0 ? fps : 30;
  const v = ms(Math.round(Math.min(Math.max(0, t), Math.max(0, total)) * f) / f);
  return { ...marks, [which]: v };
}

/**
 * The marked range [from, to] in timeline seconds, or null when nothing is marked or it is shorter than a frame.
 * As in other editors, an in mark alone runs to the end and an out mark alone from the start; marks set the
 * wrong way round are read in order; a timeline that got shorter since holds them to its end.
 */
export function markedRange(marks: Marks, total: number, fps: number): [number, number] | null {
  if (marks.in === null && marks.out === null) return null;
  const end = Math.max(0, total);
  const a = Math.min(Math.max(0, marks.in ?? 0), end);
  const b = Math.min(Math.max(0, marks.out ?? end), end);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return hi - lo >= 1 / (fps > 0 ? fps : 30) - 1e-9 ? [ms(lo), ms(hi)] : null;
}

/** Why a range edit or an insert was not made. */
export type RangeProblem =
  /** No marks, or a range shorter than a frame, or one that holds nothing to take out. */
  | "no_range"
  /** The range is the whole picture: it would leave no clip. */
  | "whole"
  /** A mark falls inside a clip with a speed curve (it cannot be split; take the curve off first). */
  | "curve"
  /** A mark would leave a piece under the shortest a clip may be, next to a cross-fade. */
  | "too_close"
  /** The picture lane holds MAX_EDITOR_CLIPS clips. */
  | "clips_full"
  /** A sound runs across the whole range and cutting it in two would need a sound more than the mix holds. */
  | "sounds_full";

/** The index of the clip whose cross-fade in covers timeline time `t` (its overlap with the clip before), or -1. */
function overlapAt(clips: VideoClip[], t: number, half: number): number {
  return clips.findIndex(
    (c, i) => i > 0 && crossfadeOf(c) > 0 && t > c.start_s - half && t < clipEnd(clips[i - 1]) + half,
  );
}

/**
 * A cut at timeline time `t` on the picture lane, and the time it is really at: an existing plain cut, a split of
 * the clip under it, or nothing to cut when `t` is in a gap (black has no inside) or past the picture. A time
 * inside a cross-fade is taken to where the cross-fade ends (a split inside the overlap would shorten it, and with
 * it the timeline); a time within one shortest piece of a plain edge is that edge rather than a sliver split off.
 */
function cutAt(model: EditorModel, t0: number): { model: EditorModel; t: number } | RangeProblem {
  const clips = layout(model.clips);
  const half = 0.5 / model.fps;
  let t = t0;
  if (!clips.length || t <= half) return { model, t: Math.max(0, t) };
  const end = clipEnd(clips[clips.length - 1]);
  if (t >= end - half) return { model, t };
  const o = overlapAt(clips, t, half);
  if (o > 0) t = clipEnd(clips[o - 1]);
  const plainStart = (i: number) => i === 0 || crossfadeOf(clips[i]) === 0;
  const edge = clips.find((c, i) => plainStart(i) && Math.abs(c.start_s - t) < half);
  if (edge) return { model, t: edge.start_s };
  // The end of a clip with a gap or nothing after it (inside a cross-fade the clip that fades in is split below).
  const ends = clips.find((c, i) => Math.abs(clipEnd(c) - t) < half && (i + 1 >= clips.length || gapOf(clips[i + 1]) > 0));
  if (ends) return { model, t: clipEnd(ends) };
  const hit = clipAt(model, t);
  if (!hit) return { model, t }; // in a gap
  if (hit.clip.speed_curve) return "curve";
  const out = splitClip(model, hit.clip.id, t);
  if (out) return { model: out.model, t: ms(t) };
  if (model.clips.length >= MAX_EDITOR_CLIPS) return "clips_full";
  // Too near an edge for a split: the edge it is near, when that edge is a plain cut.
  const i = hit.index;
  const toStart = t - hit.clip.start_s;
  const toEnd = clipEnd(hit.clip) - t;
  if (toStart <= toEnd && plainStart(i)) return { model, t: hit.clip.start_s };
  if (toEnd < toStart && (i + 1 >= clips.length || plainStart(i + 1))) return { model, t: clipEnd(hit.clip) };
  return "too_close";
}

/** Cuts at both ends of [from, to], and the range they are really at. */
function cutRange(
  model: EditorModel,
  from: number,
  to: number,
): { model: EditorModel; a: number; b: number } | RangeProblem {
  if (!(to - from >= 0.5 / model.fps)) return "no_range";
  // The later cut first: a split there leaves every clip before it where it was.
  const right = cutAt(model, to);
  if (typeof right === "string") return right;
  const left = cutAt(right.model, from);
  if (typeof left === "string") return left;
  if (!(right.t - left.t >= 0.5 / model.fps)) return "no_range";
  return { model: left.model, a: left.t, b: right.t };
}

/** Is clip `c` (laid out) inside [a, b]? After `cutRange` every clip is inside or wholly outside. */
const inside = (c: VideoClip, a: number, b: number) => c.start_s >= a - 0.0005 && clipEnd(c) <= b + 0.0005;

/**
 * Every sound's part in [a, b] taken out: a sound wholly inside goes, one across an edge is trimmed to it, one
 * across the whole range becomes two. With `ripple` what was after `b` moves up by the range (a ripple delete);
 * without it nothing moves (a lift: the range is silent). Pieces under MIN_CLIP_S go.
 */
function cutSounds(model: EditorModel, a: number, b: number, ripple: boolean): SoundClip[] | "sounds_full" {
  const out: SoundClip[] = [];
  const len = ms(b - a);
  let m = model;
  const fit = (x: SoundClip): SoundClip | null => {
    const l = soundLength(x);
    if (l < MIN_CLIP_S - 1e-9) return null;
    const fo = Math.min(x.fade_out_s, l);
    return { ...x, fade_out_s: ms(fo), fade_in_s: ms(Math.max(0, Math.min(x.fade_in_s, l - fo))) };
  };
  for (const x of model.sounds) {
    const s0 = x.start_s;
    const e0 = s0 + soundLength(x);
    if (e0 <= a + 1e-9) out.push(x);
    else if (s0 >= b - 1e-9) out.push(ripple ? { ...x, start_s: ms(s0 - len) } : x);
    else {
      const head = s0 < a ? fit({ ...x, out_s: ms(x.in_s + (a - s0)), fade_out_s: x.fade_out_s }) : null;
      const tailIn = ms(x.in_s + (b - s0));
      const tail =
        e0 > b ? fit({ ...x, start_s: ripple ? ms(a) : ms(b), in_s: tailIn, fade_in_s: head ? 0 : x.fade_in_s }) : null;
      if (head) out.push({ ...head, fade_out_s: tail ? 0 : head.fade_out_s });
      if (tail) {
        if (head) {
          // Cut in two: the second piece is one sound more of the mix (counted below).
          const id = freshId(m, "m");
          const piece = { ...tail, id };
          m = { ...m, sounds: [...m.sounds, piece] };
          out.push(piece);
        } else out.push(tail);
      }
    }
  }
  if (out.length > MAX_EDITOR_SOUNDS || audioInputs({ ...model, sounds: out }) > MAX_AUDIO_CLIPS) return "sounds_full";
  return out;
}

const same = (x: EditorModel, y: EditorModel) =>
  JSON.stringify([layout(x.clips), x.sounds]) === JSON.stringify([layout(y.clips), y.sounds]);

/**
 * Ripple delete of the marked range (an "extract"): the picture between the marks goes and the clips after it
 * close up, in one step; the sounds are cut there too and the later ones move up with the picture, so a detached
 * sound stays with its picture. Texts, overlays and shapes are not touched here: the editor's sync lock
 * (lib/editorSync.ts) moves them after. With `sounds: false` (the sound lane is locked) the sounds are not cut or
 * moved either. A gap inside the range closes.
 */
export function extractRange(
  model: EditorModel,
  from: number,
  to: number,
  opts: { sounds?: boolean } = {},
): { model: EditorModel; removed: number; from: number; to: number } | { problem: RangeProblem } {
  const r = cutRange(model, from, to);
  if (typeof r === "string") return { problem: r };
  const clips = layout(r.model.clips);
  const keep = clips.filter((c) => !inside(c, r.a, r.b));
  if (!keep.length) return { problem: "whole" };
  const len = r.b - r.a;
  const starts = keep.map((c) => (c.start_s >= r.b - 0.0005 ? c.start_s - len : c.start_s));
  const sounds = opts.sounds === false ? r.model.sounds : cutSounds(r.model, r.a, r.b, true);
  if (sounds === "sounds_full") return { problem: "sounds_full" };
  const next = { ...r.model, clips: withStarts(keep, starts), sounds };
  if (same(next, model)) return { problem: "no_range" };
  // Where the range really was (the cuts it was taken to): what the sync lock moves the other lanes by.
  return { model: next, removed: clips.length - keep.length, from: r.a, to: r.b };
}

/**
 * Lift the marked range: the picture between the marks becomes a gap (black, no sound, nothing decoded) and the
 * sounds are cut out of it, so the range is silent; nothing after it moves. A lift at the end of the picture just
 * ends it there.
 */
export function liftRange(
  model: EditorModel,
  from: number,
  to: number,
): { model: EditorModel } | { problem: RangeProblem } {
  const r = cutRange(model, from, to);
  if (typeof r === "string") return { problem: r };
  const clips = layout(r.model.clips);
  const keep = clips.filter((c) => !inside(c, r.a, r.b));
  if (!keep.length) return { problem: "whole" };
  const sounds = cutSounds(r.model, r.a, r.b, false);
  if (sounds === "sounds_full") return { problem: "sounds_full" };
  const next = { ...r.model, clips: withStarts(keep, keep.map((c) => c.start_s)), sounds };
  if (same(next, model)) return { problem: "no_range" };
  return { model: next };
}

/**
 * Insert a copy of `source` (a clip of this project: the editor's clipboard) at timeline time `t`: the clip under
 * the playhead is split there and everything after it moves later by the copy's length. At a cut it goes in at
 * that cut, in a gap at that time; past the end it is appended. The copy follows the clip before it with a cut, as
 * a paste does.
 */
export function insertAt(
  model: EditorModel,
  source: VideoClip,
  t: number,
): { model: EditorModel; id: string } | { problem: RangeProblem } {
  if (!canInsertClip(model)) return { problem: "clips_full" };
  const laid = layout(model.clips);
  // Inside a cross-fade the copy goes in at that cut, before the clip that fades in (it then fades in from the copy).
  const o = overlapAt(laid, t, 0.5 / model.fps);
  const cut = o > 0 ? { model, t: clipEnd(laid[o - 1]), before: laid[o].id } : cutAt(model, t);
  if (typeof cut === "string") return { problem: cut };
  if (!canInsertClip(cut.model)) return { problem: "clips_full" };
  const clips = layout(cut.model.clips);
  const end = clips.length ? clipEnd(clips[clips.length - 1]) : 0;
  const at0 = "before" in cut ? clips.findIndex((c) => c.id === cut.before) : clips.findIndex((c) => c.start_s >= cut.t - 0.0005);
  const at = at0 < 0 ? clips.length : at0;
  const id = freshId(cut.model, "c");
  const copy: VideoClip = {
    ...(JSON.parse(JSON.stringify(source)) as VideoClip),
    id,
    audio: source.audio && audioInputs(cut.model) < MAX_AUDIO_CLIPS,
  };
  delete copy.transition;
  delete copy.gap_s;
  const next = [...clips.slice(0, at), copy, ...clips.slice(at)];
  const len = clipEnd(layout([{ ...copy, start_s: 0 }])[0]);
  const place = Math.min(cut.t, end);
  const starts = next.map((c, i) => (i < at ? c.start_s : i === at ? place : c.start_s + len));
  return { model: { ...cut.model, clips: withStarts(next, starts) }, id };
}

// ── J / L cut ────────────────────────────────────────────────────────────────

/** J: the next clip's sound starts before the picture cut. L: the clip's sound runs on after it. */
export type SplitEditKind = "j" | "l";

export type SplitEditProblem =
  /** The first clip: there is no cut before it. */
  | "no_cut"
  /** Neither side of the cut plays its own sound. */
  | "no_sound"
  /** A side cannot have its sound detached (a picture, a retimed or reversed clip, a full mix). */
  | Exclude<DetachProblem, "no_sound">
  /** The files leave no frame to lead or trail by. */
  | "no_room";

/**
 * One-click J or L cut at the cut into clip `id` (the clip after the cut). The sound of each side that plays its
 * own is detached (`detachClipAudio`), then the sound's cut is moved `frames` frames past the picture's cut:
 * an L cut lets the clip before keep sounding into this clip (its sound ends later, this clip's sound starts
 * later); a J cut lets this clip's sound start under the clip before (its sound starts earlier, the other's ends
 * earlier). Held to what the files allow; one undo step. `sounds` are the new sounds' ids.
 */
export function splitEdit(
  model: EditorModel,
  id: string,
  kind: SplitEditKind,
  frames: number,
  sourceOf: SourceLength,
  kindOf: (assetId: string) => EditorAsset["kind"] | undefined,
): { model: EditorModel; sounds: string[]; frames: number } | { problem: SplitEditProblem } {
  const clips = layout(model.clips);
  const i = clips.findIndex((c) => c.id === id);
  if (i <= 0) return { problem: "no_cut" };
  const sides = [clips[i - 1], clips[i]];
  const why = sides.map((c) => detachProblem(model, c.id, kindOf(c.asset_id)));
  if (why.every((w) => w === "no_sound")) return { problem: "no_sound" };
  const other = why.find((w) => w !== null && w !== "no_sound");
  if (other) return { problem: other as Exclude<DetachProblem, "no_sound"> };
  if (model.sounds.length + why.filter((w) => w === null).length > MAX_EDITOR_SOUNDS)
    return { problem: "sounds_full" };

  let m = model;
  const made: (SoundClip | null)[] = [];
  for (let k = 0; k < 2; k += 1) {
    if (why[k] !== null) {
      made.push(null);
      continue;
    }
    const out = detachClipAudio(m, sides[k].id, kindOf(sides[k].asset_id));
    if (!out) return { problem: "sounds_full" };
    m = out.model;
    made.push(m.sounds.find((x) => x.id === out.soundId) ?? null);
  }
  const [before, after] = made;
  const fps = model.fps > 0 ? model.fps : 30;
  const want = Math.max(0, Math.round(frames)) / fps;
  // How far the sound's cut can go: what each file has beyond its part (sounds play at 1x), and enough of each
  // sound left to be a sound at all.
  const room: number[] = [];
  if (kind === "l") {
    if (before) {
      const max = sourceOf(before.asset_id);
      room.push(typeof max === "number" && max > 0 ? ms(max) - before.out_s : Number.POSITIVE_INFINITY);
    }
    if (after) room.push(soundLength(after) - MIN_CLIP_S);
  } else {
    if (after) room.push(after.in_s, after.start_s);
    if (before) room.push(soundLength(before) - MIN_CLIP_S);
  }
  const limit = Math.min(want, ...room);
  const n = Math.floor(limit * fps + 1e-6);
  if (n < 1) return { problem: "no_room" };
  const d = ms(n / fps);
  const sounds = m.sounds.map((x) => {
    if (before && x.id === before.id) return { ...x, out_s: ms(x.out_s + (kind === "l" ? d : -d)) };
    if (after && x.id === after.id) {
      const s = kind === "l" ? d : -d;
      return { ...x, start_s: ms(x.start_s + s), in_s: ms(x.in_s + s) };
    }
    return x;
  });
  return {
    model: { ...m, sounds },
    sounds: made.filter((x): x is SoundClip => x !== null).map((x) => x.id),
    frames: n,
  };
}
