/**
 * Silence removal (lib/editorSilence.ts): the detector agrees with ffmpeg's silencedetect on the shared
 * signals (samples/silence_cases.json; tests/test_editor_silence.py holds the file to the real ffmpeg),
 * the proposed cuts keep a little sound either side and never leave a sliver of a clip, applying them is
 * one model whose document both validators accept, and the analysis is limited (one file at a time, a
 * few a minute, once per file). What would break without these: cuts that clip words, a cut that leaves
 * a 30 ms clip the validator refuses, a document that no longer saves, or a page that decodes the same
 * video again on every click.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIN_CLIP_S,
  clipEnd,
  layout,
  ms,
  modelDuration,
  newDocForAsset,
  setSpeed,
  toDoc,
  toModel,
  validateTimeline,
  type EditorModel,
  type VideoClip,
} from "@/lib/editor";
import {
  ANALYSES_PER_MINUTE,
  BLOCK_S,
  SILENCE_KEEP_S,
  analysisAllowed,
  applyCuts,
  blockSeconds,
  countForm,
  cutSeconds,
  cutTimes,
  detectSilences,
  envelope,
  proposeCuts,
  resetSilenceAnalysis,
  silenceEnvelopeFor,
  silenceProblem,
} from "@/lib/editorSilence";

type Part = [string, number, number | number[], number];
const cases = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "samples", "silence_cases.json"), "utf8"),
) as {
  cases: {
    name: string;
    rate: number;
    channels: number;
    parts: Part[];
    probes: { threshold_db: number; min_s: number; silences: [number, number][] }[];
  }[];
};

/** The case's channels, made exactly as tests/test_editor_silence.py makes them. */
function channelsOf(c: (typeof cases.cases)[number]): Float32Array[] {
  const out: Float32Array[] = [];
  for (let ch = 0; ch < c.channels; ch += 1) {
    const parts: number[] = [];
    for (const [kind, seconds, amp0, freq] of c.parts) {
      const amp = Array.isArray(amp0) ? amp0[ch] : amp0;
      const n = Math.round(seconds * c.rate);
      for (let i = 0; i < n; i += 1)
        parts.push(kind === "dc" ? Math.fround(amp) : Math.fround(amp * Math.sin((2 * Math.PI * freq * i) / c.rate)));
    }
    out.push(Float32Array.from(parts));
  }
  return out;
}

const A = "11111111-1111-4111-8111-111111111111";
const model = (clip: Partial<VideoClip> = {}, durationS = 20): EditorModel => {
  const m = toModel(newDocForAsset({ id: A, durationS, width: 1280, height: 720 })!);
  return { ...m, clips: m.clips.map((c) => ({ ...c, audio: true, ...clip })) };
};

describe("the detector is ffmpeg's silencedetect, to within one block", () => {
  it("finds what the real ffmpeg reported on every shared signal and probe", () => {
    expect(cases.cases.length).toBeGreaterThanOrEqual(6);
    let compared = 0;
    for (const c of cases.cases) {
      const env = envelope(channelsOf(c), c.rate);
      const block = blockSeconds(c.rate);
      for (const p of c.probes) {
        const got = detectSilences(env, p.threshold_db, p.min_s, block);
        expect(got.length, `${c.name} ${p.threshold_db} dB ${p.min_s} s`).toBe(p.silences.length);
        got.forEach(([a, b], i) => {
          expect(Math.abs(a - p.silences[i][0])).toBeLessThanOrEqual(block + 1e-9);
          expect(Math.abs(b - p.silences[i][1])).toBeLessThanOrEqual(block + 1e-9);
          compared += 1;
        });
      }
    }
    expect(compared).toBeGreaterThan(10);
    expect(cases.cases.some((c) => c.parts.some((p) => p[0] === "dc"))).toBe(true);
  });

  it("compares the threshold as a 32-bit float, as ffmpeg does: exactly 0.01 is not under -40 dB", () => {
    const at = new Float32Array(4410).fill(0.01);
    expect(detectSilences(envelope([at], 44100), -40, 0.05)).toEqual([]);
    const under = new Float32Array(4410).fill(0.0099);
    expect(detectSilences(envelope([under], 44100), -40, 0.05)).toEqual([[0, 0.1]]);
  });

  it("labels each block by its real length: at 22,050 Hz a block is 221 samples, not 10 ms", () => {
    expect(BLOCK_S).toBe(0.01);
    expect(blockSeconds(22050)).toBeCloseTo(221 / 22050, 12);
    expect(blockSeconds(48000)).toBe(0.01);
    // 1000 blocks of quiet at 22,050 Hz are 10.023 s, not 10 s
    const quiet = new Float32Array(221 * 1000);
    const [[a, b]] = detectSilences(envelope([quiet], 22050), -40, 0.5, blockSeconds(22050));
    expect(a).toBe(0);
    expect(b).toBeCloseTo((221 * 1000) / 22050, 3);
  });

  it("a block is quiet only when every channel is under the threshold", () => {
    const loud = new Float32Array(4410).fill(0.5);
    const quiet = new Float32Array(4410).fill(0.0001);
    expect(detectSilences(envelope([quiet, loud], 44100), -40, 0.05)).toEqual([]);
    expect(detectSilences(envelope([quiet, quiet], 44100), -40, 0.05)).toEqual([[0, 0.1]]);
  });
});

describe("the proposed cuts", () => {
  it("keep a little sound either side, except at the clip's own ends", () => {
    expect(proposeCuts({ in_s: 0, out_s: 10 }, [[2, 4]])).toEqual([[2 + SILENCE_KEEP_S, 4 - SILENCE_KEEP_S]]);
    expect(proposeCuts({ in_s: 0, out_s: 10 }, [[0, 1.5]])).toEqual([[0, 1.5 - SILENCE_KEEP_S]]);
    expect(proposeCuts({ in_s: 0, out_s: 10 }, [[9, 10]])).toEqual([[9 + SILENCE_KEEP_S, 10]]);
  });

  it("are only inside the clip's range, never the whole clip, and leave no piece shorter than a clip", () => {
    expect(proposeCuts({ in_s: 3, out_s: 8 }, [[0, 2], [9, 12]])).toEqual([]);
    expect(proposeCuts({ in_s: 3, out_s: 8 }, [[2, 9]])).toEqual([]);
    expect(proposeCuts({ in_s: 3, out_s: 8 }, [[2, 5]])).toEqual([[3, 4.9]]);
    // two silences 0.05 s apart keep the sound kept either side between them (never a sliver)
    const two = proposeCuts({ in_s: 0, out_s: 10 }, [[1, 2.1], [2.15, 4]]);
    expect(two).toEqual([[1.1, 2], [2.25, 3.9]]);
    for (const [a, b] of proposeCuts({ in_s: 0, out_s: 10 }, [[0.05, 1], [1.2, 1.5], [9.97, 10]])) {
      expect(b - a).toBeGreaterThanOrEqual(MIN_CLIP_S);
      expect(a === 0 || a >= MIN_CLIP_S).toBe(true);
    }
    // a silence shorter than the sound kept either side is no cut
    expect(proposeCuts({ in_s: 0, out_s: 10 }, [[5, 5.25]])).toEqual([]);
  });
});

describe("applying the cuts", () => {
  it("is splits and deletions: the picture is shorter by the cuts and the document still validates", () => {
    const m = model({}, 20);
    const id = m.clips[0].id;
    const cuts = proposeCuts(m.clips[0], [[0, 1], [5, 7], [12, 13.5], [19, 20]]);
    const { model: out, applied } = applyCuts(m, id, cuts);
    expect(applied).toBe(cuts.length);
    expect(out.clips.length).toBe(3);
    expect(modelDuration(out)).toBeCloseTo(20 - cutSeconds(m.clips[0], cuts), 2);
    expect(validateTimeline(toDoc(out))).toEqual([]);
    // what is left plays the sound between the cuts, in order
    expect(out.clips.map((c) => [c.in_s, c.out_s])).toEqual([
      [0.9, 5.1],
      [6.9, 12.1],
      [13.4, 19.1],
    ]);
  });

  it("follows the clip's speed: a 2x clip loses half as much timeline", () => {
    const m0 = model({}, 20);
    const m = setSpeed(m0, m0.clips[0].id, 2);
    const cuts = proposeCuts(m.clips[0], [[4, 8]]);
    const out = applyCuts(m, m.clips[0].id, cuts).model;
    expect(modelDuration(out)).toBeCloseTo(10 - (8 - 4 - 2 * SILENCE_KEEP_S) / 2, 2);
    expect(out.clips.map((c) => [c.in_s, c.out_s])).toEqual([
      [0, 4.1],
      [7.9, 20],
    ]);
    expect(validateTimeline(toDoc(out))).toEqual([]);
  });

  it("leaves the clips around it alone and keeps the clip's settings on every piece", () => {
    const m0 = model({ color: { hue: 30 } }, 10);
    const second = { ...m0.clips[0], id: "c9", start_s: 10 };
    const m = { ...m0, clips: [m0.clips[0], second] };
    const out = applyCuts(m, m.clips[0].id, proposeCuts(m.clips[0], [[3, 6]])).model;
    expect(out.clips.length).toBe(3);
    expect(out.clips.every((c) => c.color?.hue === 30)).toBe(true);
    expect(out.clips[2].id).toBe("c9");
    expect(clipEnd(out.clips[2])).toBeCloseTo(20 - 2.8, 2);
  });

  it("is offered for a video at one speed, forwards; not for a still, a curve, reverse or freeze", () => {
    const m = model();
    expect(silenceProblem(m, m.clips[0], "video")).toBeNull();
    // its own sound off (muted, or detached to an A track): refused, so a detached sound stays in step
    expect(silenceProblem(m, { ...m.clips[0], audio: false }, "video")).toBe("no_audio");
    expect(silenceProblem(m, m.clips[0], "image")).toBe("still");
    expect(silenceProblem(m, { ...m.clips[0], reverse: true }, "video")).toBe("retimed");
    expect(silenceProblem(m, { ...m.clips[0], freeze: true }, "video")).toBe("retimed");
    expect(
      silenceProblem(m, { ...m.clips[0], speed_curve: [{ at: 0, speed: 1 }, { at: 1, speed: 2 }] }, "video"),
    ).toBe("retimed");
  });
});

describe("splitting keeps every piece's fades inside it (the validator's rule)", () => {
  it("the review's case: a 12 s clip faded 0.5 in and 0.7 out, cut 2.1-11.5, still validates", () => {
    const m = model({ fade_in_s: 0.5, fade_out_s: 0.7 }, 12);
    const cuts = proposeCuts(m.clips[0], [[2, 11.6]]);
    expect(cuts).toEqual([[2.1, 11.5]]);
    const out = applyCuts(m, m.clips[0].id, cuts).model;
    expect(out.clips.map((c) => [c.in_s, c.out_s, c.fade_in_s ?? 0, c.fade_out_s ?? 0])).toEqual([
      [0, 2.1, 0.5, 0],
      [11.5, 12, 0, 0.5],
    ]);
    expect(validateTimeline(toDoc(out))).toEqual([]);
  });

  it("random cuts on random clips (fades, speeds, cross-fades, moves, masks) always give a valid document", () => {
    let seed = 20261111;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
    let applied = 0;
    for (let i = 0; i < 1500; i += 1) {
      const n = 1 + Math.floor(rnd() * 3);
      const m0 = model({}, 30);
      const clips: VideoClip[] = [];
      for (let k = 0; k < n; k += 1) {
        const range = pick([1, 2.5, 6, 12, 30]);
        const c: VideoClip = { ...m0.clips[0], id: `c${k}`, in_s: 0, out_s: range, speed: pick([0.5, 1, 1, 2, 3]) };
        const len = range / c.speed;
        if (rnd() < 0.6) c.fade_in_s = Math.round(rnd() * Math.min(2, len / 2) * 1000) / 1000;
        if (rnd() < 0.6) c.fade_out_s = Math.round(rnd() * Math.min(2, len / 2) * 1000) / 1000;
        if (rnd() < 0.3) c.move = { from: { zoom: 1 + rnd() }, to: { zoom: 1 + rnd(), x: rnd() } };
        if (rnd() < 0.3) c.mask = { shape: pick(["rect", "ellipse", "rounded"] as const), feather: 0.2 };
        if (k > 0 && rnd() < 0.4) c.transition = { type: "crossfade", duration_s: pick([0.2, 0.5, 1]) };
        clips.push(c);
      }
      const m = { ...m0, clips: layout(clips) };
      if (validateTimeline(toDoc(m)).length) continue;
      const target = pick(m.clips);
      const silences: [number, number][] = [];
      let at = target.in_s + rnd() * 0.5;
      while (at < target.out_s) {
        const e = at + 0.05 + rnd() * 3;
        silences.push([ms(at), ms(Math.min(e, target.out_s + rnd()))]);
        at = e + 0.05 + rnd() * 2;
      }
      const out = applyCuts(m, target.id, proposeCuts(target, silences));
      applied += out.applied;
      expect(validateTimeline(toDoc(out.model)), `case ${i}`).toEqual([]);
    }
    expect(applied).toBeGreaterThan(1000);
  });
});

describe("what the panel shows", () => {
  it("the cut list in timeline times (the clip's start and speed), and counts in each language's forms", () => {
    expect(cutTimes({ start_s: 10, in_s: 4, speed: 2 }, [[6, 8]])).toEqual([[11, 12]]);
    expect([1, 2, 5, 11, 21, 22].map((n) => countForm(n, "ru"))).toEqual(["one", "few", "many", "many", "one", "few"]);
    expect([1, 2, 5].map((n) => countForm(n, "en"))).toEqual(["one", "few", "few"]);
    expect([1, 3].map((n) => countForm(n, "uz"))).toEqual(["one", "few"]);
  });
});

describe("the analysis is limited", () => {
  afterEach(() => {
    resetSilenceAnalysis();
    vi.unstubAllGlobals();
  });

  it("one file at a time and a few a minute", () => {
    resetSilenceAnalysis();
    expect(analysisAllowed(0)).toBe(true);
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData() {
          return Promise.resolve({ duration: 1, numberOfChannels: 1, getChannelData: () => new Float32Array(10) });
        }
      },
    );
    void silenceEnvelopeFor("a1", "https://x/a1", 10, 0);
    expect(analysisAllowed(1)).toBe(false);
    return silenceEnvelopeFor("a2", "https://x/a2", 10, 1).then((r) => {
      expect(r.status).toBe("busy");
      expect(ANALYSES_PER_MINUTE).toBeGreaterThan(1);
    });
  });

  it("a decoder that throws when made is 'unavailable', and the next file may be analysed", async () => {
    resetSilenceAnalysis();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        constructor() {
          throw new Error("no audio here");
        }
      },
    );
    const r = await silenceEnvelopeFor("a5", "https://x/a5", 1, 0);
    expect(r.status).toBe("unavailable");
    expect(analysisAllowed(1)).toBe(true);
  });

  it("a file past the waveform's length cap is not downloaded", async () => {
    resetSilenceAnalysis();
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    vi.stubGlobal("OfflineAudioContext", class {});
    const r = await silenceEnvelopeFor("a3", "https://x/a3", 99999, 0);
    expect(r.status).toBe("too_large");
    expect(f).not.toHaveBeenCalled();
  });

  it("decodes a file once and reuses its envelope", async () => {
    resetSilenceAnalysis();
    const f = vi.fn(async () => new Response(new Uint8Array(8)));
    vi.stubGlobal("fetch", f);
    vi.stubGlobal(
      "OfflineAudioContext",
      class {
        decodeAudioData() {
          return Promise.resolve({
            duration: 1,
            numberOfChannels: 1,
            sampleRate: 1000,
            getChannelData: () => new Float32Array(1000),
          });
        }
      },
    );
    const a = await silenceEnvelopeFor("a4", "https://x/a4", 1, 0);
    const b = await silenceEnvelopeFor("a4", "https://x/a4", 1, 1);
    expect(a.status).toBe("ready");
    expect(b).toBe(a);
    expect(f).toHaveBeenCalledTimes(1);
    if (a.status === "ready") expect(detectSilences(a.env, -40, 0.5)).toEqual([[0, 1]]);
  });
});
