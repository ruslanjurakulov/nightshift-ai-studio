import {
  AVATAR_MAX_ASPECT,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_SIDE,
  AVATAR_MIN_SIDE,
  type AvatarErrorCode,
} from "@/lib/avatar";

/**
 * What a stored profile photo must be, byte for byte: the one JPEG shape every
 * browser's canvas encoder produces, and nothing else.
 *
 *   FFD8                      SOI
 *   [APP0 "JFIF\0"]           only first, at most once
 *   [APP2 "ICC_PROFILE\0"]*   a colour profile (up to 16 pieces); no other APPn
 *   DQT+  [DHT]{0,4}  [DRI]   tables and an optional restart interval
 *   SOF0                      exactly one, baseline, 8-bit, 1 or 3 components
 *   SOS                       exactly one, its components matching the frame
 *   entropy-coded data        only stuffed FF00 and RSTn markers
 *   FFD9                      EOI, the very last two bytes
 *
 * APP1 (EXIF and XMP: GPS, camera, thumbnails), COM (free text), every other
 * APPn, progressive and arithmetic frames, a second scan, and any byte after
 * EOI are refused, so a stored photo cannot carry hidden metadata or a second
 * payload. Storage checks only the Content-Type header, so this is where "it is
 * really a JPEG" is decided, for the upload and for what is served back.
 *
 * Whether Safari's canvas encoder stays inside this shape is NOT verified (no
 * device here). `canonicalizeAvatarJpeg` is the client's safety net: it drops
 * APP1, COM and the other APPn segments from the encoder's output (the pixel
 * data is copied untouched) so an encoder that adds EXIF or a comment still
 * produces a file this validator accepts.
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

function isIcc(b: Uint8Array, s: Segment): boolean {
  return s.marker === 0xe2 && s.end - s.start >= 18 && hasAscii(b, s.start + 4, "ICC_PROFILE\0");
}
function isJfif(b: Uint8Array, s: Segment): boolean {
  return s.marker === 0xe0 && s.end - s.start >= 18 && hasAscii(b, s.start + 4, "JFIF\0");
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
  let icc = 0;
  for (const [i, s] of segs.entries()) {
    switch (s.marker) {
      case 0xe0:
        if (i !== 0 || !isJfif(b, s)) return { ok: false, code: "not_jpeg" };
        break;
      case 0xe2:
        if (!isIcc(b, s) || ++icc > 16) return { ok: false, code: "not_jpeg" };
        break;
      case 0xdb:
        dqt++;
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
  if (!sof || dqt === 0) return { ok: false, code: "not_jpeg" };

  // SOF0: length 8 + 3n, 8-bit samples, 1 or 3 components
  const n = b[sof.start + 9];
  const sos = segs[segs.length - 1];
  if (sof.end - sof.start !== 2 + 8 + 3 * n || b[sof.start + 4] !== 8 || (n !== 1 && n !== 3)) return { ok: false, code: "not_jpeg" };
  const height = u16(b, sof.start + 5);
  const width = u16(b, sof.start + 7);
  // SOS: one scan over all components, the baseline spectral range
  if (sos.end - sos.start !== 2 + 6 + 2 * n || b[sos.start + 4] !== n) return { ok: false, code: "not_jpeg" };
  if (b[sos.end - 3] !== 0 || b[sos.end - 2] !== 63 || b[sos.end - 1] !== 0) return { ok: false, code: "not_jpeg" };

  // The entropy-coded data: stuffed FF00 and RSTn only, then EOI as the last two bytes.
  const last = b.length - 2;
  if (last <= scanStart || b[last] !== 0xff || b[last + 1] !== 0xd9) return { ok: false, code: "not_jpeg" };
  for (let p = scanStart; p < last; ) {
    if (b[p] !== 0xff) {
      p++;
      continue;
    }
    const next = b[p + 1];
    if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) return { ok: false, code: "not_jpeg" };
    p += 2;
  }

  const lo = Math.min(width, height);
  const hi = Math.max(width, height);
  if (lo < AVATAR_MIN_SIDE || hi > AVATAR_MAX_SIDE || hi / lo > AVATAR_MAX_ASPECT) return { ok: false, code: "bad_dimensions" };
  return { ok: true, width, height };
}

/**
 * Rebuild an encoder's JPEG without the segments the validator refuses: APP1
 * (EXIF, XMP), COM and every APPn other than a leading JFIF and ICC profile
 * pieces. Only header segments are dropped; the scan is copied byte for byte.
 * null when the input is not a JPEG header at all. The result is NOT validated
 * here: run validateAvatarJpeg on it.
 */
export function canonicalizeAvatarJpeg(b: Uint8Array): Uint8Array | null {
  const walked = walkHeader(b);
  if (!walked) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  for (const [i, s] of walked.segs.entries()) {
    const droppable =
      (s.marker >= 0xe0 && s.marker <= 0xef && !(s.marker === 0xe0 && i === 0 && isJfif(b, s)) && !isIcc(b, s)) || s.marker === 0xfe;
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
