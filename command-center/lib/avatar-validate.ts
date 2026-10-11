import {
  AVATAR_MAX_ASPECT,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_SIDE,
  AVATAR_MIN_SIDE,
  type AvatarErrorCode,
} from "@/lib/avatar";

/**
 * What a stored profile photo must be: the one JPEG shape every browser's
 * canvas encoder produces, and nothing else.
 *
 *   FFD8                      SOI
 *   [APP0 "JFIF\0"]           only first, at most once, exactly 16 bytes (no thumbnail)
 *   [APP2 "ICC_PROFILE\0"]*   one colour profile: pieces numbered 1..n of n, at most
 *                             16 KB in all, 'acsp' at profile offset 36; no other APPn
 *   DQT (1..4)  DHT (0..4)  [DRI]
 *   SOF0                      exactly one, baseline, 8-bit, 1 or 3 components
 *   SOS                       exactly one, naming each frame component once
 *   entropy-coded data        only stuffed FF00, RSTn, and fill bytes (FF) before a marker
 *   FFD9                      EOI, the very last two bytes
 *
 * WHAT THIS GUARANTEES: the file has the structure above and nothing outside
 * it. There is no EXIF or XMP (APP1: GPS, camera, thumbnails), no COM (free
 * text), no other APPn, no progressive or arithmetic frame, no second scan, no
 * thumbnail, and no byte after EOI. Every channel left open is small and
 * bounded: tables (at most 4 + 4, each at most 64 KB by the marker's own
 * length), one ICC profile (16 KB), restart interval (2 bytes).
 *
 * WHAT IT DOES NOT: it does not decode. Table contents, the ICC profile body
 * and the entropy-coded data are not interpreted, so a file can still be
 * structurally right and not decode, or carry arbitrary bytes inside those
 * parts. That is acceptable here: the object is private to its owner, is served
 * only through /api/avatar with nosniff as image/jpeg, and only to that owner.
 * This is a gate on shape and size, not a proof that the content is a photo.
 * Storage checks only the Content-Type header, so this is where "it is
 * shaped like the JPEG a browser writes" is decided, for the upload and for
 * what is served back.
 *
 * Whether Safari's canvas encoder stays inside this shape is NOT verified (no
 * device here). `canonicalizeAvatarJpeg` is the client's safety net: it drops
 * APP1, COM, the other APPn segments, a JFIF with a thumbnail and an ICC
 * profile that does not pass the checks above from the encoder's output (the
 * scan is copied byte for byte), so an encoder that adds EXIF or a comment
 * still produces a file this validator accepts.
 */

export type AvatarCheck = { ok: true; width: number; height: number } | { ok: false; code: AvatarErrorCode };

interface Segment {
  marker: number;
  /** index of the 0xFF byte */
  start: number;
  /** index one past the segment's last byte */
  end: number;
}

const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const hasAscii = (b: Uint8Array, at: number, text: string) => {
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

/** SOI, then length-prefixed segments up to and including SOS. null when the header is not that. */
function walkHeader(b: Uint8Array): { segs: Segment[]; scanStart: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const segs: Segment[] = [];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    // fill bytes, stuffed zero, TEM, RSTn, SOI, EOI have no place before the scan
    if (marker === 0xff || marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) return null;
    const len = u16(b, i + 2);
    const end = i + 2 + len;
    if (len < 2 || end > b.length) return null;
    segs.push({ marker, start: i, end });
    if (marker === 0xda) return { segs, scanStart: end };
    i = end;
  }
  return null;
}

/** The largest colour profile kept: real sRGB and Display-P3 profiles are 0.5 to 3 KB. */
const ICC_MAX_BYTES = 16 * 1024;

/** An APP2 piece of an ICC profile: signature, then sequence number and piece count, then profile bytes. */
function isIccPiece(b: Uint8Array, s: Segment): boolean {
  return s.marker === 0xe2 && s.end - s.start >= 18 + 2 && hasAscii(b, s.start + 4, "ICC_PROFILE\0");
}

/**
 * The profile as a whole: every piece an ICC piece, numbered 1..n in order and all saying "of n", the profile
 * (pieces joined) no larger than ICC_MAX_BYTES, at least a 128-byte header whose size field equals its length and
 * whose 'acsp' signature sits at offset 36. Zero pieces is fine (no profile).
 */
function iccValid(b: Uint8Array, pieces: Segment[]): boolean {
  if (pieces.length === 0) return true;
  if (!pieces.every((s) => isIccPiece(b, s))) return false;
  const count = b[pieces[0].start + 17];
  if (count !== pieces.length) return false;
  let total = 0;
  for (const [i, s] of pieces.entries()) {
    if (b[s.start + 16] !== i + 1 || b[s.start + 17] !== count) return false;
    total += s.end - s.start - 18;
  }
  if (total < 128 || total > ICC_MAX_BYTES) return false;
  // joined profile bytes at offset 36 and the size field at offset 0
  const at = (off: number): number => {
    let rest = off;
    for (const s of pieces) {
      const len = s.end - s.start - 18;
      if (rest < len) return b[s.start + 18 + rest];
      rest -= len;
    }
    return -1;
  };
  const size = ((at(0) << 24) | (at(1) << 16) | (at(2) << 8) | at(3)) >>> 0;
  return size === total && at(36) === 0x61 && at(37) === 0x63 && at(38) === 0x73 && at(39) === 0x70; // 'acsp'
}

/** JFIF APP0 with no thumbnail: signature, version, units, densities and a 0x0 thumbnail make exactly 16 bytes of length. */
function isJfif(b: Uint8Array, s: Segment): boolean {
  return s.marker === 0xe0 && s.end - s.start === 18 && hasAscii(b, s.start + 4, "JFIF\0") && b[s.start + 16] === 0 && b[s.start + 17] === 0;
}

export function validateAvatarJpeg(b: Uint8Array): AvatarCheck {
  if (b.length > AVATAR_MAX_BYTES) return { ok: false, code: "too_large" };
  const walked = walkHeader(b);
  if (!walked) return { ok: false, code: "not_jpeg" };
  const { segs, scanStart } = walked;

  let sof: Segment | null = null;
  let dqt = 0;
  let dht = 0;
  let dri = 0;
  const icc: Segment[] = [];
  for (const [i, s] of segs.entries()) {
    switch (s.marker) {
      case 0xe0:
        if (i !== 0 || !isJfif(b, s)) return { ok: false, code: "not_jpeg" };
        break;
      case 0xe2:
        icc.push(s);
        break;
      case 0xdb:
        if (++dqt > 4) return { ok: false, code: "not_jpeg" };
        break;
      case 0xc4:
        if (++dht > 4) return { ok: false, code: "not_jpeg" };
        break;
      case 0xdd:
        if (++dri > 1 || s.end - s.start !== 6) return { ok: false, code: "not_jpeg" };
        break;
      case 0xc0:
        if (sof) return { ok: false, code: "not_jpeg" };
        sof = s;
        break;
      case 0xda:
        if (i !== segs.length - 1) return { ok: false, code: "not_jpeg" };
        break;
      default:
        // EXIF/XMP (APP1), COM, other APPn, progressive or arithmetic frames, DNL...
        return { ok: false, code: "not_jpeg" };
    }
  }
  if (!sof || dqt === 0 || !iccValid(b, icc)) return { ok: false, code: "not_jpeg" };

  // SOF0: length 8 + 3n, 8-bit samples, 1 or 3 components
  const n = b[sof.start + 9];
  const sos = segs[segs.length - 1];
  if (sof.end - sof.start !== 2 + 8 + 3 * n || b[sof.start + 4] !== 8 || (n !== 1 && n !== 3)) return { ok: false, code: "not_jpeg" };
  const height = u16(b, sof.start + 5);
  const width = u16(b, sof.start + 7);
  // SOS: one scan over all components, each named once and present in the frame, the baseline spectral range
  if (sos.end - sos.start !== 2 + 6 + 2 * n || b[sos.start + 4] !== n) return { ok: false, code: "not_jpeg" };
  const frameIds = new Set<number>();
  for (let i = 0; i < n; i++) frameIds.add(b[sof.start + 10 + 3 * i]);
  const scanIds = new Set<number>();
  for (let i = 0; i < n; i++) scanIds.add(b[sos.start + 5 + 2 * i]);
  if (frameIds.size !== n || scanIds.size !== n || ![...scanIds].every((id) => frameIds.has(id))) return { ok: false, code: "not_jpeg" };
  if (b[sos.end - 3] !== 0 || b[sos.end - 2] !== 63 || b[sos.end - 1] !== 0) return { ok: false, code: "not_jpeg" };

  // The entropy-coded data: stuffed FF00 and RSTn only, then EOI as the last two bytes.
  const last = b.length - 2;
  if (last <= scanStart || b[last] !== 0xff || b[last + 1] !== 0xd9) return { ok: false, code: "not_jpeg" };
  for (let p = scanStart; p < last; ) {
    if (b[p] !== 0xff) {
      p++;
      continue;
    }
    // Any number of 0xFF fill bytes may precede a marker (ITU T.81 B.1.1.2): skip them, then the marker byte decides.
    // A stuffed zero is only legal straight after the first FF.
    let q = p + 1;
    while (q <= last && b[q] === 0xff) q++;
    if (q === last + 1) break; // the fill ran into the final EOI
    const next = b[q];
    if (!(q === p + 1 && next === 0x00) && !(next >= 0xd0 && next <= 0xd7)) return { ok: false, code: "not_jpeg" };
    p = q + 1;
  }

  const lo = Math.min(width, height);
  const hi = Math.max(width, height);
  if (lo < AVATAR_MIN_SIDE || hi > AVATAR_MAX_SIDE || hi / lo > AVATAR_MAX_ASPECT) return { ok: false, code: "bad_dimensions" };
  return { ok: true, width, height };
}

/**
 * Rebuild an encoder's JPEG without what the validator refuses: APP1 (EXIF,
 * XMP), COM, every APPn other than a leading JFIF and ICC profile pieces, a JFIF
 * carrying a thumbnail, and an ICC profile that is not valid whole (too large,
 * mis-numbered, no 'acsp'). Only header segments are dropped; the scan is
 * copied byte for byte. null when the input is not a JPEG header at all. The
 * result is NOT validated here: run validateAvatarJpeg on it.
 */
export function canonicalizeAvatarJpeg(b: Uint8Array): Uint8Array | null {
  const walked = walkHeader(b);
  if (!walked) return null;
  // A profile that would not pass the validator is dropped whole (a slightly different colour beats a refused photo).
  const icc = walked.segs.filter((s) => isIccPiece(b, s));
  const keepIcc = iccValid(b, icc);
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  for (const [i, s] of walked.segs.entries()) {
    const app = s.marker >= 0xe0 && s.marker <= 0xef;
    const droppable =
      s.marker === 0xfe ||
      (app && s.marker === 0xe0 && !(i === 0 && isJfif(b, s))) ||
      (app && s.marker === 0xe2 && !(isIccPiece(b, s) && keepIcc)) ||
      (app && s.marker !== 0xe0 && s.marker !== 0xe2);
    if (!droppable) parts.push(b.subarray(s.start, s.end));
  }
  parts.push(b.subarray(walked.scanStart));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
