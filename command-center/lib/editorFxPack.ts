/**
 * The effects pack (glitch, shake, RGB split, flash), a video clip's entrance and exit animations, and "apply
 * this cross-fade to all cuts": the model operations the editor's panels call. The document fields, limits and
 * validators are lib/editor.ts (`fx`, `anim_in` / `anim_out`; modules/timeline.py has the same rules); the
 * export draws them with ffmpeg (modules/render_backend.py `fx_filters`, `anim_filters`).
 */
import {
  ANIM_DEFAULT_S,
  ANIM_MAX_S,
  ANIM_MIN_S,
  FX_LARGE_XFADE_MAX,
  FX_MAX,
  FX_NAMES,
  XFADE_MIN_S,
  clamp,
  clipLength,
  crossfadeOf,
  crossfadeStyleOf,
  layout,
  maxCrossfade,
  ms,
  setCrossfade,
  setCrossfadeStyle,
  type EditorModel,
  type FxName,
  type VideoAnim,
  type VideoClip,
} from "@/lib/editor";
import { isCrossfaded, isLargeFrame } from "@/lib/editorFx";

function withClip(model: EditorModel, id: string, f: (c: VideoClip) => VideoClip): EditorModel {
  return { ...model, clips: model.clips.map((c) => (c.id === id ? f(c) : c)) };
}

export function fxValue(c: Pick<VideoClip, "fx">, k: FxName): number {
  return c.fx?.[k] ?? 0;
}

export function hasFx(c: Pick<VideoClip, "fx">): boolean {
  return FX_NAMES.some((k) => fxValue(c, k) > 0);
}

/** One effect's intensity (0..FX_MAX, whole numbers); 0 removes it, and no effect is no field. */
export function setClipFx(model: EditorModel, id: string, k: FxName, v: number): EditorModel {
  const n = Number.isFinite(v) ? Math.round(clamp(v, 0, FX_MAX)) : 0;
  return withClip(model, id, (c) => {
    const fx = { ...c.fx, [k]: n };
    const kept = Object.fromEntries(FX_NAMES.filter((x) => (fx[x] ?? 0) > 0).map((x) => [x, fx[x]!]));
    const out = { ...c };
    if (Object.keys(kept).length) out.fx = kept;
    else delete out.fx;
    return out;
  });
}

/** May this clip take one more effect? In a frame above 1440p a cross-faded clip takes FX_LARGE_XFADE_MAX. */
export function fxSlotsLeft(model: EditorModel, c: VideoClip): number {
  if (!(isLargeFrame(model) && isCrossfaded(model, c.id))) return FX_NAMES.length;
  return Math.max(0, FX_LARGE_XFADE_MAX - FX_NAMES.filter((k) => fxValue(c, k) > 0).length);
}

/** The longest animation a clip can take on one side: half the clip, within ANIM_MIN_S..ANIM_MAX_S. */
export function animMaxS(c: VideoClip): number {
  return Math.min(ANIM_MAX_S, Math.floor((clipLength(c) / 2) * 1000) / 1000);
}

/** Can this side be animated? Not over the clip's own fade on that side, nor on a clip under 2 x ANIM_MIN_S. */
export type AnimProblem = "fade" | "short";
export function animProblem(c: VideoClip, side: "in" | "out"): AnimProblem | null {
  if (animMaxS(c) < ANIM_MIN_S) return "short";
  if ((side === "in" ? c.fade_in_s : c.fade_out_s) ?? 0) return "fade";
  return null;
}

/** Set (or remove, with null) one side's animation; its length is kept, held to half the clip. */
export function setClipAnim(model: EditorModel, id: string, side: "in" | "out", anim: VideoAnim | null): EditorModel {
  return withClip(model, id, (c) => {
    const out = { ...c };
    const name = `anim_${side}` as const;
    const dur = `anim_${side}_s` as const;
    if (!anim) {
      delete out[name];
      delete out[dur];
      return out;
    }
    if (animProblem(c, side)) return c;
    out[name] = anim;
    out[dur] = ms(clamp(c[dur] ?? ANIM_DEFAULT_S, ANIM_MIN_S, animMaxS(c)));
    return out;
  });
}

export function setClipAnimLength(model: EditorModel, id: string, side: "in" | "out", s: number): EditorModel {
  return withClip(model, id, (c) => {
    const name = `anim_${side}` as const;
    if (!c[name] || !Number.isFinite(s)) return c;
    return { ...c, [`anim_${side}_s`]: ms(clamp(s, ANIM_MIN_S, animMaxS(c))) };
  });
}

/**
 * Give every cut the cross-fade clip `id` has into it (its length and style), each held to what its two clips
 * allow (`maxCrossfade`); a cut with no room for the shortest cross-fade keeps what it had. Returns how many
 * cuts changed. One edit: the caller applies it as one undo step (and the editor settles it after).
 */
export function applyCrossfadeToAll(model: EditorModel, id: string): { model: EditorModel; changed: number } {
  const from = model.clips.find((c) => c.id === id);
  const d = from ? crossfadeOf(from) : 0;
  if (!from || !(d > 0)) return { model, changed: 0 };
  const style = crossfadeStyleOf(from);
  let m: EditorModel = { ...model, clips: layout(model.clips) };
  let changed = 0;
  for (const c of m.clips.slice(1)) {
    if (c.id === id) continue;
    const max = maxCrossfade(m, c.id);
    if (!(max >= XFADE_MIN_S)) continue;
    const before = m.clips.find((x) => x.id === c.id)!;
    let next = setCrossfade(m, c.id, Math.min(d, max));
    next = setCrossfadeStyle(next, c.id, style);
    const after = next.clips.find((x) => x.id === c.id)!;
    if (crossfadeOf(after) !== crossfadeOf(before) || crossfadeStyleOf(after) !== crossfadeStyleOf(before)) changed += 1;
    m = next;
  }
  return { model: m, changed };
}
