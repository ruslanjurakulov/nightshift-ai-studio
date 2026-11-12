/**
 * Editor parity 2b (model half): the effects pack and a video clip's entrance / exit (lib/editor.ts, lib/editorFxPack.ts),
 * "apply this cross-fade to all cuts", the settle steps for them, and beat markers (lib/editorBeats.ts). What would
 * break without these: the editor and the worker disagreeing on a document (samples/timeline_parity2b_fuzz.json is
 * judged by both), a control writing what the validator refuses, a split leaving the entrance on both halves, a 4K
 * cross-fade that runs the export out of memory, or beats that miss the beat.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANIM_DEFAULT_S,
  ANIM_MOVE_SECONDS_PER_S,
  FX_NAMES,
  FX_SECONDS_PER_S,
  V_ANIMS,
  crossfadeOf,
  crossfadeStyleOf,
  lookSeconds,
  newDocForAsset,
  setCrossfade,
  setCrossfadeStyle,
  setSpeed,
  splitClip,
  trimClip,
  toDoc,
  toModel,
  validateTimeline,
  type EditorModel,
  type VideoClip,
} from "@/lib/editor";
import {
  animMaxS,
  animProblem,
  applyCrossfadeToAll,
  fxSlotsLeft,
  hasFx,
  setClipAnim,
  setClipAnimLength,
  setClipFx,
} from "@/lib/editorFxPack";
import { settleAll } from "@/lib/editorSettle";
import { renderWork } from "@/lib/editorMotion";
import { beatTimes, detectBeats, energyDb, BEAT_BLOCK_S } from "@/lib/editorBeats";
import { snapTargets } from "@/lib/editor-timeline-view";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const ROOT = join(__dirname, "..", "..");
const A = "11111111-1111-4111-8111-111111111111";
const model = (clip: Partial<VideoClip> = {}, durationS = 10): EditorModel => {
  const m = toModel(newDocForAsset({ id: A, durationS, width: 1920, height: 1080 })!);
  return { ...m, clips: m.clips.map((c) => ({ ...c, ...clip })) };
};
const c0 = (m: EditorModel) => m.clips[0];
const three = (): EditorModel => {
  const m = model({}, 6);
  return { ...m, clips: [c0(m), { ...c0(m), id: "c8", start_s: 6 }, { ...c0(m), id: "c9", start_s: 12, out_s: 0.3 }] };
};

describe("both validators agree on the seeded fuzz of effects and animations", () => {
  const corpus = JSON.parse(readFileSync(join(ROOT, "samples", "timeline_parity2b_fuzz.json"), "utf8")) as {
    cases: { valid: boolean; doc: unknown }[];
  };
  it("judges every document as modules/timeline.py did", () => {
    expect(corpus.cases.length).toBe(400);
    const wrong = corpus.cases
      .map((c, i) => ({ i, py: c.valid, ts: validateTimeline(c.doc).length === 0, why: validateTimeline(c.doc) }))
      .filter((x) => x.py !== x.ts);
    expect(wrong).toEqual([]);
  });
});

describe("the numbers are modules/timeline.py's", () => {
  const py = readFileSync(join(ROOT, "modules", "timeline.py"), "utf8");
  it("names, costs and lists", () => {
    expect(py).toContain(`FX_NAMES = (${FX_NAMES.map((n) => `"${n}"`).join(", ")})`);
    expect(py).toContain(`V_ANIMS = (${V_ANIMS.map((n) => `"${n}"`).join(", ")})`);
    expect(py).toContain(
      `FX_SECONDS_PER_S = {${FX_NAMES.map((n) => `"${n}": ${FX_SECONDS_PER_S[n]}`).join(", ")}}`,
    );
    expect(py).toContain(`ANIM_MOVE_SECONDS_PER_S = ${ANIM_MOVE_SECONDS_PER_S}`);
  });
  it("each effect and a slide or zoom is charged per second; a fade is not", () => {
    const c = { in_s: 0, out_s: 10, speed: 1, fx: { glitch: 10, flash: 90 }, anim_in: "zoom" } as unknown as VideoClip;
    expect(lookSeconds(c, 30, 1920, 1080)).toBeCloseTo(10 * (0.35 + 0.1 + 0.3), 6);
    expect(lookSeconds({ ...c, anim_in: "fade" }, 30, 1920, 1080)).toBeCloseTo(10 * 0.45, 6);
  });
});

describe("the effects pack", () => {
  it("writes whole numbers 0..100 and zero is no field", () => {
    let m = model();
    const id = c0(m).id;
    m = setClipFx(m, id, "glitch", 140);
    m = setClipFx(m, id, "shake", 33.4);
    expect(c0(m).fx).toEqual({ glitch: 100, shake: 33 });
    expect(validateTimeline(toDoc(m))).toEqual([]);
    expect(c0(toModel(toDoc(m))).fx).toEqual({ glitch: 100, shake: 33 });
    m = setClipFx(setClipFx(m, id, "glitch", 0), id, "shake", 0);
    expect("fx" in c0(m)).toBe(false);
    expect(hasFx(c0(m))).toBe(false);
    expect(toDoc(m)).toEqual(toDoc(model()));
  });

  it("above 1440p a cross-faded clip has one slot, and settling keeps its strongest effect", () => {
    const m0 = three();
    let m = setCrossfade({ ...m0, width: 3840, height: 2160 }, "c8", 0.5);
    expect(fxSlotsLeft(m, c0(m))).toBe(1);
    expect(fxSlotsLeft(m, m.clips[2])).toBe(4);
    m = { ...m, clips: m.clips.map((c) => (c.id === "c8" ? { ...c, fx: { shake: 20, flash: 90 } } : c)) };
    expect(validateTimeline(toDoc(m)).join(" ")).toContain("takes at most 1 effect");
    const { model: out, changes } = settleAll(m);
    expect(changes).toContainEqual({ kind: "fxLarge", clip: 2 });
    expect(out.clips[1].fx).toEqual({ flash: 90 });
    expect(validateTimeline(toDoc(out))).toEqual([]);
  });

  it("over the export's time, settling takes a clip's effects and moves off with its colour", () => {
    const m0 = model({ fx: { rgb_split: 100, glitch: 100 }, anim_in: "zoom", anim_in_s: 0.4 }, 600);
    expect(validateTimeline(toDoc(m0))).toEqual([]);
    const { model: out, changes } = settleAll({ ...m0, width: 3840, height: 2160, fps: 60 }, m0);
    expect(changes).toContainEqual({ kind: "look", clip: 1 });
    expect(c0(out).fx).toBeUndefined();
    expect(c0(out).anim_in).toBeUndefined();
    expect(renderWork(out).ok).toBe(true);
  });
});

describe("a clip's entrance and exit", () => {
  it("names from the list, lengths held to half the clip, not over the clip's own fade", () => {
    let m = model({}, 3);
    const id = c0(m).id;
    m = setClipAnim(m, id, "in", "slide-left");
    expect(c0(m)).toMatchObject({ anim_in: "slide-left", anim_in_s: ANIM_DEFAULT_S });
    m = setClipAnimLength(m, id, "in", 9);
    expect(c0(m).anim_in_s).toBe(1.5);
    expect(animMaxS(c0(m))).toBe(1.5);
    m = setClipAnim(m, id, "out", "zoom");
    expect(validateTimeline(toDoc(m))).toEqual([]);
    expect(c0(toModel(toDoc(m)))).toMatchObject({ anim_in: "slide-left", anim_in_s: 1.5, anim_out: "zoom" });
    const faded = model({ fade_out_s: 0.5 }, 3);
    expect(animProblem(c0(faded), "out")).toBe("fade");
    expect(setClipAnim(faded, c0(faded).id, "out", "zoom")).toEqual(faded);
    expect(animProblem({ ...c0(model({}, 0.15)) }, "in")).toBe("short");
    expect("anim_in" in c0(setClipAnim(m, id, "in", null))).toBe(false);
  });

  it("a split keeps the way in on the first half and the way out on the second, each fitted", () => {
    const m = setClipAnim(setClipAnimLength(setClipAnim(model({}, 4), "c1", "in", "zoom"), "c1", "in", 1.5), "c1", "out", "fade");
    const id = c0(m).id;
    const r = splitClip(m, id, 1)!;
    const [a, b] = r.model.clips;
    expect([a.anim_in, a.anim_in_s, a.anim_out]).toEqual(["zoom", 0.5, undefined]);
    expect([b.anim_in, b.anim_out]).toEqual([undefined, "fade"]);
    expect(validateTimeline(toDoc(r.model))).toEqual([]);
  });
});

describe("settling a clip's animations after a trim or a speed change", () => {
  it("holds them to half the clip, drops one under 0.1 s, and says so; a document that fits is untouched", () => {
    const m0 = setClipAnimLength(setClipAnim(setClipAnim(model({}, 4), "c1", "in", "zoom"), "c1", "out", "fade"), "c1", "in", 1.5);
    expect(settleAll(m0).changes).toEqual([]);
    const id = c0(m0).id;
    const sped = setSpeed(m0, id, 2); // 2 s long now: half is 1 s
    const { model: out, changes } = settleAll(sped, m0);
    expect(changes).toContainEqual({ kind: "anim", clip: 1 });
    expect(c0(out)).toMatchObject({ anim_in: "zoom", anim_in_s: 1, anim_out: "fade" });
    expect(validateTimeline(toDoc(out))).toEqual([]);
    const tiny = settleAll(trimClip(m0, id, "out", 0.15, null), m0).model; // 0.15 s: half is under 0.1 s
    expect(c0(tiny).anim_in).toBeUndefined();
    expect(validateTimeline(toDoc(tiny))).toEqual([]);
  });

  it("a backwards clip shortened to the reverse cap keeps its animation inside it (the review's case)", () => {
    const m0 = model({ reverse: true, out_s: 4, anim_in: "zoom", anim_in_s: 2 }, 10);
    expect(validateTimeline(toDoc(m0))).toEqual([]);
    const { model: out } = settleAll({ ...m0, width: 3840, height: 2160 }, m0);
    expect(c0(out).out_s).toBeLessThan(4);
    expect(c0(out).anim_in_s).toBeLessThanOrEqual(c0(out).out_s / 2);
    expect(validateTimeline(toDoc(out))).toEqual([]);
  });

  it("reversed clips with animations settle to a valid document in every frame", () => {
    let seed = 680;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const frames: [number, number, number][] = [[1280, 720, 30], [1920, 1080, 30], [1920, 1080, 60], [2560, 1440, 60], [3840, 2160, 30], [3840, 2160, 60], [1080, 1920, 25]];
    for (let i = 0; i < 120; i += 1) {
      const range = Math.round((0.3 + rnd() * 5) * 1000) / 1000;
      const sides = { anim_in: "zoom" as const, anim_in_s: Math.min(2, range / 2), anim_out: "slide-left" as const, anim_out_s: Math.min(2, range / 2) };
      const m0 = model({ reverse: true, out_s: range, ...sides }, 10);
      if (validateTimeline(toDoc(m0)).length) continue;
      const [width, height, fps] = frames[Math.floor(rnd() * frames.length)];
      const { model: out } = settleAll({ ...m0, width, height, fps }, m0);
      expect(validateTimeline(toDoc(out)), `case ${i} ${width}x${height}@${fps}`).toEqual([]);
    }
  });

  it("over the export's time a fade stays: it costs nothing", () => {
    const m0 = model({ fx: { rgb_split: 100 }, anim_in: "fade", anim_in_s: 0.4, anim_out: "zoom", anim_out_s: 0.4 }, 600);
    const { model: out } = settleAll({ ...m0, width: 3840, height: 2160, fps: 60 }, m0);
    expect(c0(out)).toMatchObject({ anim_in: "fade", anim_in_s: 0.4 });
    expect(c0(out).anim_out).toBeUndefined();
    expect(c0(out).fx).toBeUndefined();
  });
});

describe("apply this cross-fade to all cuts", () => {
  it("gives every cut with room the same length and style, and says how many changed", () => {
    let m = setCrossfade(three(), "c8", 1);
    m = setCrossfadeStyle(m, "c8", "wipeleft");
    const { model: out, changed } = applyCrossfadeToAll(m, "c8");
    expect(changed).toBe(1);
    const last = out.clips[2];
    expect(crossfadeOf(last)).toBeGreaterThan(0);
    expect(crossfadeOf(last)).toBeLessThanOrEqual(0.3);
    expect(crossfadeStyleOf(last)).toBe("wipeleft");
    expect(validateTimeline(toDoc(out))).toEqual([]);
    expect(applyCrossfadeToAll(three(), "c8")).toEqual({ model: three(), changed: 0 });
  });
});

/** A deterministic signal: quiet noise, with decaying bursts at `hits` (seconds). */
function signal(rate: number, seconds: number, hits: readonly number[], kind: "click" | "kick" | "snare", bed = 0.002): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let i = 0; i < out.length; i += 1) out[i] = bed * rnd();
  for (const h of hits) {
    const at = Math.round(h * rate);
    const len = Math.round((kind === "click" ? 0.01 : kind === "kick" ? 0.15 : 0.08) * rate);
    for (let i = 0; i < len && at + i < out.length; i += 1) {
      const env = Math.exp((-5 * i) / len);
      const v = kind === "kick" ? Math.sin((2 * Math.PI * 60 * i) / rate) : kind === "click" ? Math.sin((2 * Math.PI * 2000 * i) / rate) : rnd();
      out[at + i] += 0.6 * env * v;
    }
  }
  return out;
}

describe("beat markers", () => {
  const cases: { name: string; rate: number; kind: "click" | "kick" | "snare"; hits: number[] }[] = [
    { name: "a 120 BPM click track", rate: 44100, kind: "click", hits: Array.from({ length: 16 }, (_, i) => 0.25 + i * 0.5) },
    { name: "kicks at 100 BPM, 48 kHz", rate: 48000, kind: "kick", hits: Array.from({ length: 12 }, (_, i) => 0.3 + i * 0.6) },
    { name: "an uneven snare pattern, 22,050 Hz", rate: 22050, kind: "snare", hits: [0.2, 0.6, 0.85, 1.6, 1.9, 2.75, 3.1, 3.3] },
  ];
  for (const c of cases)
    it(`finds every beat of ${c.name} within 20 ms and nothing else`, () => {
      const pcm = signal(c.rate, 9, c.hits, c.kind);
      const block = Math.max(1, Math.round(c.rate * BEAT_BLOCK_S)) / c.rate;
      const found = detectBeats(energyDb([pcm], c.rate), block);
      expect(found.length).toBe(c.hits.length);
      found.forEach((t, i) => expect(Math.abs(t - c.hits[i])).toBeLessThanOrEqual(0.02));
    });

  it("two hits closer than MIN_GAP_S are one beat (a flam is not two beats)", () => {
    const rate = 44100;
    const pcm = signal(rate, 4, [0.5, 0.58, 1.5, 1.58, 2.5], "click");
    const found = detectBeats(energyDb([pcm], rate), 0.01);
    expect(found.map((t) => Math.round(t * 10) / 10)).toEqual([0.5, 1.5, 2.5]);
  });

  it("a steady tone and silence have no beats", () => {
    const rate = 44100;
    const tone = new Float32Array(rate * 3).map((_, i) => 0.4 * Math.sin((2 * Math.PI * 220 * i) / rate));
    expect(detectBeats(energyDb([tone], rate), 0.01)).toEqual([]);
    expect(detectBeats(energyDb([new Float32Array(rate * 3)], rate), 0.01)).toEqual([]);
  });

  it("are placed where the sound plays them, only inside its trim, and clip edges snap to them", () => {
    const s = { start_s: 10, in_s: 2, out_s: 5 };
    expect(beatTimes(s, [1, 2.5, 4, 6])).toEqual([10.5, 12]);
    const m = model();
    const targets = snapTargets({ clips: m.clips, texts: [], sounds: [], playhead: 0, beats: [10.5, 12] });
    expect(targets).toContain(10.5);
    expect(targets).toContain(12);
  });
});

describe("strings", () => {
  it("every language has every sentence (ru and uz are drafts)", () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v).map((x) => `${k}.${x}`) : [k]));
    expect(keys(ru.editor.parity2b)).toEqual(keys(en.editor.parity2b));
    expect(keys(uz.editor.parity2b)).toEqual(keys(en.editor.parity2b));
    for (const a of V_ANIMS) expect(en.editor.parity2b.anim.names[a]).toBeTruthy();
    for (const f of FX_NAMES) expect(en.editor.parity2b.fx.names[f]).toBeTruthy();
  });
});
