/**
 * The model edits behind the chroma key, sound clean-up and stabilise controls
 * (lib/editorClean.ts) and the preview's arithmetic for the key
 * (lib/editorChromaPreview.ts). What would break without these: a control that
 * writes what the validator refuses, a limit copied instead of imported, a
 * "default" left in the document, a preview that keys by a different rule than
 * the export's `chromakey` (chroma distance, blend ramp), a budget that is not
 * the document's.
 */
import { describe, expect, it } from "vitest";
import {
  CHROMA_BLEND_DEFAULT,
  CHROMA_BLEND_MAX,
  CHROMA_SIMILARITY_DEFAULT,
  CHROMA_SIMILARITY_MAX,
  CHROMA_SIMILARITY_MIN,
  STABILIZE_MAX_DOC_S,
  STABILIZE_MAX_S,
  addClip,
  addSound,
  newDocForAsset,
  toDoc,
  toModel,
  validateTimeline,
  type EditorAsset,
  type EditorModel,
} from "@/lib/editor";
import { addOverlay } from "@/lib/editorOverlay";
import { setClipFreeze, trimLimited } from "@/lib/editorMotion";
import {
  CHROMA_COLORS,
  chromaOf,
  setChromaAmount,
  setChromaColor,
  setClipClean,
  setClipStabilize,
  setOverlayChroma,
  setSoundClean,
  stabilizeCheck,
  startChroma,
} from "@/lib/editorClean";
import {
  ALPHA_STEPS,
  SQUARE_STEPS,
  chromaSpec,
  keyedAlpha,
  keyChroma,
  parseHex,
} from "@/lib/editorChromaPreview";

const A = "11111111-1111-4111-8111-111111111111";
const P = "33333333-3333-4333-8333-333333333333";
const S = "44444444-4444-4444-8444-444444444444";
const VIDEO: EditorAsset = { id: A, kind: "video", name: "v", durationS: 300, width: 1920, height: 1080, viewUrl: "/v", thumbUrl: null };
const PHOTO: EditorAsset = { id: P, kind: "image", name: "p", durationS: null, width: 400, height: 200, viewUrl: "/p", thumbUrl: null };
const SOUND: EditorAsset = { id: S, kind: "audio", name: "s", durationS: 20, width: null, height: null, viewUrl: "/s", thumbUrl: null };
const base = (): EditorModel => toModel(newDocForAsset(VIDEO)!);
const valid = (m: EditorModel) => expect(validateTimeline(toDoc(m))).toEqual([]);
const withOverlay = () => {
  const out = addOverlay(base(), PHOTO, 0, () => false)!;
  return { model: out.model, id: out.id };
};
const withRange = (m: EditorModel, id: string, range: number): EditorModel => ({
  ...m,
  clips: m.clips.map((c) => (c.id === id ? { ...c, out_s: c.in_s + range } : c)),
});

describe("chroma key", () => {
  it("turning it on is green with the document's own softness stored as nothing; off removes it", () => {
    const { model, id } = withOverlay();
    const on = startChroma(model, id);
    expect(on.overlays![0].chroma).toEqual({ color: CHROMA_COLORS.green });
    expect(chromaOf(on.overlays![0])).toEqual({
      color: "#00FF00",
      similarity: CHROMA_SIMILARITY_DEFAULT,
      blend: CHROMA_BLEND_DEFAULT,
    });
    valid(on);
    expect(startChroma(on, id)).toBe(on);
    const off = setOverlayChroma(on, id, null);
    expect(off.overlays![0].chroma).toBeUndefined();
    expect(JSON.stringify(toDoc(off))).toBe(JSON.stringify(toDoc(model)));
    expect(setOverlayChroma(off, id, null)).toBe(off);
  });

  it("the colour is #RRGGBB in any case, stored upper case; anything else is refused", () => {
    const { model, id } = withOverlay();
    const on = startChroma(model, id);
    const blue = setChromaColor(on, id, "#0a1b2c");
    expect(blue.overlays![0].chroma!.color).toBe("#0A1B2C");
    for (const bad of ["red", "#12345", "#1234567", "00FF00", "#GG0000", ""]) expect(setChromaColor(on, id, bad)).toBe(on);
    expect(setChromaColor(blue, id, "#0A1B2C")).toBe(blue);
    // no colour set while the key is off
    expect(setChromaColor(model, id, "#00FF00")).toBe(model);
    valid(blue);
  });

  it("similarity and softness are clamped to the document's ranges; a default is not stored", () => {
    const { model, id } = withOverlay();
    let m = startChroma(model, id);
    m = setChromaAmount(m, id, "similarity", 9);
    expect(m.overlays![0].chroma!.similarity).toBe(CHROMA_SIMILARITY_MAX);
    m = setChromaAmount(m, id, "similarity", 0);
    expect(m.overlays![0].chroma!.similarity).toBe(CHROMA_SIMILARITY_MIN);
    m = setChromaAmount(m, id, "blend", 9);
    expect(m.overlays![0].chroma!.blend).toBe(CHROMA_BLEND_MAX);
    m = setChromaAmount(m, id, "blend", -2);
    expect(m.overlays![0].chroma!.blend).toBe(0);
    valid(m);
    m = setChromaAmount(m, id, "similarity", CHROMA_SIMILARITY_DEFAULT);
    m = setChromaAmount(m, id, "blend", CHROMA_BLEND_DEFAULT);
    expect(m.overlays![0].chroma).toEqual({ color: "#00FF00" });
    expect(setChromaAmount(m, id, "blend", Number.NaN)).toBe(m);
    expect(setChromaAmount(model, id, "blend", 0.2)).toBe(model);
  });

  it("the key survives the document round trip", () => {
    const { model, id } = withOverlay();
    let m = startChroma(model, id);
    m = setChromaAmount(setChromaColor(m, id, "#0000ff"), id, "similarity", 0.35);
    expect(toModel(toDoc(m)).overlays![0].chroma).toEqual({ color: "#0000FF", similarity: 0.35 });
  });
});

describe("the preview keys by the export's rule (chromakey)", () => {
  it("is a filter for a valid colour only", () => {
    expect(chromaSpec({ color: "nope" })).toBeNull();
    const spec = chromaSpec({ color: "#00FF00" })!;
    expect(spec.square.split(" ")).toHaveLength(SQUARE_STEPS);
    expect(spec.alpha.split(" ")).toHaveLength(ALPHA_STEPS);
    expect(spec.toDistance.split(" ")).toHaveLength(20);
    expect(spec.sum.split(" ")).toHaveLength(20);
    expect(parseHex("#FF8000")).toEqual([1, 128 / 255, 0]);
    expect(parseHex("FF8000")).toBeNull();
  });

  it("the key colour itself is gone, a very different colour stays", () => {
    const key = { color: "#00FF00" };
    expect(keyedAlpha(key, "#00FF00")).toBe(0);
    expect(keyedAlpha(key, "#FF0000")).toBe(1);
    expect(keyedAlpha(key, "#0000FF")).toBe(1);
    // a darker green is less saturated, so it sits further from the key but is still mostly keyed
    expect(keyedAlpha(key, "#008000")).toBeLessThan(0.3);
    // grey is not green
    expect(keyedAlpha(key, "#808080")).toBe(1);
    expect(keyedAlpha({ color: "#0000FF" }, "#0000FF")).toBe(0);
  });

  it("similarity widens what goes; blend softens the edge; zero blend is a hard edge", () => {
    const px = "#40C040"; // a green a little off the key
    const tight = keyedAlpha({ color: "#00FF00", similarity: 0.01, blend: 0.1 }, px);
    const loose = keyedAlpha({ color: "#00FF00", similarity: 0.6, blend: 0.1 }, px);
    expect(loose).toBeLessThan(tight);
    expect(loose).toBe(0);
    const hard = keyedAlpha({ color: "#00FF00", similarity: 0.1, blend: 0 }, px);
    expect([0, 1]).toContain(hard);
    const soft = keyedAlpha({ color: "#00FF00", similarity: 0.05, blend: 0.5 }, "#20E020");
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThan(1);
  });

  it("the SVG pipeline (matrix, squares, sum, alpha table) gives the same alpha as the definition", () => {
    const interp = (table: string, x: number) => {
      const v = table.split(" ").map(Number);
      const f = Math.min(1, Math.max(0, x)) * (v.length - 1);
      const i = Math.min(v.length - 2, Math.floor(f));
      return v[i] + (v[i + 1] - v[i]) * (f - i);
    };
    const run = (spec: NonNullable<ReturnType<typeof chromaSpec>>, hex: string) => {
      const [r, g, b] = parseHex(hex)!;
      const m = spec.toDistance.split(" ").map(Number);
      const row = (k: number) => Math.min(1, Math.max(0, m[k * 5] * r + m[k * 5 + 1] * g + m[k * 5 + 2] * b + m[k * 5 + 4]));
      const sq = interp(spec.square, row(0)) * 0.5 + interp(spec.square, row(1)) * 0.5;
      return interp(spec.alpha, sq);
    };
    for (const chroma of [
      { color: "#00FF00" },
      { color: "#0000FF", similarity: 0.3, blend: 0.2 },
      { color: "#22AA33", similarity: 0.12, blend: 0 },
    ]) {
      const spec = chromaSpec(chroma)!;
      for (const px of ["#00FF00", "#20D030", "#FF0000", "#808080", "#3030FF", "#FFFFFF", "#102010"]) {
        expect(run(spec, px), `${chroma.color} ${px}`).toBeCloseTo(keyedAlpha(chroma, px), 1);
      }
    }
    expect(keyChroma([0, 1, 0])[0]).toBeCloseTo(-0.331264);
  });
});

describe("sound clean-up", () => {
  it("is set and removed on a clip's own sound and on a music clip; off removes the field", () => {
    const m0 = base();
    const id = m0.clips[0].id;
    let m = setClipClean(m0, id, "denoise", true);
    m = setClipClean(m, id, "loudnorm", true);
    expect(m.clips[0]).toMatchObject({ denoise: true, loudnorm: true });
    valid(m);
    m = setClipClean(setClipClean(m, id, "denoise", false), id, "loudnorm", false);
    expect(JSON.stringify(toDoc(m))).toBe(JSON.stringify(toDoc(m0)));
    expect(setClipClean(m0, id, "denoise", false)).toBe(m0);
    expect(setClipClean(m0, "nope", "denoise", true)).toBe(m0);
    const s = addSound(m0, SOUND, 0)!;
    let ms = setSoundClean(s.model, s.id, "loudnorm", true);
    expect(ms.sounds[0].loudnorm).toBe(true);
    expect(toModel(toDoc(ms)).sounds[0].loudnorm).toBe(true);
    valid(ms);
    ms = setSoundClean(ms, s.id, "loudnorm", false);
    expect(ms.sounds[0].loudnorm).toBeUndefined();
    expect(setSoundClean(ms, s.id, "denoise", false)).toBe(ms);
  });
});

describe("stabilise", () => {
  it("is allowed within the document's per-clip range and refused past it, with the numbers", () => {
    const m = base();
    const id = m.clips[0].id;
    const ok = withRange(m, id, STABILIZE_MAX_S);
    expect(stabilizeCheck(ok, ok.clips[0])).toMatchObject({ ok: true, range: STABILIZE_MAX_S, used: 0 });
    const on = setClipStabilize(ok, id, true);
    expect(on.clips[0].stabilize).toBe(true);
    valid(on);
    const long = withRange(m, id, STABILIZE_MAX_S + 1);
    expect(stabilizeCheck(long, long.clips[0])).toMatchObject({ ok: false, reason: "clip_range", range: STABILIZE_MAX_S + 1 });
    expect(setClipStabilize(long, id, true)).toBe(long);
    expect(setClipStabilize(on, id, true)).toBe(on);
    const off = setClipStabilize(on, id, false);
    expect(off.clips[0].stabilize).toBeUndefined();
    expect(JSON.stringify(toDoc(off))).toBe(JSON.stringify(toDoc(ok)));
  });

  it("the project's total is shared; a frozen frame cannot be steadied", () => {
    let m = withRange(base(), "c1", STABILIZE_MAX_S);
    m = setClipStabilize(m, "c1", true);
    for (let i = 0; i < 2; i += 1) {
      m = addClip(m, VIDEO);
      const last = m.clips[m.clips.length - 1];
      m = withRange(m, last.id, STABILIZE_MAX_S);
      if (i === 0) m = setClipStabilize(m, last.id, true);
    }
    // two clips use 2 x STABILIZE_MAX_S of STABILIZE_MAX_DOC_S
    expect(STABILIZE_MAX_DOC_S).toBeGreaterThan(2 * STABILIZE_MAX_S);
    const third = m.clips[2];
    const r = stabilizeCheck(m, third);
    const left = STABILIZE_MAX_DOC_S - 2 * STABILIZE_MAX_S;
    expect(r).toMatchObject({ ok: false, reason: "doc_budget", used: 2 * STABILIZE_MAX_S });
    const shorter = withRange(m, third.id, left);
    expect(stabilizeCheck(shorter, shorter.clips[2]).ok).toBe(true);
    const frozen = setClipFreeze(withRange(base(), "c1", 4), "c1", true);
    expect(stabilizeCheck(frozen, frozen.clips[0])).toMatchObject({ ok: false, reason: "freeze" });
    expect(setClipStabilize(frozen, "c1", true)).toBe(frozen);
  });

  it("trimming a steadied clip stops at the per-clip range and at what the project has left", () => {
    let m = withRange(base(), "c1", 100);
    m = setClipStabilize(m, "c1", true);
    const t = trimLimited(m, "c1", "out", 250, 300);
    expect(t.clips[0].out_s).toBe(STABILIZE_MAX_S);
    valid(t);
    // freezing it takes the steadiness off (the document refuses both)
    const f = setClipFreeze(m, "c1", true);
    expect(f.clips[0].stabilize).toBeUndefined();
  });
});
