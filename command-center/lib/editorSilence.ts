/**
 * Silence removal: find the quiet parts of a clip's own sound and propose them as cuts the person
 * confirms; applied as ordinary splits and ripple deletes (one undo step). No document field.
 *
 * Where the analysis runs: in the browser, on the file the editor already plays (the library's signed
 * link of the 480p proxy, which keeps the sound), with the waveform's caps (`MAX_WAVEFORM_BYTES`,
 * `MAX_WAVEFORM_SECONDS`). So it goes through the same access check as the preview, nothing is stored,
 * no provider is involved and it costs nothing. The web server has no ffmpeg and a worker job would need
 * a queue table (a migration); doing it here needs neither. It is limited to one file at a time and
 * `ANALYSES_PER_MINUTE` new files a minute per tab, and each file is analysed once per page.
 *
 * The detector is ffmpeg's `silencedetect`, block-wise: a part is silent when every sample of every
 * channel stays under the threshold (`-N dB` of full scale) for at least the minimum length; it starts at
 * the first quiet sample and ends at the first loud one (or the end of the file). The envelope keeps the
 * loudest sample of each `BLOCK_S` block, so the answer is ffmpeg's to within one block
 * (samples/silence_cases.json holds what ffmpeg itself says on a set of signals; both test suites read it).
 */
import { readCappedBody, offlineDecoder, MAX_WAVEFORM_BYTES, MAX_WAVEFORM_SECONDS } from "@/lib/waveform";
import {
  MAX_EDITOR_CLIPS,
  MIN_CLIP_S,
  layout,
  ms,
  removeClip,
  splitClip,
  type EditorModel,
  type VideoClip,
} from "@/lib/editor";

/** The envelope's resolution: 10 ms. */
export const BLOCK_S = 0.01;
export const SILENCE_DB_MIN = -70;
export const SILENCE_DB_MAX = -20;
export const SILENCE_DB_DEFAULT = -40;
export const SILENCE_MIN_S_MIN = 0.2;
export const SILENCE_MIN_S_MAX = 3;
export const SILENCE_MIN_S_DEFAULT = 0.6;
/** Sound kept either side of a cut, so a word's first and last sounds are not clipped. */
export const SILENCE_KEEP_S = 0.1;
export const ANALYSES_PER_MINUTE = 6;

/** The real length of a block at `sampleRate`: a whole number of samples, so 22,050 Hz blocks are 221
 *  samples (10.02 ms), not 10 ms. Times are labelled by this, never by `b x BLOCK_S`. */
export function blockSeconds(sampleRate: number, blockS: number = BLOCK_S): number {
  return Math.max(1, Math.round(sampleRate * blockS)) / sampleRate;
}

/** The loudest sample (any channel, absolute) of each block of `blockS` seconds. */
export function envelope(
  channels: readonly Float32Array[],
  sampleRate: number,
  blockS: number = BLOCK_S,
): Float32Array {
  const length = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const per = Math.max(1, Math.round(sampleRate * blockS));
  const n = Math.ceil(length / per);
  const out = new Float32Array(n);
  for (const ch of channels)
    for (let b = 0; b < n; b += 1) {
      let peak = out[b];
      const to = Math.min(ch.length, (b + 1) * per);
      for (let i = b * per; i < to; i += 1) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
      out[b] = peak;
    }
  return out;
}

export type Span = [number, number];

/**
 * The silent parts of an envelope (seconds): runs of blocks whose loudest sample is under `thresholdDb`
 * (strictly, as silencedetect) lasting at least `minS`. A run reaching the end ends at the end. The
 * threshold is compared as a 32-bit float, as ffmpeg compares float samples (`const float noise`), so
 * a sample of exactly 0.01 is not under -40 dB. `blockS` is the envelope's real block length
 * ({@link blockSeconds}).
 */
export function detectSilences(
  env: Float32Array,
  thresholdDb: number,
  minS: number,
  blockS: number = BLOCK_S,
): Span[] {
  const amp = Math.fround(10 ** (thresholdDb / 20));
  const need = Math.max(1, Math.round(minS / blockS));
  const out: Span[] = [];
  let start = -1;
  for (let b = 0; b <= env.length; b += 1) {
    const quiet = b < env.length && env[b] < amp;
    if (quiet) {
      if (start < 0) start = b;
    } else if (start >= 0) {
      if (b - start >= need) out.push([ms(start * blockS), ms(b * blockS)]);
      start = -1;
    }
  }
  return out;
}

/** Can this clip's silences be cut? A still has no sound; a curve, a reversed or a frozen clip has no
 *  one source time per moment that a cut could follow. */
export type SilenceProblem = "still" | "retimed" | "no_audio" | "full";
export function silenceProblem(
  model: EditorModel,
  c: VideoClip,
  assetKind: string | undefined,
): SilenceProblem | null {
  if (assetKind !== "video") return "still";
  if (c.speed_curve || c.reverse || c.freeze) return "retimed";
  // Its own sound is off (muted, or detached to a sound of its own on an A track): there is nothing here to
  // listen to, and cutting the picture alone would put a detached sound out of step with it.
  if (!c.audio) return "no_audio";
  if (model.clips.length >= MAX_EDITOR_CLIPS) return "full";
  return null;
}

/**
 * The cuts (SOURCE seconds) the silences of a file propose inside a clip's range: each silence less
 * `SILENCE_KEEP_S` at both ends, merged where what would be left between two is shorter than a clip may
 * be, and stretched to the clip's own end where what would be left there is (no sliver of a clip).
 */
export function proposeCuts(c: Pick<VideoClip, "in_s" | "out_s">, silences: readonly Span[]): Span[] {
  const cuts: Span[] = [];
  for (const [s, e] of silences) {
    let a = Math.max(c.in_s, s + (s <= c.in_s ? 0 : SILENCE_KEEP_S));
    let b = Math.min(c.out_s, e - (e >= c.out_s ? 0 : SILENCE_KEEP_S));
    if (a - c.in_s < MIN_CLIP_S) a = c.in_s;
    if (c.out_s - b < MIN_CLIP_S) b = c.out_s;
    if (!(b - a >= MIN_CLIP_S)) continue;
    const last = cuts[cuts.length - 1];
    if (last && a - last[1] < MIN_CLIP_S) last[1] = ms(b);
    else cuts.push([ms(a), ms(b)]);
  }
  // Cutting the whole clip is not a cut: it would delete the clip.
  return cuts.filter(([a, b]) => !(a <= c.in_s && b >= c.out_s));
}

/** Where source time `src` of a constant-speed, forward clip plays on the timeline. */
function timeOf(c: VideoClip, src: number): number {
  return ms(c.start_s + (src - c.in_s) / c.speed);
}

/**
 * The model with `cuts` (source seconds, sorted, from {@link proposeCuts}) removed from clip `id`:
 * split at both ends of each cut, the middle deleted, the rest of the picture moved up (texts, sounds
 * and overlays keep their times). Done from the last cut back, so each split time is still the one the
 * clip had. Returns how many cuts fitted (the editor's clip limit can stop it early).
 */
export function applyCuts(
  model: EditorModel,
  id: string,
  cuts: readonly Span[],
): { model: EditorModel; applied: number } {
  let m: EditorModel = { ...model, clips: layout(model.clips) };
  let applied = 0;
  for (let i = cuts.length - 1; i >= 0; i -= 1) {
    const c = m.clips.find((x) => x.id === id);
    if (!c) break;
    const [a, b] = cuts[i];
    let next = m;
    let middle = id;
    if (b < c.out_s - 1e-9) {
      const r = splitClip(next, id, timeOf(c, b));
      if (!r) break;
      next = r.model;
    }
    if (a > c.in_s + 1e-9) {
      const left = next.clips.find((x) => x.id === id)!;
      const r = splitClip(next, id, timeOf(left, a));
      if (!r) break;
      next = r.model;
      middle = r.newId;
    }
    if (middle === id && next.clips.length <= 1) break;
    next = removeClip(next, middle);
    m = next;
    applied += 1;
    if (middle === id) break; // the head of the clip went: nothing is left of it to the left
  }
  return { model: m, applied };
}

/** The cuts (source seconds) as the timeline times the person sees, for the list shown before applying. */
export function cutTimes(c: Pick<VideoClip, "start_s" | "in_s" | "speed">, cuts: readonly Span[]): Span[] {
  const at = (src: number) => ms(c.start_s + (src - c.in_s) / (c.speed || 1));
  return cuts.map(([a, b]) => [at(a), at(b)]);
}

/** Which sentence a count takes: Russian has three forms (1 / 2-4 / 5+, 11-14 as 5+), English and Uzbek
 *  two (one / the rest). */
export function countForm(n: number, locale: string): "one" | "few" | "many" {
  const i = Math.abs(Math.trunc(n));
  if (locale.toLowerCase().startsWith("ru")) {
    if (i % 10 === 1 && i % 100 !== 11) return "one";
    if (i % 10 >= 2 && i % 10 <= 4 && (i % 100 < 12 || i % 100 > 14)) return "few";
    return "many";
  }
  return i === 1 ? "one" : "few";
}

/** Seconds of the timeline the cuts take out (shown before the person confirms). */
export function cutSeconds(c: Pick<VideoClip, "speed">, cuts: readonly Span[]): number {
  return ms(cuts.reduce((n, [a, b]) => n + (b - a), 0) / (c.speed || 1));
}

export type EnvelopeResult =
  | { status: "ready"; env: Float32Array; durationS: number; blockS: number }
  | { status: "too_large" | "unavailable" | "busy" | "no_sound" };

const recent: number[] = [];
let inFlight = false;
const cache = new Map<string, Promise<unknown>>();

/** May one more file be analysed now (`ANALYSES_PER_MINUTE`, one at a time)? `now` for tests. */
export function analysisAllowed(now: number = Date.now()): boolean {
  while (recent.length && now - recent[0] > 60_000) recent.shift();
  return !inFlight && recent.length < ANALYSES_PER_MINUTE;
}

/** For tests: forget every remembered file and the limiter. */
export function resetSilenceAnalysis(): void {
  cache.clear();
  recent.length = 0;
  inFlight = false;
}

/** A library file's sound, decoded in the tab (the caps, the decoder and the reasons it may not be). */
export interface DecodedSound {
  channels: Float32Array[];
  rate: number;
  durationS: number;
}
export type FileProblem = { status: "too_large" | "unavailable" | "busy" | "no_sound" };

async function decodeFile(url: string, knownDurationS: number | null): Promise<DecodedSound | FileProblem> {
  if (knownDurationS !== null && knownDurationS > MAX_WAVEFORM_SECONDS) return { status: "too_large" };
  let ctx: ReturnType<typeof offlineDecoder>;
  try {
    ctx = offlineDecoder();
  } catch {
    // A browser whose decoder throws when made is "unavailable", never a panel stuck on "working".
    return { status: "unavailable" };
  }
  if (!ctx || typeof fetch !== "function") return { status: "unavailable" };
  try {
    const res = await fetch(url);
    if (!res.ok) return { status: "unavailable" };
    const size = Number(res.headers.get("content-length"));
    if (Number.isFinite(size) && size > MAX_WAVEFORM_BYTES) return { status: "too_large" };
    const data = await readCappedBody(res, MAX_WAVEFORM_BYTES);
    if (data === null) return { status: "too_large" };
    const audio = await ctx.decodeAudioData(data);
    if (!(audio.duration > 0) || audio.numberOfChannels < 1) return { status: "no_sound" };
    if (audio.duration > MAX_WAVEFORM_SECONDS) return { status: "too_large" };
    const channels: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c += 1) channels.push(audio.getChannelData(c));
    const rate = (audio as { sampleRate?: number }).sampleRate ?? channels[0].length / audio.duration;
    return { channels, rate, durationS: audio.duration };
  } catch {
    // A video whose file has no sound track does not decode as audio at all.
    return { status: "no_sound" };
  }
}

/**
 * Decode a library file once per page under the shared limiter (one at a time, ANALYSES_PER_MINUTE new ones a
 * minute) and keep what `make` makes of it under `key` (the silence envelope, the beats). An "unavailable"
 * answer is forgotten, so a later try may succeed.
 */
export function analyseFile<R extends { status: string }>(
  key: string,
  url: string,
  knownDurationS: number | null,
  make: (d: DecodedSound) => R,
  now: number = Date.now(),
): Promise<R | FileProblem> {
  const hit = cache.get(key) as Promise<R | FileProblem> | undefined;
  if (hit) return hit;
  if (!analysisAllowed(now)) return Promise.resolve({ status: "busy" });
  recent.push(now);
  inFlight = true;
  const p = (async (): Promise<R | FileProblem> => {
    try {
      const d = await decodeFile(url, knownDurationS);
      return "channels" in d ? make(d) : d;
    } catch {
      return { status: "unavailable" };
    } finally {
      inFlight = false;
    }
  })().then((r) => {
    if (r.status === "unavailable") cache.delete(key);
    return r;
  });
  cache.set(key, p as Promise<unknown>);
  return p;
}

/** The loudness envelope of a library file, analysed at most once per page and rate-limited. */
export function silenceEnvelopeFor(
  assetId: string,
  url: string,
  knownDurationS: number | null,
  now: number = Date.now(),
): Promise<EnvelopeResult> {
  return analyseFile(
    assetId,
    url,
    knownDurationS,
    (d): EnvelopeResult => ({
      status: "ready",
      env: envelope(d.channels, d.rate),
      durationS: d.durationS,
      blockS: blockSeconds(d.rate),
    }),
    now,
  );
}
