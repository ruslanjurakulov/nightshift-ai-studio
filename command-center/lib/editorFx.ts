/**
 * The editor's clip effects, crop, free-angle turn and entrance / exit
 * animations: the pure model edits behind the panels (the render engine's
 * fields are in docs/editor-render-fields.md, sections 2, 3 and 8).
 *
 * Every function returns the SAME model when nothing changes (so it is not an
 * undo step), clamps to the document's own limits (imported from lib/editor.ts,
 * never copied) and REMOVES a field that is back at "off", so a project that
 * never used a control keeps exactly the document it had. The validators
 * (validateTimeline here, modules/timeline.py in the worker) stay the judge:
 * nothing here is the only line of defence.
 */
import {
  ANGLE_MAX,
  ANIM_DEFAULT_S,
  ANIM_IN,
  ANIM_MAX_S,
  ANIM_MIN_S,
  ANIM_OUT,
  BLUR_MAX,
  CROP_DEFAULTS,
  CROP_MIN,
  FILTERS,
  MAX_TYPEWRITER_TEXTS,
  ROTATIONS,
  clamp,
  fitAnims,
  ms,
  type AnimIn,
  type AnimOut,
  type ClipCrop,
  type ClipFilter,
  type EditorModel,
  type PictureOverlay,
  type Rotation,
  type TextClip,
  type VideoClip,
} from "@/lib/editor";

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const finite = (v: number, d: number) => (Number.isFinite(v) ? v : d);

/** The model with clip `id` rewritten by `f` (the same model back when `f`
 *  returns the clip it was given). */
function withClip(
  model: EditorModel,
  id: string,
  f: (c: VideoClip) => VideoClip,
): EditorModel {
  const at = model.clips.find((c) => c.id === id);
  if (!at) return model;
  const next = f(at);
  if (next === at) return model;
  return { ...model, clips: model.clips.map((c) => (c.id === id ? next : c)) };
}

/** A copy of the clip without the given optional fields. */
function without<K extends keyof VideoClip>(c: VideoClip, ...keys: K[]): VideoClip {
  const out = { ...c };
  for (const k of keys) delete out[k];
  return out;
}

// ── entrance / exit animations (texts and overlays) ─────────────────────────

export type AnimSide = "in" | "out";

/** What an item can be given an animation on: a text or an overlay. */
type Animated = {
  start_s: number;
  end_s: number;
  anim_in?: AnimIn;
  anim_out?: AnimOut;
  anim_in_s?: number;
  anim_out_s?: number;
};

/** The animations a text (with `typewriter` on entrance) or a picture has. */
export function animChoices(text: boolean, side: AnimSide): readonly string[] {
  return side === "in" ? (text ? ANIM_IN : ANIM_OUT) : ANIM_OUT;
}

/** The chosen animation of one side (null = none) and its length in seconds. */
export function animOf(
  item: Animated,
  side: AnimSide,
): { anim: AnimIn | null; seconds: number } {
  const anim = (side === "in" ? item.anim_in : item.anim_out) ?? null;
  const s = side === "in" ? item.anim_in_s : item.anim_out_s;
  return { anim, seconds: anim ? (s ?? ANIM_DEFAULT_S) : 0 };
}

/** How long the item is on screen. */
export function shownFor(item: Pick<Animated, "start_s" | "end_s">): number {
  return ms(item.end_s - item.start_s);
}

/** The most seconds this side's animation may last: what is left of the time
 *  the item is shown after the other side's animation (0 when none is left). */
export function animRoom(item: Animated, side: AnimSide): number {
  const other = animOf(item, side === "in" ? "out" : "in").seconds;
  return Math.max(0, ms(Math.min(ANIM_MAX_S, shownFor(item) - other)));
}

/** True when this side has no animation and there is no time to add one (the
 *  other side already takes all but less than ANIM_MIN_S of the time shown). */
export function animBlocked(item: Animated, side: AnimSide): boolean {
  return !animOf(item, side).anim && animRoom(item, side) < ANIM_MIN_S - 1e-9;
}

/** Texts (other than `exceptId`) that write themselves letter by letter. */
export function typewriterCount(model: EditorModel, exceptId?: string): number {
  return model.texts.filter(
    (t) => t.id !== exceptId && t.anim_in === "typewriter",
  ).length;
}

/** Can a text be given the typewriter entrance (a document has at most
 *  MAX_TYPEWRITER_TEXTS of them)? A text that has it already always can. */
export function canTypewriter(model: EditorModel, textId: string): boolean {
  return typewriterCount(model, textId) < MAX_TYPEWRITER_TEXTS;
}

/** One item with its animation on `side` set (`null` removes it). Refused (the
 *  same item back) for a name the item does not have or when there is no time
 *  left. A new animation starts at the default length, shortened to fit.
 *  On a text, an animation REPLACES that side's plain fade (a fade IS an
 *  animation; the document refuses both). */
function withAnim<T extends Animated & { fade_in_s?: number; fade_out_s?: number }>(
  item: T,
  side: AnimSide,
  anim: string | null,
  text: boolean,
): T {
  const key = side === "in" ? "anim_in" : "anim_out";
  const secKey = side === "in" ? "anim_in_s" : "anim_out_s";
  const fadeKey = side === "in" ? "fade_in_s" : "fade_out_s";
  const now = animOf(item, side).anim;
  if (anim === null) {
    if (!now) return item;
    const next = { ...item };
    delete next[key];
    delete next[secKey];
    return next;
  }
  if (!animChoices(text, side).includes(anim)) return item;
  if (now === anim) return item;
  const room = animRoom(item, side);
  if (room < ANIM_MIN_S - 1e-9) return item;
  const seconds = now
    ? Math.min(animOf(item, side).seconds, room)
    : Math.min(ANIM_DEFAULT_S, room);
  const next = { ...item, [key]: anim, [secKey]: ms(seconds) } as T;
  if (text) delete next[fadeKey];
  return next;
}

function withAnimSeconds<T extends Animated>(
  item: T,
  side: AnimSide,
  seconds: number,
): T {
  const { anim, seconds: now } = animOf(item, side);
  if (!anim) return item;
  const room = Math.max(ANIM_MIN_S, animRoom(item, side));
  const s = ms(clamp(finite(seconds, now), ANIM_MIN_S, Math.min(ANIM_MAX_S, room)));
  if (s === now && (side === "in" ? item.anim_in_s : item.anim_out_s) === s) return item;
  return { ...item, [side === "in" ? "anim_in_s" : "anim_out_s"]: s };
}

function mapText(
  model: EditorModel,
  id: string,
  f: (t: TextClip) => TextClip,
): EditorModel {
  const at = model.texts.find((t) => t.id === id);
  if (!at) return model;
  const next = f(at);
  if (next === at) return model;
  return { ...model, texts: model.texts.map((t) => (t.id === id ? next : t)) };
}

function mapOverlay(
  model: EditorModel,
  id: string,
  f: (o: PictureOverlay) => PictureOverlay,
): EditorModel {
  const at = (model.overlays ?? []).find((o) => o.id === id);
  if (!at) return model;
  const next = f(at);
  if (next === at) return model;
  return {
    ...model,
    overlays: (model.overlays ?? []).map((o) => (o.id === id ? next : o)),
  };
}

export function setTextAnim(
  model: EditorModel,
  id: string,
  side: AnimSide,
  anim: string | null,
): EditorModel {
  if (anim === "typewriter" && !canTypewriter(model, id)) return model;
  return mapText(model, id, (t) => withAnim(t, side, anim, true));
}

export function setTextAnimSeconds(
  model: EditorModel,
  id: string,
  side: AnimSide,
  seconds: number,
): EditorModel {
  return mapText(model, id, (t) => withAnimSeconds(t, side, seconds));
}

export function setOverlayAnim(
  model: EditorModel,
  id: string,
  side: AnimSide,
  anim: string | null,
): EditorModel {
  return mapOverlay(model, id, (o) => withAnim(o, side, anim, false));
}

export function setOverlayAnimSeconds(
  model: EditorModel,
  id: string,
  side: AnimSide,
  seconds: number,
): EditorModel {
  return mapOverlay(model, id, (o) => withAnimSeconds(o, side, seconds));
}

export { fitAnims };

// ── looks and effects ───────────────────────────────────────────────────────

export type EffectKey = "vignette" | "blur" | "sharpen" | "grain";
export const EFFECT_KEYS: readonly EffectKey[] = [
  "vignette",
  "blur",
  "sharpen",
  "grain",
];

/** Each effect's range (the document's own: 0 to 1, a blur's sigma 0 to
 *  BLUR_MAX) and the slider's step. 0 is "off". */
export const EFFECT_RANGES: Record<EffectKey, { min: number; max: number; step: number }> = {
  vignette: { min: 0, max: 1, step: 0.05 },
  blur: { min: 0, max: BLUR_MAX, step: 1 },
  sharpen: { min: 0, max: 1, step: 0.05 },
  grain: { min: 0, max: 1, step: 0.05 },
};

/** A look's strength range (1 = fully the look; the document keeps nothing for 1). */
export const STRENGTH_STEP = 0.05;

export function filterOf(clip: Pick<VideoClip, "filter">): ClipFilter | null {
  return clip.filter ?? null;
}

export function strengthOf(clip: Pick<VideoClip, "filter" | "filter_strength">): number {
  return clip.filter ? (clip.filter_strength ?? 1) : 0;
}

export function effectOf(clip: Partial<Record<EffectKey, number>>, key: EffectKey): number {
  return clip[key] ?? 0;
}

/** Any effect, look, mirror or turn set on the clip? */
export function hasEffects(clip: VideoClip): boolean {
  return Boolean(
    clip.filter ||
      EFFECT_KEYS.some((k) => (clip[k] ?? 0) > 0) ||
      clip.flip_h ||
      clip.flip_v ||
      clip.rotate,
  );
}

/** Choose a named look (null = none). A first choice is at full strength; the
 *  strength of the look in use is kept when another look is picked. */
export function setClipFilter(
  model: EditorModel,
  id: string,
  filter: ClipFilter | null,
): EditorModel {
  return withClip(model, id, (c) => {
    if (filter === null) {
      return c.filter === undefined && c.filter_strength === undefined
        ? c
        : without(c, "filter", "filter_strength");
    }
    if (!(FILTERS as readonly string[]).includes(filter) || c.filter === filter)
      return c;
    return { ...c, filter };
  });
}

/** How far toward the look (0 to 1). Needs a look; 1 is stored as nothing. */
export function setClipFilterStrength(
  model: EditorModel,
  id: string,
  strength: number,
): EditorModel {
  return withClip(model, id, (c) => {
    if (!c.filter) return c;
    const s = round3(clamp(finite(strength, 1), 0, 1));
    if (s === (c.filter_strength ?? 1)) return c;
    return s === 1 ? without(c, "filter_strength") : { ...c, filter_strength: s };
  });
}

/** Set one effect (vignette, blur, sharpen, grain); 0 removes it. */
export function setClipEffect(
  model: EditorModel,
  id: string,
  key: EffectKey,
  value: number,
): EditorModel {
  const r = EFFECT_RANGES[key];
  return withClip(model, id, (c) => {
    const v = round3(clamp(finite(value, 0), r.min, r.max));
    if (v === (c[key] ?? 0)) return c;
    return v === 0 ? without(c, key) : { ...c, [key]: v };
  });
}

export function setClipFlip(
  model: EditorModel,
  id: string,
  axis: "h" | "v",
  on: boolean,
): EditorModel {
  const key = axis === "h" ? "flip_h" : "flip_v";
  return withClip(model, id, (c) => {
    if (Boolean(c[key]) === on) return c;
    return on ? { ...c, [key]: true } : without(c, key);
  });
}

/** Turn the source a quarter, half or three quarters clockwise (0 = none). */
export function setClipRotate(
  model: EditorModel,
  id: string,
  degrees: number,
): EditorModel {
  if (!(ROTATIONS as readonly number[]).includes(degrees)) return model;
  const r = degrees as Rotation;
  return withClip(model, id, (c) => {
    if ((c.rotate ?? 0) === r) return c;
    return r === 0 ? without(c, "rotate") : { ...c, rotate: r };
  });
}

/** Every look and effect off (mirror and quarter turn too). */
export function resetClipEffects(model: EditorModel, id: string): EditorModel {
  return withClip(model, id, (c) =>
    hasEffects(c)
      ? without(
          c,
          "filter",
          "filter_strength",
          "vignette",
          "blur",
          "sharpen",
          "grain",
          "flip_h",
          "flip_v",
          "rotate",
        )
      : c,
  );
}

// ── crop and free angle ─────────────────────────────────────────────────────

export type CropRect = { x: number; y: number; w: number; h: number };
export const CROP_STEP = 0.01;

/** A clip's crop with the document's defaults filled in (the whole picture). */
export function cropOf(clip: Pick<VideoClip, "crop">): CropRect {
  return { ...CROP_DEFAULTS, ...(clip.crop as ClipCrop | undefined) };
}

export function isWholePicture(c: CropRect): boolean {
  return c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1;
}

/**
 * Change the crop rectangle. Sizes stay in CROP_MIN..1 and the rectangle inside
 * the picture: a bigger `w` or `h` pulls the corner back instead of leaving the
 * picture; a moved corner stops at the edge. The whole picture removes the
 * field. `patch.w` / `patch.h` keep the rectangle's top-left where it was.
 */
export function setClipCrop(
  model: EditorModel,
  id: string,
  patch: Partial<CropRect>,
): EditorModel {
  return withClip(model, id, (c) => {
    const now = cropOf(c);
    const w = round3(clamp(finite(patch.w ?? now.w, now.w), CROP_MIN, 1));
    const h = round3(clamp(finite(patch.h ?? now.h, now.h), CROP_MIN, 1));
    const x = round3(clamp(finite(patch.x ?? now.x, now.x), 0, 1 - w));
    const y = round3(clamp(finite(patch.y ?? now.y, now.y), 0, 1 - h));
    const next = { x, y, w, h };
    if (next.x === now.x && next.y === now.y && next.w === now.w && next.h === now.h)
      return c;
    return isWholePicture(next) ? without(c, "crop") : { ...c, crop: next };
  });
}

export function resetClipCrop(model: EditorModel, id: string): EditorModel {
  return withClip(model, id, (c) => (c.crop ? without(c, "crop") : c));
}

/** The aspect (width / height) of a clip's picture once turned: a quarter turn
 *  swaps the sides. null when the file's size is not known. */
export function turnedAspect(
  clip: Pick<VideoClip, "rotate">,
  source: { width: number | null; height: number | null } | null | undefined,
): number | null {
  if (!source?.width || !source?.height) return null;
  const a = source.width / source.height;
  return clip.rotate === 90 || clip.rotate === 270 ? 1 / a : a;
}

/** The biggest rectangle of the given aspect (width / height, in pixels),
 *  centred, inside a picture whose own aspect is `picture`, as fractions of it. */
export function cropForAspect(aspect: number, picture: number): CropRect {
  if (!(aspect > 0) || !(picture > 0)) return { ...CROP_DEFAULTS };
  if (aspect >= picture) {
    const h = round3(picture / aspect);
    return { x: 0, y: round3((1 - h) / 2), w: 1, h };
  }
  const w = round3(aspect / picture);
  return { x: round3((1 - w) / 2), y: 0, w, h: 1 };
}

/** Crop to a shape (a centred rectangle of that aspect). null shape = whole picture.
 *  The same model back when the picture's size is unknown. */
export function setClipCropShape(
  model: EditorModel,
  id: string,
  aspect: number | null,
  picture: number | null,
): EditorModel {
  if (aspect === null) return resetClipCrop(model, id);
  if (picture === null) return model;
  return setClipCrop(model, id, cropForAspect(aspect, picture));
}

export function angleOf(clip: Pick<VideoClip, "angle">): number {
  return clip.angle ?? 0;
}

/** Turn the fitted picture in the frame, degrees clockwise, -ANGLE_MAX..ANGLE_MAX
 *  to one decimal; 0 removes it. */
export function setClipAngle(
  model: EditorModel,
  id: string,
  degrees: number,
): EditorModel {
  return withClip(model, id, (c) => {
    const a = Math.round(clamp(finite(degrees, 0), -ANGLE_MAX, ANGLE_MAX) * 10) / 10;
    if (a === (c.angle ?? 0)) return c;
    return a === 0 ? without(c, "angle") : { ...c, angle: a };
  });
}
