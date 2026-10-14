/**
 * What the preview draws for the clip effects, turn / mirror / crop / angle and
 * the entrance / exit animations (lib/editorFxPreview.ts). The export is the
 * reference; these tests pin the arithmetic the browser is given: the look
 * curves are the export's (samples/clip_look_curves.json, which
 * tests/test_editor_look_preview.py pins the Python side to), the stage places
 * the picture as the export does (turn, mirror, crop, fit, free angle), and an
 * animation is at rest outside its window. Nothing here is a browser pixel.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILTERS } from "@/lib/editor";
import {
  ANIM_REST,
  LOOK_CURVES,
  LOOK_FILTER_ID,
  POP_FROM,
  SEPIA_MATRIX,
  SLIDE_SHARE,
  TABLE_STEPS,
  animFrame,
  blurLength,
  curveAt,
  curveTable,
  hasLook,
  lookSpec,
  moveStyle,
  moveWindowAt,
  needsStage,
  playsNatively,
  previewFilterStyle,
  sepiaValues,
  stageLayout,
  vignetteStyle,
  writtenText,
} from "@/lib/editorFxPreview";
import { GRADE_FILTER_ID } from "@/lib/editorGrade";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "samples", "clip_look_curves.json"), "utf8"),
) as { curves: Record<string, Record<string, number[][]>>; sepia: number[][] };

describe("the look curves are the export's", () => {
  it("the preview's table is the shared fixture, point for point", () => {
    expect(JSON.parse(JSON.stringify(LOOK_CURVES))).toEqual(fixture.curves);
    expect(JSON.parse(JSON.stringify(SEPIA_MATRIX))).toEqual(fixture.sepia);
  });

  it("every look of the document is drawn: mono, sepia and the curve looks", () => {
    const names = [...Object.keys(fixture.curves), "mono", "sepia"].sort();
    expect([...FILTERS].sort()).toEqual(names);
    for (const f of FILTERS) {
      const spec = lookSpec(f, 1);
      expect(["saturate", "matrix", "tables"]).toContain(spec.kind);
    }
  });

  it("strength 0 is the identity and strength 1 reaches the look's own points", () => {
    for (const [name, chans] of Object.entries(LOOK_CURVES)) {
      for (const pts of Object.values(chans)) {
        for (const [x, y] of pts!) {
          expect(curveAt(pts!, 0, x)).toBeCloseTo(x, 9);
          expect(curveAt(pts!, 1, x)).toBeCloseTo(y, 9);
          expect(curveAt(pts!, 0.5, x)).toBeCloseTo((x + y) / 2, 9);
        }
      }
      void name;
    }
  });

  it("a table has the steps an SVG filter wants and stays between 0 and 1", () => {
    for (const f of ["vintage", "cinematic", "cool", "warm", "high-contrast"] as const) {
      const spec = lookSpec(f, 0.7);
      if (spec.kind !== "tables") throw new Error("curve look");
      for (const t of [spec.r, spec.g, spec.b]) {
        const v = t.split(" ").map(Number);
        expect(v).toHaveLength(TABLE_STEPS);
        expect(v.every((n) => n >= 0 && n <= 1)).toBe(true);
      }
    }
    // a channel the look does not touch is the identity ramp
    const cool = lookSpec("cool", 1);
    if (cool.kind !== "tables") throw new Error("tables");
    expect(cool.g).toBe(curveTable(undefined, 1));
    expect(cool.g.split(" ")[0]).toBe("0");
    expect(cool.g.split(" ").at(-1)).toBe("1");
  });

  it("mono removes colour by its strength; sepia moves the identity toward the classic matrix", () => {
    expect(lookSpec("mono", 1)).toEqual({ kind: "saturate", value: "0" });
    expect(lookSpec("mono", 0.25)).toEqual({ kind: "saturate", value: "0.75" });
    expect(sepiaValues(0).split(" ").slice(0, 3)).toEqual(["1", "0", "0"]);
    const full = sepiaValues(1).split(" ").map(Number);
    expect(full.slice(0, 3)).toEqual([0.393, 0.769, 0.189]);
    expect(full).toHaveLength(20);
  });
});

describe("the picture's CSS filter", () => {
  it("is empty for a clip with no colour, look or blur, so its element is as it was", () => {
    expect(previewFilterStyle({}, 1920)).toEqual({});
    expect(previewFilterStyle(null, 1920)).toEqual({});
    expect(previewFilterStyle({ filter: "mono", filter_strength: 0 }, 1920)).toEqual({});
    expect(previewFilterStyle({ blur: 0 }, 1920)).toEqual({});
  });

  it("keeps the Colour panel's filter as it was when only colour is set", () => {
    expect(
      previewFilterStyle({ grade: { brightness: 0.2, contrast: 1, saturation: 1 } }, 1920),
    ).toEqual({ filter: `url(#${GRADE_FILTER_ID})` });
  });

  it("is colour, then the look, then the blur - the export's order", () => {
    const f = previewFilterStyle(
      { grade: { brightness: 0.2, contrast: 1, saturation: 1 }, filter: "warm", blur: 12 },
      1200,
    ).filter as string;
    expect(f).toBe(`url(#${GRADE_FILTER_ID}) url(#${LOOK_FILTER_ID}) blur(1cqw)`);
  });

  it("a blur is a share of the frame's width, so it scales with the preview", () => {
    expect(blurLength(30, 1080)).toBe("2.778cqw");
    expect(blurLength(30, 1920)).toBe("1.563cqw");
    expect(blurLength(999, 1000)).toBe("3cqw");
  });

  it("hasLook needs a look and a strength above 0", () => {
    expect(hasLook({})).toBe(false);
    expect(hasLook({ filter: "sepia" })).toBe(true);
    expect(hasLook({ filter: "sepia", filter_strength: 0 })).toBe(false);
  });

  it("the vignette is a shade that grows with its strength", () => {
    const a = vignetteStyle(0.2).background as string;
    const b = vignetteStyle(1).background as string;
    expect(a).toContain("rgba(0,0,0,0.17)");
    expect(b).toContain("rgba(0,0,0,0.85)");
  });
});

describe("the stage: turn, mirror, crop, fit, free angle", () => {
  const wide = { width: 1920, height: 1080 };
  const tall = { width: 1080, height: 1920 };
  const src = { width: 1920, height: 1080 };

  it("a clip with none of them needs no stage (it is drawn as it always was)", () => {
    expect(needsStage({})).toBe(false);
    expect(needsStage({ fit: "cover" })).toBe(false);
    expect(needsStage({ crop: { x: 0, y: 0, w: 1, h: 1 } })).toBe(false);
    expect(needsStage({ rotate: 90 })).toBe(true);
    expect(needsStage({ flip_h: true })).toBe(true);
    expect(needsStage({ flip_v: true })).toBe(true);
    expect(needsStage({ angle: 5 })).toBe(true);
    expect(needsStage({ crop: { w: 0.5 } })).toBe(true);
    expect(needsStage(null)).toBe(false);
  });

  it("a landscape clip turned a quarter is fitted as a portrait picture (the frame's own shape here)", () => {
    const s = stageLayout({ rotate: 90 }, tall, src, false);
    expect(s.fit.width).toBe("100%");
    expect(s.fit.height).toBe("100%");
    // the media's box is swapped: its width is the turned picture's height
    expect(s.media.width).toBe("177.778%");
    expect(s.media.height).toBe("56.25%");
    expect(s.media.transform).toBe("translate(-50%, -50%) rotate(90deg)");
  });

  it("the same turned clip in a wide frame gets side bars", () => {
    const s = stageLayout({ rotate: 270 }, wide, src, false);
    // turned shape 9:16 inside 16:9: full height, 31.6% of the width
    expect(s.fit.height).toBe("100%");
    expect(s.fit.width).toBe("31.641%");
    expect(s.media.transform).toContain("rotate(270deg)");
  });

  it("filling (cover, and always for a picture) overscans the frame; bars do not", () => {
    const contain = stageLayout({ rotate: 90 }, wide, src, false);
    const cover = stageLayout({ rotate: 90, fit: "cover" }, wide, src, false);
    expect(cover.fit.width).toBe("100%");
    expect(cover.fit.height).toBe("100%");
    // a 9:16 picture filling a 16:9 frame is 3.16x taller than the frame
    expect(cover.crop.width).toBe("100%");
    expect(cover.crop.height).toBe("316.049%");
    expect(contain.fit.width).not.toBe("100%");
    const still = stageLayout({ fit: "contain", flip_h: true }, wide, { width: 600, height: 600 }, true);
    expect(still.fit.width).toBe("100%");
    expect(still.crop.height).not.toBe("100%");
  });

  it("mirror applies after the turn, about the picture's centre", () => {
    const s = stageLayout({ rotate: 90, flip_h: true, flip_v: true }, tall, src, false);
    expect(s.media.transform).toBe("translate(-50%, -50%) scaleX(-1) scaleY(-1) rotate(90deg)");
  });

  it("a crop is placed so its window lands on the box: the whole turned picture shifted and scaled", () => {
    // crop a 16:9 clip to the middle square: the kept window is 0.5625 wide, full height
    const s = stageLayout({ crop: { x: 0.21875, y: 0, w: 0.5625, h: 1 } }, wide, src, false);
    // the cropped part is square, so with bars it is a square box in the wide frame
    expect(s.fit.height).toBe("100%");
    expect(s.fit.width).toBe("56.25%");
    expect(s.turned.width).toBe("177.778%");
    expect(s.turned.height).toBe("100%");
    expect(s.turned.left).toBe("-38.889%");
    expect(s.turned.top).toBe("0%");
  });

  it("the free angle turns the fitted picture about the frame's centre, after the fit", () => {
    const s = stageLayout({ angle: -12.5 }, wide, src, false);
    expect(s.fit.transform).toBe("translate(-50%, -50%) rotate(-12.5deg)");
    const none = stageLayout({}, wide, src, false);
    expect(none.fit.transform).toBe("translate(-50%, -50%)");
  });

  it("an unknown file size is taken to have the frame's shape (it still draws)", () => {
    const s = stageLayout({ flip_h: true }, wide, null, false);
    expect(s.fit.width).toBe("100%");
    expect(s.fit.height).toBe("100%");
  });
});

describe("the entrance and exit at a moment", () => {
  const item = { start_s: 10, end_s: 14, anim_in: "slide-up", anim_in_s: 1, anim_out: "fade", anim_out_s: 1 };

  it("an item with no animation, and an item between its entrance and exit, is at rest", () => {
    expect(animFrame({ start_s: 0, end_s: 4 }, 0)).toEqual(ANIM_REST);
    expect(animFrame(item, 12)).toEqual(ANIM_REST);
  });

  it("slide-up enters from below: starts offset down by the slide share and fully transparent", () => {
    const a = animFrame(item, 10);
    expect(a.opacity).toBe(0);
    expect(a.dy).toBeCloseTo(SLIDE_SHARE);
    expect(a.dx).toBe(0);
    const mid = animFrame(item, 10.5);
    expect(mid.opacity).toBeCloseTo(0.5);
    expect(mid.dy).toBeCloseTo(SLIDE_SHARE / 2);
    expect(animFrame(item, 11)).toEqual(ANIM_REST);
  });

  it("each slide comes from the side its name moves away from", () => {
    const at = (kind: string) => animFrame({ start_s: 0, end_s: 4, anim_in: kind, anim_in_s: 1 }, 0);
    expect(at("slide-up").dy).toBeGreaterThan(0);
    expect(at("slide-down").dy).toBeLessThan(0);
    expect(at("slide-left").dx).toBeGreaterThan(0);
    expect(at("slide-right").dx).toBeLessThan(0);
  });

  it("the exit leaves toward the name's direction and ends transparent", () => {
    const out = (kind: string, t: number) =>
      animFrame({ start_s: 0, end_s: 4, anim_out: kind, anim_out_s: 1 }, t);
    expect(out("slide-up", 4).dy).toBeCloseTo(-SLIDE_SHARE);
    expect(out("slide-down", 4).dy).toBeCloseTo(SLIDE_SHARE);
    expect(out("slide-left", 4).dx).toBeCloseTo(-SLIDE_SHARE);
    expect(out("slide-right", 4).dx).toBeCloseTo(SLIDE_SHARE);
    expect(out("fade", 4).opacity).toBe(0);
    expect(out("fade", 3.5).opacity).toBeCloseTo(0.5);
  });

  it("pop grows from its starting share and shrinks back", () => {
    const pop = { start_s: 0, end_s: 4, anim_in: "pop", anim_in_s: 1, anim_out: "pop", anim_out_s: 1 };
    expect(animFrame(pop, 0).scale).toBeCloseTo(POP_FROM);
    expect(animFrame(pop, 1).scale).toBe(1);
    expect(animFrame(pop, 4).scale).toBeCloseTo(POP_FROM);
  });

  it("a typewriter reports how much is written and does not fade", () => {
    const tw = { start_s: 0, end_s: 4, anim_in: "typewriter", anim_in_s: 2 };
    expect(animFrame(tw, 0).written).toBe(0);
    expect(animFrame(tw, 0).opacity).toBe(1);
    expect(animFrame(tw, 1).written).toBeCloseTo(0.5);
    expect(animFrame(tw, 2).written).toBeNull();
    expect(writtenText("Hello", 0)).toBe("");
    expect(writtenText("Hello", 0.5)).toBe("Hel");
    expect(writtenText("Hello", null)).toBe("Hello");
    expect(writtenText("Hi 👋!", 0.7)).toBe("Hi 👋");
  });

  it("the default length is used when none is stored", () => {
    const a = animFrame({ start_s: 0, end_s: 4, anim_in: "fade" }, 0.2);
    expect(a.opacity).toBeCloseTo(0.5);
  });
});

describe("zoom and pan, blurred fit and playback in the preview", () => {
  const wide = { width: 1920, height: 1080 };
  const src = { width: 1920, height: 1080 };

  it("a move or a blurred fit needs the stage (a photo has no blurred fit)", () => {
    expect(needsStage({ move: { from: { zoom: 1 }, to: { zoom: 2 } } })).toBe(true);
    expect(needsStage({ fit: "blur" })).toBe(true);
    expect(needsStage({ fit: "blur" }, true)).toBe(false);
    expect(needsStage({ fit: "cover" })).toBe(false);
  });

  it("the blurred fit draws the picture whole over a frame-filling blurred copy", () => {
    const s = stageLayout({ fit: "blur" }, { width: 1080, height: 1920 }, src, false);
    // the frame is the visible region; the picture is the contained box in the middle
    expect(s.fit.width).toBe("100%");
    expect(s.fit.height).toBe("100%");
    expect(s.crop.width).toBe("100%");
    expect(s.crop.height).toBe("31.641%");
    // the backdrop fills the frame, is a little bigger and is blurred by a share of the frame's width
    expect(s.backdrop).toBeTruthy();
    expect(s.backdrop!.crop.height).toBe("100%");
    expect(s.backdrop!.crop.transform).toContain("scale(1.12)");
    expect(s.backdrop!.blur.filter).toBe("blur(2.222cqw)");
    // a clip with another fit has no backdrop
    expect(stageLayout({ fit: "cover" }, wide, src, false).backdrop).toBeUndefined();
    expect(stageLayout({ fit: "blur" }, wide, src, true).backdrop).toBeUndefined();
  });

  it("a move is a straight line between its windows, centre held inside the picture", () => {
    const m = { from: { zoom: 1, x: 0.5, y: 0.5 }, to: { zoom: 2, x: 0.25, y: 0.5 } };
    expect(moveWindowAt(m, 0)).toEqual({ zoom: 1, x: 0.5, y: 0.5 });
    expect(moveWindowAt(m, 1)).toEqual({ zoom: 2, x: 0.25, y: 0.5 });
    const mid = moveWindowAt(m, 0.5);
    expect(mid.zoom).toBeCloseTo(1.5);
    expect(mid.x).toBeCloseTo(0.375);
    // at 2x the window cannot be centred nearer than 0.25 to an edge
    expect(moveWindowAt({ from: m.from, to: { zoom: 2, x: 0, y: 1 } }, 1)).toEqual({ zoom: 2, x: 0.25, y: 0.75 });
    // out-of-range progress is the nearest end; missing numbers are the document's defaults
    expect(moveWindowAt(m, 9).zoom).toBe(2);
    expect(moveWindowAt(m, Number.NaN).zoom).toBe(1);
    expect(moveWindowAt({ from: {}, to: {} }, 0.5)).toEqual({ zoom: 1, x: 0.5, y: 0.5 });
  });

  it("the move's transform maps the window's corner to the frame's corner", () => {
    expect(moveStyle(undefined, 0.5)).toEqual({});
    // zoom 2 on the left half: window left = 0 -> no shift, scale 2
    const left = moveStyle({ from: { zoom: 2, x: 0, y: 0 }, to: { zoom: 2, x: 0, y: 0 } }, 0);
    expect(left.transform).toBe("translate(0%, 0%) scale(2)");
    expect(left.transformOrigin).toBe("0 0");
    // zoom 2 centred: the window starts at 0.25 of the frame, so the picture shifts left by 0.5 of the frame
    const mid = moveStyle({ from: { zoom: 2 }, to: { zoom: 2 } }, 0);
    expect(mid.transform).toBe("translate(-50%, -50%) scale(2)");
  });

  it("only forward, constant-speed clips play in the video element itself", () => {
    expect(playsNatively({})).toBe(true);
    expect(playsNatively(null)).toBe(true);
    expect(playsNatively({ reverse: true })).toBe(false);
    expect(playsNatively({ freeze: true })).toBe(false);
    expect(playsNatively({ speed_curve: [{ at: 0, speed: 1 }, { at: 1, speed: 2 }] })).toBe(false);
  });
});
