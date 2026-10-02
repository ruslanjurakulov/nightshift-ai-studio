/**
 * Waveforms for the editor's sounds — the pure half, plus the one function
 * that reads a file.
 *
 * A waveform is computed in the browser from the file the editor already
 * plays: fetched through the same signed link as the preview and decoded by
 * the browser. Nothing is stored (the document has no place for peaks, and a
 * peaks array in it would be one more thing a save could get wrong or bloat
 * past 256 KB), nothing goes to a server, no provider is involved and no SQL
 * is needed. What a person sees is the file's real loudness over time, drawn
 * for the part of the file the clip uses (its trim).
 *
 * When it cannot be drawn — too big to decode in a tab, the browser cannot
 * decode it, the link is refused — the answer is a named status, never an
 * empty drawing that looks like silence (CLAUDE.md: unknown is not zero).
 */

/** Buckets per second of source: enough that a trimmed clip a few seconds long
 *  still has detail, bounded by MAX_BUCKETS for a long file. */
export const PEAKS_PER_SECOND = 20;
export const MAX_BUCKETS = 6000;
/** Past these the decoded audio alone (48 kHz stereo floats ≈ 23 MB a minute)
 *  would be too much for a browser tab, so no waveform is attempted. */
export const MAX_WAVEFORM_BYTES = 40 * 1024 * 1024;
export const MAX_WAVEFORM_SECONDS = 20 * 60;

export type PeaksResult =
  | { status: "ready"; peaks: Float32Array; durationS: number }
  | { status: "too_large" | "unavailable" };

/** How many buckets a file of `durationS` seconds is summarised in. */
export function bucketCount(durationS: number): number {
  if (!Number.isFinite(durationS) || durationS <= 0) return 1;
  return Math.max(1, Math.min(MAX_BUCKETS, Math.ceil(durationS * PEAKS_PER_SECOND)));
}

/**
 * The loudest sample (absolute value, any channel) in each of `buckets`
 * equal parts of the audio, 0..1. A sample beyond ±1 (a decoder's overshoot)
 * counts as 1.
 */
export function computePeaks(
  channels: readonly Float32Array[],
  buckets: number,
): Float32Array {
  const n = Math.max(1, Math.floor(buckets));
  const out = new Float32Array(n);
  const length = channels.reduce((m, c) => Math.max(m, c.length), 0);
  if (length === 0) return out;
  for (const ch of channels) {
    for (let b = 0; b < n; b += 1) {
      const from = Math.floor((b * length) / n);
      const to = Math.min(ch.length, Math.floor(((b + 1) * length) / n));
      let peak = out[b];
      for (let i = from; i < to; i += 1) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
      out[b] = Math.min(1, peak);
    }
  }
  return out;
}

/**
 * `bars` heights (0..1) for the part of a file a clip uses, in..out seconds:
 * each bar is the loudest bucket it covers. A range outside the file is
 * clamped to it; an empty range gives no bars.
 */
export function barsFor(
  peaks: Float32Array,
  durationS: number,
  inS: number,
  outS: number,
  bars: number,
): number[] {
  const count = Math.max(0, Math.floor(bars));
  if (!count || !peaks.length || !(durationS > 0)) return [];
  const lo = Math.min(Math.max(inS, 0), durationS);
  const hi = Math.min(Math.max(outS, 0), durationS);
  if (!(hi > lo)) return [];
  const perS = peaks.length / durationS;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = Math.floor((lo + ((hi - lo) * i) / count) * perS);
    const b = Math.max(
      a + 1,
      Math.ceil((lo + ((hi - lo) * (i + 1)) / count) * perS),
    );
    let peak = 0;
    for (let k = a; k < Math.min(b, peaks.length); k += 1)
      if (peaks[k] > peak) peak = peaks[k];
    out.push(peak);
  }
  return out;
}

/**
 * One SVG path of mirrored bars in a `bars` × 100 box: bar i is a rectangle
 * one unit wide, centred on the middle line. A silent bar keeps a hairline so
 * the line reads as a waveform with quiet parts, not as a gap.
 */
export function barsPath(heights: readonly number[]): string {
  return heights
    .map((h, i) => {
      const half = Math.max(1, Math.min(1, h) * 50);
      return `M${i} ${(50 - half).toFixed(2)}h0.7v${(half * 2).toFixed(2)}h-0.7z`;
    })
    .join("");
}

/** What the decoder sees: the one method the editor needs of an AudioBuffer. */
interface DecodedAudio {
  duration: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

type DecodeContext = {
  decodeAudioData(data: ArrayBuffer): Promise<DecodedAudio>;
};

function decoder(): DecodeContext | null {
  const w = globalThis as unknown as {
    OfflineAudioContext?: new (c: number, l: number, r: number) => DecodeContext;
    webkitOfflineAudioContext?: new (c: number, l: number, r: number) => DecodeContext;
  };
  const Ctx = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  // A 1-sample offline context only decodes: it never plays, so it needs no
  // user gesture and cannot make a sound.
  return Ctx ? new Ctx(1, 1, 44100) : null;
}

/**
 * Fetch `url` and summarise its audio. Never throws: a file too big for a tab,
 * a link the browser may not read, a format it cannot decode and a missing
 * decoder are each a status. `knownDurationS` (from the library) is checked
 * before anything is downloaded.
 */
export async function loadPeaks(
  url: string,
  knownDurationS: number | null,
  signal?: AbortSignal,
): Promise<PeaksResult> {
  if (knownDurationS !== null && knownDurationS > MAX_WAVEFORM_SECONDS)
    return { status: "too_large" };
  const ctx = decoder();
  if (!ctx || typeof fetch !== "function") return { status: "unavailable" };
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return { status: "unavailable" };
    const size = Number(res.headers.get("content-length"));
    if (Number.isFinite(size) && size > MAX_WAVEFORM_BYTES)
      return { status: "too_large" };
    const data = await res.arrayBuffer();
    if (data.byteLength > MAX_WAVEFORM_BYTES) return { status: "too_large" };
    const audio = await ctx.decodeAudioData(data);
    if (!(audio.duration > 0) || audio.numberOfChannels < 1)
      return { status: "unavailable" };
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(audio.numberOfChannels, 2); c += 1)
      channels.push(audio.getChannelData(c));
    return {
      status: "ready",
      peaks: computePeaks(channels, bucketCount(audio.duration)),
      durationS: audio.duration,
    };
  } catch {
    return { status: "unavailable" };
  }
}

// One read per file per page: a signed link changes, the file does not.
const cache = new Map<string, Promise<PeaksResult>>();

/** {@link loadPeaks}, remembered by library file id. An answer that was only
 *  "unavailable" is forgotten so the next editor opened tries again (a link
 *  that had expired should not keep a file's waveform away for the session). */
export function peaksFor(
  assetId: string,
  url: string,
  knownDurationS: number | null,
): Promise<PeaksResult> {
  const hit = cache.get(assetId);
  if (hit) return hit;
  const p = loadPeaks(url, knownDurationS).then((r) => {
    if (r.status === "unavailable") cache.delete(assetId);
    return r;
  });
  cache.set(assetId, p);
  return p;
}

/** For tests: forget every remembered file. */
export function clearPeaksCache(): void {
  cache.clear();
}
