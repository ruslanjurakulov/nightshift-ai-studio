import { INTRO } from "@/lib/site/brand-intro";

/**
 * The brand intro's sound: a soft low riser while the slit of light grows along the N's diagonal, then a deep, soft "door"
 * whoosh that parts left and right with the two halves, over a low hit as they start to open. Synthesised here with the Web
 * Audio API (oscillators, a seeded noise buffer, filters, gain envelopes, a generated room) — no file, nothing fetched.
 *
 * It is heard only where the browser already allows sound without a gesture, which on a first visit is almost nowhere: the
 * intro runs before any input, and any input ends it. So the rule is the opposite of "make it play": never ask, never wait,
 * never log. When the browser says no, the intro is silent and nothing else changes.
 */

/** When each part sounds, in ms on the intro's timeline (lib/site/brand-intro.ts INTRO). */
export const CUE = {
  riserAt: INTRO.slitAt,
  riserEnd: INTRO.slitAt + INTRO.slitMs,
  doorAt: INTRO.openAt,
  /** Silent by the moment the overlay leaves the DOM, so closing the context there cuts nothing. */
  end: INTRO.openAt + INTRO.openMs,
} as const;

/** If audio could only start later than this on the timeline, it would be out of step with the picture: it does not start. */
export const CUE_LATEST_START_MS = CUE.riserAt + 60;
/** Skip, hide, or the end: the master is ramped to silence over this, then the context is closed. */
export const CUE_STOP_MS = 30;
/**
 * The master level. Set from the measured render (docs/design/s5-brand-intro/intro-cue.wav, ffmpeg ebur128): about -18 LUFS
 * integrated with peaks under -6 dBFS. Re-measure if any part below changes.
 */
export const CUE_MASTER_GAIN = 0.78;
/** Nothing above this reaches the speaker: soft, never hissy. */
export const CUE_LOWPASS_HZ = 6500;

/** A fixed seed: the same noise on every visit and in every render, so what was measured is what plays. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number, seed: number): AudioBuffer {
  const len = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rnd = seeded(seed);
  for (let i = 0; i < len; i++) data[i] = rnd();
  return buf;
}

/** A small dark room: stereo noise decaying over 0.9 s, its highs falling away faster than its lows. */
function roomBuffer(ctx: BaseAudioContext): AudioBuffer {
  const seconds = 0.9;
  const len = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    const rnd = seeded(7 + ch * 101);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // A one-pole low-pass whose cutoff drops as the tail decays.
      const k = 0.5 - 0.42 * t;
      lp += k * (rnd() - lp);
      data[i] = lp * Math.pow(1 - t, 2.6);
    }
  }
  return buf;
}

/** An exponential ramp cannot start or end at 0. */
const SILENT = 0.0001;

/**
 * Schedules the whole cue on `ctx` (a live AudioContext or an OfflineAudioContext for the recording), with the intro's
 * timeline starting at context time `t0` seconds. Returns the master gain, the one handle a stop needs.
 */
export function scheduleCue(ctx: BaseAudioContext, destination: AudioNode, t0: number): GainNode {
  const at = (ms: number) => t0 + ms / 1000;
  const endT = at(CUE.end);

  const master = ctx.createGain();
  master.gain.value = CUE_MASTER_GAIN;
  master.gain.setValueAtTime(CUE_MASTER_GAIN, at(CUE.riserAt));
  // The last 90 ms fade out under the picture's own last frames.
  master.gain.setValueAtTime(CUE_MASTER_GAIN, endT - 0.09);
  master.gain.linearRampToValueAtTime(0, endT);
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = CUE_LOWPASS_HZ;
  tone.Q.value = 0.5;
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -20;
  glue.knee.value = 12;
  glue.ratio.value = 3;
  glue.attack.value = 0.006;
  glue.release.value = 0.18;
  tone.connect(glue).connect(master).connect(destination);

  const room = ctx.createConvolver();
  room.normalize = true;
  room.buffer = roomBuffer(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.28;
  room.connect(wet).connect(tone);

  const noise = noiseBuffer(ctx, 2, 1234);
  const sources: AudioScheduledSourceNode[] = [];

  // 1. The riser: breath through a band that climbs, under a low tone that rises an octave.
  {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 0.9;
    band.frequency.setValueAtTime(260, at(CUE.riserAt));
    band.frequency.exponentialRampToValueAtTime(1500, at(CUE.riserEnd));
    const g = ctx.createGain();
    g.gain.setValueAtTime(SILENT, at(CUE.riserAt));
    g.gain.exponentialRampToValueAtTime(0.28, at(CUE.riserEnd - 20));
    g.gain.exponentialRampToValueAtTime(SILENT, at(CUE.riserEnd + 140));
    src.connect(band).connect(g).connect(tone);
    g.connect(room);
    src.start(at(CUE.riserAt), 0.1);
    src.stop(at(CUE.riserEnd + 160));
    sources.push(src);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(68, at(CUE.riserAt));
    osc.frequency.exponentialRampToValueAtTime(136, at(CUE.riserEnd));
    const og = ctx.createGain();
    og.gain.setValueAtTime(SILENT, at(CUE.riserAt));
    og.gain.exponentialRampToValueAtTime(0.16, at(CUE.riserEnd - 20));
    og.gain.exponentialRampToValueAtTime(SILENT, at(CUE.riserEnd + 120));
    osc.connect(og).connect(tone);
    osc.start(at(CUE.riserAt));
    osc.stop(at(CUE.riserEnd + 140));
    sources.push(osc);
  }

  // 2. The door: two breaths of air, one per half, each falling in pitch and moving out to its own side as the halves part.
  for (const side of [-1, 1]) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 1.1;
    lp.frequency.setValueAtTime(1900, at(CUE.doorAt));
    lp.frequency.exponentialRampToValueAtTime(240, at(CUE.end - 60));
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(0, at(CUE.doorAt));
    pan.pan.linearRampToValueAtTime(0.65 * side, at(CUE.end - 100));
    const g = ctx.createGain();
    g.gain.setValueAtTime(SILENT, at(CUE.doorAt));
    g.gain.exponentialRampToValueAtTime(0.55, at(CUE.doorAt + 110));
    // The air keeps moving while the halves travel, then dies away as they leave the screen.
    g.gain.linearRampToValueAtTime(0.4, at(CUE.end - 260));
    g.gain.exponentialRampToValueAtTime(SILENT, at(CUE.end - 30));
    src.connect(lp).connect(pan).connect(g).connect(tone);
    g.connect(room);
    // Different stretches of the same noise, so the two sides are not one sound copied.
    src.start(at(CUE.doorAt), side < 0 ? 0.4 : 1.1);
    src.stop(endT);
    sources.push(src);
  }

  // 3. The hit: a soft sine thump dropping an octave, under the first instant of the opening.
  {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(84, at(CUE.doorAt));
    osc.frequency.exponentialRampToValueAtTime(42, at(CUE.doorAt + 260));
    const g = ctx.createGain();
    g.gain.setValueAtTime(SILENT, at(CUE.doorAt));
    g.gain.exponentialRampToValueAtTime(0.5, at(CUE.doorAt + 8));
    g.gain.exponentialRampToValueAtTime(SILENT, at(CUE.end - 40));
    osc.connect(g).connect(tone);
    g.connect(room);
    osc.start(at(CUE.doorAt));
    osc.stop(endT);
    sources.push(osc);
  }

  return master;
}

type AutoplayNavigator = Navigator & {
  getAutoplayPolicy?: (type: "audiocontext") => "allowed" | "allowed-muted" | "disallowed";
  userActivation?: { hasBeenActive: boolean };
};

/**
 * Would the browser let an AudioContext sound right now, without our asking? Firefox can say so (getAutoplayPolicy). Chrome
 * and Safari cannot, and a context made where sound is not allowed makes Chrome log a warning on every such visit; so there
 * a context is made only once the page has had a user gesture. A hidden tab never plays.
 */
export function soundAllowed(): boolean {
  try {
    if (document.visibilityState !== "visible") return false;
    const nav = navigator as AutoplayNavigator;
    if (typeof nav.getAutoplayPolicy === "function") return nav.getAutoplayPolicy("audiocontext") === "allowed";
    return nav.userActivation?.hasBeenActive === true;
  } catch {
    return false;
  }
}

export type IntroCue = { stop: () => void };

/**
 * Starts the cue for an intro that is playing, whose animations started at `start` (performance.now() ms, the overlay's first
 * animationstart). Returns null, and creates nothing, when sound is not allowed. Never throws, never retries, never waits: the picture does not know about it.
 * stop() ramps to silence in CUE_STOP_MS and closes the context; it is safe to call more than once.
 */
export function startIntroCue(start: number): IntroCue | null {
  if (!soundAllowed()) return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (typeof Ctor !== "function") return null;
  let ctx: AudioContext;
  try {
    ctx = new Ctor({ latencyHint: "interactive" });
  } catch {
    return null;
  }

  let stopped = false;
  let master: GainNode | null = null;
  const onVisibility = () => {
    if (document.visibilityState !== "visible") stop();
  };

  function close() {
    try {
      void ctx.close().catch(() => {});
    } catch {
      // Already closed.
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibility);
    if (!master) {
      close();
      return;
    }
    try {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(0, now + CUE_STOP_MS / 1000);
    } catch {
      // A context that is already gone is already silent.
    }
    window.setTimeout(close, CUE_STOP_MS + 10);
  }

  function begin() {
    if (stopped) return;
    if (ctx.state !== "running") return stop();
    const offset = performance.now() - start;
    if (!(offset <= CUE_LATEST_START_MS)) return stop();
    try {
      master = scheduleCue(ctx, ctx.destination, ctx.currentTime - offset / 1000);
    } catch {
      stop();
    }
  }

  document.addEventListener("visibilitychange", onVisibility);
  try {
    if (ctx.state === "running") begin();
    // A refused resume stays pending or rejects: either way the intro goes on silent, and the stop at its end closes the context.
    else void ctx.resume().then(begin, stop);
  } catch {
    stop();
  }
  return { stop };
}
