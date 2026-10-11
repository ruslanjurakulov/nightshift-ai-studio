/**
 * Read an image's declared size from its first bytes, without decoding it.
 *
 * A decoder allocates width x height x 4 bytes before it looks at a single
 * pixel, so a few hundred bytes that declare 60000x60000 can take a tab (or a
 * server) down. Both ends of the profile photo read the header first and
 * refuse before anything decodes: the browser before createImageBitmap
 * (lib/avatar-image.ts), the route before it stores what it was sent
 * (app/api/avatar). Pure functions over bytes, so they run the same in both.
 *
 * Every parser answers null for "I cannot read this" — truncated, wrong magic,
 * a zero side — and never throws. Null is a refusal, not a guess.
 */

export type ImageFormat = "png" | "jpeg" | "webp";

export interface ImageHeader {
  format: ImageFormat;
  width: number;
  height: number;
  /** WebP only: the file declares an animation (VP8X flag or ANIM/ANMF chunks). */
  animated: boolean;
}

const ascii = (b: Uint8Array, at: number, text: string): boolean => {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** PNG: the 8-byte signature, then IHDR must be the first chunk (length 13). */
export function parsePng(b: Uint8Array): ImageHeader | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((v, i) => b[i] === v)) return null;
  if (u32be(b, 8) !== 13 || !ascii(b, 12, "IHDR")) return null;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  if (width === 0 || height === 0) return null;
  return { format: "png", width, height, animated: false };
}

/**
 * JPEG: walk the marker segments to the first start-of-frame (SOF0..SOF15
 * except DHT, JPG and DAC). Segment lengths are bounded by the buffer, so a
 * crafted length cannot send the walk past the end or into a loop.
 */
export function parseJpeg(b: Uint8Array): ImageHeader | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    // Any number of 0xFF fill bytes may precede a marker.
    while (i < b.length && b[i] === 0xff) i++;
    const marker = b[i++];
    if (marker === undefined) return null;
    // Markers with no length: TEM, RSTn, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) return null;
      continue;
    }
    // Start of scan before any frame header: nothing usable.
    if (marker === 0xda || marker === 0x00) return null;
    if (i + 2 > b.length) return null;
    const len = u16be(b, i);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 8 || i + 7 > b.length) return null;
      const height = u16be(b, i + 3);
      const width = u16be(b, i + 5);
      // height 0 means "defined later by a DNL marker": not something to trust.
      if (width === 0 || height === 0) return null;
      return { format: "jpeg", width, height, animated: false };
    }
    i += len;
  }
  return null;
}

/** The chunk walk's view of a WebP: what a RIFF container says it holds. */
export interface WebpInfo extends ImageHeader {
  format: "webp";
  /** Four-character codes of the chunks, in order. */
  chunks: string[];
  /** The RIFF size field plus 8 equals the number of bytes given (no truncation, no trailing bytes). */
  exactLength: boolean;
}

/**
 * WebP: RIFF....WEBP, then the first chunk says which flavour it is.
 *   "VP8 "  lossy: 14-bit width and height after the 3-byte frame tag and start code
 *   "VP8L"  lossless: signature 0x2f, then 14-bit width-1 and height-1
 *   "VP8X"  extended: 24-bit canvas width-1 / height-1 and a flags byte (animation = 0x02)
 * For VP8X the image chunk is found too and its own size must match the canvas.
 */
export function parseWebp(b: Uint8Array): WebpInfo | null {
  if (b.length < 20 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  const riff = u32le(b, 4);
  const exactLength = riff + 8 === b.length;
  // A RIFF size that claims more than we were given is a truncated file.
  if (riff + 8 > b.length || riff < 4) return null;

  const chunks: string[] = [];
  let width = 0;
  let height = 0;
  let animated = false;
  let inner: { width: number; height: number } | null = null;
  let canvas: { width: number; height: number } | null = null;

  let pos = 12;
  const end = Math.min(b.length, riff + 8);
  while (pos + 8 <= end) {
    const id = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]);
    const size = u32le(b, pos + 4);
    const data = pos + 8;
    if (data + size > end) return null;
    chunks.push(id);

    if (id === "VP8X") {
      if (size < 10 || chunks.length !== 1) return null;
      animated = (b[data] & 0x02) !== 0;
      canvas = { width: u24le(b, data + 4) + 1, height: u24le(b, data + 7) + 1 };
    } else if (id === "VP8 ") {
      // frame tag (3 bytes, bit 0 clear = key frame), start code 9d 01 2a, then the sizes
      if (size < 10 || (b[data] & 1) !== 0 || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return null;
      inner = { width: u16le(b, data + 6) & 0x3fff, height: u16le(b, data + 8) & 0x3fff };
    } else if (id === "VP8L") {
      if (size < 5 || b[data] !== 0x2f) return null;
      const bits = u32le(b, data + 1);
      inner = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (id === "ANIM" || id === "ANMF") {
      animated = true;
    }
    pos = data + size + (size & 1);
  }

  if (chunks.length === 0 || (chunks[0] !== "VP8X" && chunks[0] !== "VP8 " && chunks[0] !== "VP8L")) return null;
  if (canvas) {
    // An animation has no single bitstream to read; its canvas is the answer.
    if (!animated && inner && (inner.width !== canvas.width || inner.height !== canvas.height)) return null;
    width = canvas.width;
    height = canvas.height;
  } else if (inner) {
    width = inner.width;
    height = inner.height;
  }
  if (width === 0 || height === 0) return null;
  return { format: "webp", width, height, animated, chunks, exactLength };
}

/** Sniff the format from the magic bytes and read its header; null when it is none of the three or is unreadable. */
export function readImageHeader(b: Uint8Array): ImageHeader | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50) return parsePng(b);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8) return parseJpeg(b);
  if (b.length >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return parseWebp(b);
  return null;
}
