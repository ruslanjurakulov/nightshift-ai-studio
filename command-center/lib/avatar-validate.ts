import {
  AVATAR_MAX_ASPECT,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_SIDE,
  AVATAR_MIN_SIDE,
  type AvatarErrorCode,
} from "@/lib/avatar";
import { parseWebp } from "@/lib/image-header";

/** The chunks a still profile photo may carry. EXIF, XMP, ANIM, ANMF and anything unknown are refused. */
const ALLOWED_CHUNKS = new Set(["VP8X", "ICCP", "ALPH", "VP8 ", "VP8L"]);

export type AvatarCheck = { ok: true; width: number; height: number } | { ok: false; code: AvatarErrorCode };

/**
 * What the route requires of the bytes it was sent, whatever the sender claims.
 *
 * Storage checks the Content-Type header of an upload, not its contents, so
 * this is where "it is really a WebP" is decided: RIFF....WEBP magic, a header
 * that parses (lossy, lossless or extended), a still image (no animation flag,
 * no frame chunks), no trailing bytes after the RIFF container, no metadata
 * chunks, and a square-ish side of 64 to 512 pixels. The browser always sends
 * 256x256; the wider range is for other clients and costs nothing.
 */
export function validateAvatarWebp(bytes: Uint8Array): AvatarCheck {
  if (bytes.length > AVATAR_MAX_BYTES) return { ok: false, code: "too_large" };
  const info = parseWebp(bytes);
  if (!info || !info.exactLength || info.animated) return { ok: false, code: "not_webp" };
  if (!info.chunks.every((c) => ALLOWED_CHUNKS.has(c))) return { ok: false, code: "not_webp" };
  const { width, height } = info;
  const lo = Math.min(width, height);
  const hi = Math.max(width, height);
  if (lo < AVATAR_MIN_SIDE || hi > AVATAR_MAX_SIDE || hi / lo > AVATAR_MAX_ASPECT) {
    return { ok: false, code: "bad_dimensions" };
  }
  return { ok: true, width, height };
}

/** The magic bytes only: enough to refuse to serve something that is not a WebP back. */
export function looksLikeWebp(bytes: Uint8Array): boolean {
  return parseWebp(bytes) !== null;
}
