/**
 * Beat markers: where the beats of a sound fall, found in the browser from the file the editor already plays
 * (lib/editorSilence.ts `analyseFile`: the same signed link, caps and limiter as silence removal; no server, no
 * provider, nothing stored with the project). The markers are shown on the timeline and clip edges snap to them
 * (lib/editor-timeline-view.ts `snapTargets`).
 *
 * The detector is an energy onset detector: the RMS of each `BEAT_BLOCK_S` block, in dB; the onset strength of a
 * block is how far it rises above the mean of the `RISE_WINDOW_S` before it; a beat is a block whose strength is
 * a local maximum over `PEAK_HALF_S` either side, at least `MIN_RISE_DB` and above the strength's own mean plus
 * `STRENGTH_K` deviations, louder than `FLOOR_DB`, and at least `MIN_GAP_S` after the last beat. It is checked on
 * click tracks and drum-like patterns with known beat times (samples/beat_cases.json, made by
 * tests/test_editor_beats.py).
 */
import { analyseFile, type FileProblem } from "@/lib/editorSilence";
import { ms, soundLength, type SoundClip } from "@/lib/editor";

export const BEAT_BLOCK_S = 0.01;
export const RISE_WINDOW_S = 0.1;
export const PEAK_HALF_S = 0.05;
export const MIN_RISE_DB = 6;
export const STRENGTH_K = 1.5;
export const FLOOR_DB = -50;
export const MIN_GAP_S = 0.15;
/** At most this many markers per sound (a 20-minute file at 4 beats a second is 4800). */
export const MAX_BEATS = 5000;

/** Each block's RMS in dB of full scale (all channels together), -120 for silence. */
export function energyDb(channels: readonly Float32Array[], rate: number, blockS: number = BEAT_BLOCK_S): Float32Array {
  const per = Math.max(1, Math.round(rate * blockS));
  const length = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const n = Math.ceil(length / per);
  const out = new Float32Array(n);
  for (let b = 0; b < n; b += 1) {
    let sum = 0;
    let count = 0;
    for (const ch of channels)
      for (let i = b * per; i < Math.min(ch.length, (b + 1) * per); i += 1) {
        sum += ch[i] * ch[i];
        count += 1;
      }
    const rms = count ? Math.sqrt(sum / count) : 0;
    out[b] = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
  }
  return out;
}

/** The beat times (seconds of the file) of an energy curve. */
export function detectBeats(e: Float32Array, blockS: number): number[] {
  const rise = Math.max(1, Math.round(RISE_WINDOW_S / blockS));
  const half = Math.max(1, Math.round(PEAK_HALF_S / blockS));
  const gap = MIN_GAP_S / blockS;
  const s = new Float32Array(e.length);
  for (let b = 1; b < e.length; b += 1) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, b - rise); k < b; k += 1) {
      sum += e[k];
      n += 1;
    }
    s[b] = n ? Math.max(0, e[b] - sum / n) : 0;
  }
  let mean = 0;
  for (const v of s) mean += v;
  mean /= Math.max(1, s.length);
  let dev = 0;
  for (const v of s) dev += (v - mean) ** 2;
  dev = Math.sqrt(dev / Math.max(1, s.length));
  const need = Math.max(MIN_RISE_DB, mean + STRENGTH_K * dev);
  const out: number[] = [];
  let last = -Infinity;
  for (let b = 1; b < s.length && out.length < MAX_BEATS; b += 1) {
    if (s[b] < need || e[b] < FLOOR_DB) continue;
    let peak = true;
    for (let k = Math.max(0, b - half); k <= Math.min(s.length - 1, b + half); k += 1)
      if (s[k] > s[b] || (s[k] === s[b] && k < b)) {
        peak = false;
        break;
      }
    if (!peak || b - last < gap) continue;
    out.push(ms(b * blockS));
    last = b;
  }
  return out;
}

export type BeatsResult = { status: "ready"; beats: number[] } | FileProblem;

/** The beats of a library file, found at most once per page (rate-limited with the silence analysis). */
export function beatsFor(assetId: string, url: string, knownDurationS: number | null, now: number = Date.now()): Promise<BeatsResult> {
  return analyseFile(
    `beats:${assetId}`,
    url,
    knownDurationS,
    (d) => {
      const block = Math.max(1, Math.round(d.rate * BEAT_BLOCK_S)) / d.rate;
      return { status: "ready" as const, beats: detectBeats(energyDb(d.channels, d.rate), block) };
    },
    now,
  );
}

/** The beats of a file as timeline times for a sound that plays it (only those inside its trim). */
export function beatTimes(sound: Pick<SoundClip, "start_s" | "in_s" | "out_s">, beats: readonly number[]): number[] {
  const end = sound.in_s + soundLength(sound);
  return beats.filter((b) => b >= sound.in_s && b <= end).map((b) => ms(sound.start_s + (b - sound.in_s)));
}
