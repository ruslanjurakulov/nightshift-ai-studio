/**
 * The model edits behind the effects, crop, tilt and animation panels
 * (lib/editorFx.ts). What would break without these: a control that writes a
 * value the validator refuses (so Save fails after a click), an "off" value
 * left in the document (so a project that never used a control changes), a
 * change that is not the same model back when nothing changed (a phantom undo
 * step), a limit copied instead of imported.
 */
import { describe, expect, it } from "vitest";
import {
  ANGLE_MAX,
  ANIM_DEFAULT_S,
  ANIM_MAX_S,
  ANIM_MIN_S,
  BLUR_MAX,
  CROP_MIN,
  MAX_TYPEWRITER_TEXTS,
  XFADE_LARGE_BLUR_MAX,
  addClip,
  addText,
  newDocForAsset,
  setCrossfade,
  toDoc,
  toModel,
  updateText,
  validateTimeline,
  type EditorAsset,
  type EditorModel,
} from "@/lib/editor";
import { addOverlay, updateOverlay } from "@/lib/editorOverlay";
import {
  EFFECT_RANGES,
  animBlocked,
  animChoices,
  animOf,
  animRoom,
  canTypewriter,
  cropForAspect,
  cropOf,
  blurLimit,
  hasEffects,
  isCrossfaded,
  isLargeFrame,
  resetClipCrop,
  resetClipEffects,
  setClipAngle,
  setClipCrop,
  setClipCropShape,
  setClipEffect,
  setClipFilter,
  setClipFilterStrength,
  setClipFlip,
  setClipRotate,
  setOverlayAnim,
  setOverlayAnimSeconds,
  setTextAnim,
  setTextAnimSeconds,
  turnedAspect,
} from "@/lib/editorFx";

const A = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";
const VIDEO: EditorAsset = {
  id: A, kind: "video", name: "beach.mp4", durationS: 10, width: 1920, height: 1080,
  viewUrl: "/v", thumbUrl: null,
};
const PHOTO: EditorAsset = {
  id: P, kind: "image", name: "p.jpg", durationS: null, width: 1200, height: 800,
  viewUrl: "/p", thumbUrl: null,
};

const base = (): EditorModel => toModel(newDocForAsset(VIDEO)!);
const valid = (m: EditorModel) => expect(validateTimeline(toDoc(m))).toEqual([]);
const clip = (m: EditorModel) => m.clips[0];
const withText = (m = base()) => {
  const out = addText(m, 0, "Hello")!;
  return { model: out.model, id: out.id };
};
const withOverlay = (m = base()) => {
  const out = addOverlay(m, PHOTO, 0, () => false)!;
  return { model: out.model, id: out.id };
};

describe("looks and effects", () => {
  it("a look is set, keeps its strength across looks, and removing it removes both", () => {
    const m0 = base();
    const id = clip(m0).id;
    let m = setClipFilter(m0, id, "sepia");
    expect(clip(m).filter).toBe("sepia");
    m = setClipFilterStrength(m, id, 0.4);
    expect(clip(m).filter_strength).toBe(0.4);
    m = setClipFilter(m, id, "warm");
    expect(clip(m)).toMatchObject({ filter: "warm", filter_strength: 0.4 });
    valid(m);
    m = setClipFilter(m, id, null);
    expect(clip(m).filter).toBeUndefined();
    expect(clip(m).filter_strength).toBeUndefined();
    valid(m);
  });

  it("a strength of 1 is stored as nothing, and a strength without a look is refused", () => {
    const m0 = base();
    const id = clip(m0).id;
    expect(setClipFilterStrength(m0, id, 0.3)).toBe(m0);
    let m = setClipFilter(m0, id, "mono");
    m = setClipFilterStrength(m, id, 0.5);
    m = setClipFilterStrength(m, id, 1);
    expect(clip(m).filter_strength).toBeUndefined();
    expect(JSON.stringify(toDoc(m))).not.toContain("filter_strength");
    valid(m);
  });

  it("an unknown look is refused", () => {
    const m = base();
    expect(setClipFilter(m, clip(m).id, "glitter" as never)).toBe(m);
  });

  it("each effect is clamped to the document's own range and 0 removes it", () => {
    let m = base();
    const id = clip(m).id;
    for (const key of ["vignette", "blur", "sharpen", "grain"] as const) {
      m = setClipEffect(m, id, key, 9999);
      expect(clip(m)[key]).toBe(EFFECT_RANGES[key].max);
      m = setClipEffect(m, id, key, -5);
      expect(clip(m)[key]).toBeUndefined();
    }
    expect(EFFECT_RANGES.blur.max).toBe(BLUR_MAX);
    m = setClipEffect(m, id, "blur", Number.NaN);
    expect(clip(m).blur).toBeUndefined();
    m = setClipEffect(m, id, "grain", 0.3333333);
    expect(clip(m).grain).toBe(0.333);
    valid(m);
  });

  it("mirror and quarter turns toggle; other angles and non-numbers are refused", () => {
    let m = base();
    const id = clip(m).id;
    m = setClipFlip(m, id, "h", true);
    m = setClipFlip(m, id, "v", true);
    m = setClipRotate(m, id, 270);
    expect(clip(m)).toMatchObject({ flip_h: true, flip_v: true, rotate: 270 });
    valid(m);
    expect(setClipRotate(m, id, 45)).toBe(m);
    m = setClipFlip(m, id, "h", false);
    m = setClipRotate(m, id, 0);
    expect(clip(m).flip_h).toBeUndefined();
    expect(clip(m).rotate).toBeUndefined();
    expect(clip(m).flip_v).toBe(true);
  });

  it("changing nothing returns the same model (no phantom undo step)", () => {
    const m = base();
    const id = clip(m).id;
    expect(setClipFilter(m, id, null)).toBe(m);
    expect(setClipEffect(m, id, "blur", 0)).toBe(m);
    expect(setClipFlip(m, id, "h", false)).toBe(m);
    expect(setClipRotate(m, id, 0)).toBe(m);
    expect(resetClipEffects(m, id)).toBe(m);
    expect(setClipFilter(m, "nope", "mono")).toBe(m);
  });

  it("Remove all effects returns the document byte for byte", () => {
    const m0 = base();
    const before = JSON.stringify(toDoc(m0));
    const id = clip(m0).id;
    let m = setClipFilter(m0, id, "cinematic");
    m = setClipFilterStrength(m, id, 0.2);
    m = setClipEffect(m, id, "vignette", 0.6);
    m = setClipFlip(m, id, "v", true);
    m = setClipRotate(m, id, 90);
    expect(hasEffects(clip(m))).toBe(true);
    m = resetClipEffects(m, id);
    expect(hasEffects(clip(m))).toBe(false);
    expect(JSON.stringify(toDoc(m))).toBe(before);
  });

  it("effects survive the document round trip", () => {
    const m0 = base();
    const id = clip(m0).id;
    let m = setClipFilter(m0, id, "vintage");
    m = setClipEffect(m, id, "grain", 0.5);
    m = setClipRotate(m, id, 180);
    const back = toModel(toDoc(m));
    expect(clip(back)).toMatchObject({ filter: "vintage", grain: 0.5, rotate: 180 });
  });
});

describe("crop and the free angle", () => {
  it("a rectangle stays inside the picture and the sides keep their minimum", () => {
    let m = base();
    const id = clip(m).id;
    m = setClipCrop(m, id, { w: 0.5, h: 0.5 });
    m = setClipCrop(m, id, { x: 0.9 });
    expect(cropOf(clip(m))).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    m = setClipCrop(m, id, { w: 0.9 });
    // growing past the edge pulls the corner back; it does not leave the picture
    expect(cropOf(clip(m))).toEqual({ x: 0.1, y: 0, w: 0.9, h: 0.5 });
    m = setClipCrop(m, id, { w: 0 });
    expect(cropOf(clip(m)).w).toBe(CROP_MIN);
    valid(m);
  });

  it("the whole picture removes the field (the document is the one it was)", () => {
    const m0 = base();
    const before = JSON.stringify(toDoc(m0));
    const id = clip(m0).id;
    let m = setClipCrop(m0, id, { x: 0.25, w: 0.5 });
    expect(clip(m).crop).toBeDefined();
    m = setClipCrop(m, id, { x: 0, w: 1 });
    expect(clip(m).crop).toBeUndefined();
    expect(JSON.stringify(toDoc(m))).toBe(before);
    expect(resetClipCrop(m, id)).toBe(m);
  });

  it("a shape is the biggest centred rectangle of that aspect", () => {
    // 16:9 picture to a square: full height, a centred 9/16 width
    expect(cropForAspect(1, 16 / 9)).toEqual({ x: 0.219, y: 0, w: 0.563, h: 1 });
    // to 9:16
    const tall = cropForAspect(9 / 16, 16 / 9);
    expect(tall.h).toBe(1);
    expect(tall.w).toBe(0.316);
    // already that shape = the whole picture
    expect(cropForAspect(16 / 9, 16 / 9)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    // a wider shape than the picture crops the height
    expect(cropForAspect(2, 1)).toEqual({ x: 0, y: 0.25, w: 1, h: 0.5 });
    expect(cropForAspect(Number.NaN, 1)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("a shape needs the picture's size; none is the whole picture", () => {
    const m0 = base();
    const id = clip(m0).id;
    expect(setClipCropShape(m0, id, 1, null)).toBe(m0);
    const m = setClipCropShape(m0, id, 1, 16 / 9);
    expect(clip(m).crop).toEqual(cropForAspect(1, 16 / 9));
    valid(m);
    expect(clip(setClipCropShape(m, id, null, 16 / 9)).crop).toBeUndefined();
  });

  it("a quarter turn swaps the picture's sides for a shape", () => {
    expect(turnedAspect({}, { width: 1920, height: 1080 })).toBeCloseTo(16 / 9);
    expect(turnedAspect({ rotate: 90 }, { width: 1920, height: 1080 })).toBeCloseTo(9 / 16);
    expect(turnedAspect({ rotate: 180 }, { width: 1920, height: 1080 })).toBeCloseTo(16 / 9);
    expect(turnedAspect({}, { width: null, height: null })).toBeNull();
    expect(turnedAspect({}, null)).toBeNull();
  });

  it("the angle is clamped to the document's range, one decimal, 0 removes it", () => {
    let m = base();
    const id = clip(m).id;
    m = setClipAngle(m, id, 500);
    expect(clip(m).angle).toBe(ANGLE_MAX);
    m = setClipAngle(m, id, -500);
    expect(clip(m).angle).toBe(-ANGLE_MAX);
    m = setClipAngle(m, id, 12.34);
    expect(clip(m).angle).toBe(12.3);
    valid(m);
    m = setClipAngle(m, id, 0);
    expect(clip(m).angle).toBeUndefined();
    expect(setClipAngle(m, id, Number.NaN)).toBe(m);
  });
});

describe("entrance and exit animations", () => {
  it("a picture gets the six animations (no typewriter); a text gets the typewriter too", () => {
    expect(animChoices(false, "in")).not.toContain("typewriter");
    expect(animChoices(true, "in")).toContain("typewriter");
    expect(animChoices(true, "out")).not.toContain("typewriter");
    expect(animChoices(false, "out")).toEqual(animChoices(false, "in"));
  });

  it("a new animation starts at the default length; it is stored and valid", () => {
    const { model, id } = withOverlay();
    const m = setOverlayAnim(model, id, "in", "slide-up");
    expect(animOf(m.overlays![0], "in")).toEqual({ anim: "slide-up", seconds: ANIM_DEFAULT_S });
    valid(m);
    expect(setOverlayAnim(m, id, "in", "slide-up")).toBe(m);
    expect(setOverlayAnim(m, id, "in", "typewriter")).toBe(m);
    expect(setOverlayAnim(m, id, "in", "spin")).toBe(m);
    const gone = setOverlayAnim(m, id, "in", null);
    expect(gone.overlays![0].anim_in).toBeUndefined();
    expect(gone.overlays![0].anim_in_s).toBeUndefined();
  });

  it("the length is clamped and never leaves less than the minimum; no animation, no length", () => {
    const { model, id } = withOverlay();
    expect(setOverlayAnimSeconds(model, id, "in", 1)).toBe(model);
    let m = setOverlayAnim(model, id, "out", "fade");
    m = setOverlayAnimSeconds(m, id, "out", 99);
    expect(animOf(m.overlays![0], "out").seconds).toBe(ANIM_MAX_S);
    m = setOverlayAnimSeconds(m, id, "out", 0);
    expect(animOf(m.overlays![0], "out").seconds).toBe(ANIM_MIN_S);
    valid(m);
  });

  it("entrance and exit never add up to more than the time shown", () => {
    const o0 = withOverlay();
    const id = o0.id;
    let model = o0.model;
    model = updateOverlay(model, id, { start_s: 0, end_s: 0.5 });
    model = setOverlayAnim(model, id, "in", "pop");
    expect(animOf(model.overlays![0], "in").seconds).toBe(0.4);
    // 0.1 s left for the exit: allowed, at the room there is
    expect(animRoom(model.overlays![0], "out")).toBe(0.1);
    model = setOverlayAnim(model, id, "out", "fade");
    expect(animOf(model.overlays![0], "out").seconds).toBe(0.1);
    valid(model);
    // lengthening the entrance is capped by what the exit leaves
    model = setOverlayAnimSeconds(model, id, "in", 2);
    expect(animOf(model.overlays![0], "in").seconds).toBe(0.4);
    valid(model);
  });

  it("a side with no time left is blocked, with the reason decided by the numbers", () => {
    const o0 = withOverlay();
    const id = o0.id;
    let model = o0.model;
    model = updateOverlay(model, id, { start_s: 0, end_s: 0.3 });
    model = setOverlayAnim(model, id, "in", "fade");
    expect(animOf(model.overlays![0], "in").seconds).toBe(0.3);
    expect(animBlocked(model.overlays![0], "out")).toBe(true);
    expect(setOverlayAnim(model, id, "out", "fade")).toBe(model);
    expect(animBlocked(model.overlays![0], "in")).toBe(false);
  });

  it("shortening the item shortens its animations with it (the document stays valid)", () => {
    const o0 = withOverlay();
    const id = o0.id;
    let model = o0.model;
    model = setOverlayAnim(setOverlayAnim(model, id, "in", "fade"), id, "out", "fade");
    model = setOverlayAnimSeconds(model, id, "in", 1);
    model = updateOverlay(model, id, { end_s: model.overlays![0].start_s + 1 });
    const o = model.overlays![0];
    expect(animOf(o, "in").seconds + animOf(o, "out").seconds).toBeLessThanOrEqual(1);
    valid(model);
    // too short for both: the exit goes, the entrance stays
    model = updateOverlay(model, id, { end_s: o.start_s + 0.15 });
    expect(model.overlays![0].anim_out).toBeUndefined();
    expect(animOf(model.overlays![0], "in").seconds).toBeLessThanOrEqual(0.15);
    valid(model);
  });

  it("a text: the animation replaces that side's plain fade", () => {
    const { model, id } = withText();
    const faded: EditorModel = {
      ...model,
      texts: model.texts.map((t) => ({ ...t, fade_in_s: 0.5, fade_out_s: 0.5 })),
    };
    const m = setTextAnim(faded, id, "in", "slide-left");
    expect(m.texts[0]).toMatchObject({ anim_in: "slide-left", anim_in_s: 0.4, fade_out_s: 0.5 });
    expect((m.texts[0] as { fade_in_s?: number }).fade_in_s).toBeUndefined();
    valid(m);
  });

  it("shortening a text shortens its animation (updateText)", () => {
    const { model, id } = withText();
    let m = setTextAnim(setTextAnim(model, id, "in", "typewriter"), id, "out", "pop");
    m = setTextAnimSeconds(m, id, "in", 1);
    m = updateText(m, id, { end_s: m.texts[0].start_s + 0.6 });
    valid(m);
  });

  it("the typewriter is limited per project and an owner of one keeps it", () => {
    let m = base();
    const ids: string[] = [];
    for (let i = 0; i < MAX_TYPEWRITER_TEXTS + 1; i += 1) {
      const out = addText(m, 0, `t${i}`)!;
      m = out.model;
      ids.push(out.id);
    }
    for (let i = 0; i < MAX_TYPEWRITER_TEXTS; i += 1) m = setTextAnim(m, ids[i], "in", "typewriter");
    expect(m.texts.filter((t) => t.anim_in === "typewriter")).toHaveLength(MAX_TYPEWRITER_TEXTS);
    expect(canTypewriter(m, ids[MAX_TYPEWRITER_TEXTS])).toBe(false);
    expect(canTypewriter(m, ids[0])).toBe(true);
    expect(setTextAnim(m, ids[MAX_TYPEWRITER_TEXTS], "in", "typewriter")).toBe(m);
    valid(m);
    // another entrance is still fine for the 21st
    expect(setTextAnim(m, ids[MAX_TYPEWRITER_TEXTS], "in", "fade")).not.toBe(m);
  });
});

describe("an animation on one side and a plain fade on the other (the document counts the fade)", () => {
  it("the room for an animation is what the other side's fade leaves", () => {
    const { model, id } = withText();
    const faded: EditorModel = { ...model, texts: model.texts.map((t) => ({ ...t, start_s: 0, end_s: 1, fade_out_s: 0.95 }) as typeof t) };
    const t = faded.texts[0];
    expect(animRoom(t, "in")).toBeCloseTo(0.05);
    expect(animBlocked(t, "in")).toBe(true);
    expect(setTextAnim(faded, id, "in", "fade")).toBe(faded);
    const roomy: EditorModel = { ...faded, texts: faded.texts.map((x) => ({ ...x, fade_out_s: 0.5 }) as typeof x) };
    const m = setTextAnim(roomy, id, "in", "slide-up");
    expect(animOf(m.texts[0], "in").seconds).toBe(0.4);
    valid(m);
    // the entrance is shortened to what the fade leaves
    const tight: EditorModel = { ...faded, texts: faded.texts.map((x) => ({ ...x, fade_out_s: 0.7 }) as typeof x) };
    const t2 = setTextAnim(tight, id, "in", "pop");
    expect(animOf(t2.texts[0], "in").seconds).toBe(0.3);
    valid(t2);
  });

  it("shortening a text with an entrance and a plain fade keeps both inside the time shown", () => {
    const { model, id } = withText();
    let m: EditorModel = { ...model, texts: model.texts.map((t) => ({ ...t, start_s: 0, end_s: 3, fade_out_s: 0.5 }) as typeof t) };
    m = setTextAnim(m, id, "in", "slide-left");
    m = setTextAnimSeconds(m, id, "in", 2);
    valid(m);
    m = updateText(m, id, { end_s: 1.2 });
    valid(m);
    expect(animOf(m.texts[0], "in").seconds).toBeLessThanOrEqual(0.7);
    // too short for any animation next to the fade: the animation goes, the fade stays
    m = updateText(m, id, { end_s: 0.55 });
    valid(m);
    expect(m.texts[0].anim_in).toBeUndefined();
    expect((m.texts[0] as { fade_out_s?: number }).fade_out_s).toBe(0.5);
  });
});

describe("blur on a cross-faded clip in a frame above 1440p", () => {
  const twoClips = (width: number, height: number, fade = true): EditorModel => {
    let m = addClip(base(), VIDEO);
    m = { ...m, width, height };
    return fade ? setCrossfade(m, m.clips[1].id, 1) : m;
  };
  it("the document's own limits decide it", () => {
    expect(XFADE_LARGE_BLUR_MAX).toBe(0);
    expect(isLargeFrame({ width: 3840, height: 2160 })).toBe(true);
    expect(isLargeFrame({ width: 1920, height: 1080 })).toBe(false);
    expect(isLargeFrame({ width: 2160, height: 3840 })).toBe(true);
  });
  it("either side of the blend takes no blur; a cut, another clip or a smaller frame does", () => {
    const m = twoClips(3840, 2160);
    const [a, b] = m.clips;
    expect(isCrossfaded(m, a.id)).toBe(true);
    expect(isCrossfaded(m, b.id)).toBe(true);
    expect(blurLimit(m, a.id)).toBe(0);
    expect(setClipEffect(m, a.id, "blur", 12)).toBe(m);
    expect(setClipEffect(m, b.id, "blur", 12)).toBe(m);
    const cut = twoClips(3840, 2160, false);
    expect(blurLimit(cut, cut.clips[0].id)).toBe(EFFECT_RANGES.blur.max);
    expect(clip(setClipEffect(cut, cut.clips[0].id, "blur", 12)).blur).toBe(12);
    const small = twoClips(1920, 1080);
    expect(blurLimit(small, small.clips[0].id)).toBe(EFFECT_RANGES.blur.max);
    const three = addClip(m, VIDEO);
    expect(isCrossfaded(three, three.clips[2].id)).toBe(false);
    expect(blurLimit(three, three.clips[2].id)).toBe(EFFECT_RANGES.blur.max);
  });
});
