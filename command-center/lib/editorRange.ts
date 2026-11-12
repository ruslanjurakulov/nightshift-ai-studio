/**
 * In / out marks on the timeline and the edits that use them (range delete: ripple or lift; insert at the
 * playhead), and the one-click J / L cut. All of it is built from operations the editor already had
 * (`splitClip`, `removeClip`, `detachClipAudio`) and the document's existing fields, so both validators judge
 * the result as they judge any edit and nothing new reaches the database or the render.
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
  layout,
  ms,
  removeClip,
  soundLength,
  splitClip,
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
  /** No marks, or a range shorter than a frame or holding no picture. */
  | "no_range"
  /** The range is the whole picture: a ripple delete would leave nothing. */
  | "whole"
  /** A mark falls inside a clip with a speed curve (it cannot be split; take the curve off first). */
  | "curve"
  /** A mark would leave a piece under the shortest a clip may be, next to a cross-fade. */
  | "too_close"
  /** The picture lane holds MAX_EDITOR_CLIPS clips. */
  | "clips_full"
  /** The file the lifted part starts with is not known to the editor (so its gap cannot be held). */
  | "unknown_file";

/** The index of the clip whose cross-fade in covers timeline time `t` (its overlap with the clip before), or -1. */
function overlapAt(clips: VideoClip[], t: number, half: number): number {
  return clips.findIndex(
    (c, i) => i > 0 && crossfadeOf(c) > 0 && t > c.start_s - half && t < clipEnd(clips[i - 1]) + half,
  );
}

/**
 * A cut at timeline time `t` on the picture lane: an existing cut there (a plain one), or a split of the clip
 * under it. `at` is the id of the clip that starts at the cut (null: the end), and that clip never has a
 * cross-fade in, so a range between two cuts has plain cuts at both ends and its length is what it covers.
 * A time inside a cross-fade is taken to where the cross-fade ends (a split inside the overlap would shorten
 * the cross-fade, and with it the timeline); a time within one shortest piece of a plain edge is that edge,
 * rather than a sliver split off.
 */
function cutAt(model: EditorModel, at0: number): { model: EditorModel; at: string | null } | RangeProblem {
  const clips = layout(model.clips);
  if (!clips.length) return "no_range";
  const half = 0.5 / model.fps;
  let t = at0;
  if (t <= half) return { model, at: clips[0].id };
  const end = clipEnd(clips[clips.length - 1]);
  if (t >= end - half) return { model, at: null };
  const o = overlapAt(clips, t, half);
  if (o > 0) t = clipEnd(clips[o - 1]);
  const plainStart = (i: number) => i === 0 || crossfadeOf(clips[i]) === 0;
  const edge = clips.findIndex((c, i) => i > 0 && plainStart(i) && Math.abs(c.start_s - t) < half);
  if (edge > 0) return { model, at: clips[edge].id };
  const hit = clipAt(model, t);
  if (!hit) return { model, at: null };
  if (hit.clip.speed_curve) return "curve";
  const out = splitClip(model, hit.clip.id, t);
  if (out) return { model: out.model, at: out.newId };
  if (model.clips.length >= MAX_EDITOR_CLIPS) return "clips_full";
  // Too near an edge for a split: the edge it is near, when that edge is a plain cut.
  const i = hit.index;
  const toStart = t - hit.clip.start_s;
  const toEnd = clipEnd(hit.clip) - t;
  if (toStart <= toEnd && plainStart(i)) return { model, at: hit.clip.id };
  if (toEnd < toStart && (i + 1 >= clips.length || plainStart(i + 1)))
    return { model, at: i + 1 < clips.length ? clips[i + 1].id : null };
  return "too_close";
}

/** The clips between cuts at `from` and `to`, with the model the two cuts made. */
function cutRange(
  model: EditorModel,
  from: number,
  to: number,
): { model: EditorModel; inside: VideoClip[]; before: number; after: number } | RangeProblem {
  if (!(to - from >= 0.5 / model.fps)) return "no_range";
  // The later cut first: a split there leaves every id before it as it was.
  const right = cutAt(model, to);
  if (typeof right === "string") return right;
  const left = cutAt(right.model, from);
  if (typeof left === "string") return left;
  const clips = layout(left.model.clips);
  const ia = left.at === null ? clips.length : clips.findIndex((c) => c.id === left.at);
  const ib = right.at === null ? clips.length : clips.findIndex((c) => c.id === right.at);
  if (ia < 0 || ib < 0 || ib <= ia) return "no_range";
  return { model: left.model, inside: clips.slice(ia, ib), before: ia, after: ib };
}

/**
 * Ripple delete of the marked range (an "extract"): the picture between the marks goes and the clips after it
 * close up, in one step. Texts, sounds, overlays and shapes keep their times, as after any ripple delete here.
 */
export function extractRange(
  model: EditorModel,
  from: number,
  to: number,
): { model: EditorModel; removed: number } | { problem: RangeProblem } {
  const r = cutRange(model, from, to);
  if (typeof r === "string") return { problem: r };
  if (r.before === 0 && r.after === layout(r.model.clips).length) return { problem: "whole" };
  let m = r.model;
  for (const c of r.inside) m = removeClip(m, c.id);
  return { model: m, removed: r.inside.length };
}

/** The black of a lifted range: a mask over the whole frame, turned inside out, hides all of the picture. */
export const LIFT_MASK = { shape: "rect", x: 0.5, y: 0.5, w: 1, h: 1, feather: 0, invert: true } as const;

/** Is this clip the black hold a lift leaves (so the editor can name it for what it is)? */
export function isLiftHold(c: VideoClip): boolean {
  const k = c.mask;
  return Boolean(
    k && !c.audio && k.shape === "rect" && k.invert === true && k.w === 1 && k.h === 1 && (k.x ?? 0.5) === 0.5 && (k.y ?? 0.5) === 0.5,
  );
}

/**
 * Lift the marked range: the picture between the marks becomes black and silent for exactly as long, so nothing
 * after it moves. The picture lane has no empty gaps (it is laid end to end), so the gap is held by one clip:
 * the lifted part's first file, frozen on its first frame (a still for a picture) with no sound and a mask
 * over the whole frame turned inside out (black). Fields the render already has; it is a clip like any other,
 * which the person can trim or delete.
 */
export function liftRange(
  model: EditorModel,
  from: number,
  to: number,
  kindOf: (assetId: string) => EditorAsset["kind"] | undefined,
): { model: EditorModel; id: string } | { problem: RangeProblem } {
  const r = cutRange(model, from, to);
  if (typeof r === "string") return { problem: r };
  const clips = layout(r.model.clips);
  const first = r.inside[0];
  const kind = kindOf(first.asset_id);
  if (kind !== "video" && kind !== "image") return { problem: "unknown_file" };
  const start = first.start_s;
  const end = r.after < clips.length ? clips[r.after].start_s : clipEnd(clips[clips.length - 1]);
  const length = ms(end - start);
  if (Math.round(length * model.fps) < 1) return { problem: "no_range" };
  const id = freshId(r.model, "c");
  // A frozen frame decodes one frame, whatever the length; a picture has no time inside it at all.
  const hold: VideoClip =
    kind === "video"
      ? { id, asset_id: first.asset_id, start_s: start, in_s: first.in_s, out_s: ms(first.in_s + length), speed: 1, audio: false, freeze: true, mask: { ...LIFT_MASK } }
      : { id, asset_id: first.asset_id, start_s: start, in_s: 0, out_s: length, speed: 1, audio: false, mask: { ...LIFT_MASK } };
  const next = [...clips.slice(0, r.before), hold, ...clips.slice(r.after)];
  return { model: { ...r.model, clips: layout(next) }, id };
}

/**
 * Insert a copy of `source` (a clip of this project: the editor's clipboard) at timeline time `t`: the clip under
 * the playhead is split there and everything after it moves later by the copy's length. At a cut it goes in at
 * that cut; past the end it is appended. The copy follows the clip before it with a cut, as a paste does.
 */
export function insertAt(
  model: EditorModel,
  source: VideoClip,
  t: number,
): { model: EditorModel; id: string } | { problem: RangeProblem } {
  if (!canInsertClip(model)) return { problem: "clips_full" };
  // Inside a cross-fade the copy goes in at that cut, before the clip that fades in (it then fades in from the copy).
  const laid = layout(model.clips);
  const o = overlapAt(laid, t, 0.5 / model.fps);
  const cut = o > 0 ? { model, at: laid[o].id } : model.clips.length ? cutAt(model, t) : { model, at: null };
  if (typeof cut === "string") return { problem: cut };
  if (!canInsertClip(cut.model)) return { problem: "clips_full" };
  const clips = layout(cut.model.clips);
  const at = cut.at === null ? clips.length : clips.findIndex((c) => c.id === cut.at);
  const id = freshId(cut.model, "c");
  const copy: VideoClip = {
    ...(JSON.parse(JSON.stringify(source)) as VideoClip),
    id,
    audio: source.audio && audioInputs(cut.model) < MAX_AUDIO_CLIPS,
  };
  delete copy.transition;
  const next = [...clips.slice(0, at), copy, ...clips.slice(at)];
  return { model: { ...cut.model, clips: layout(next) }, id };
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
      room.push(max && max > 0 ? ms(max) - before.out_s : Number.POSITIVE_INFINITY);
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
