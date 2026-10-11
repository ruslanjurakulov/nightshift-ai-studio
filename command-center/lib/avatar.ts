/**
 * The profile photo, as plain facts the page and the route agree on.
 *
 * A photo is one private object per person (`avatars/<uid>/avatar.webp`,
 * migration 0097). What the page knows about it is a single number, `avatar_v`,
 * kept in the person's auth user_metadata: when it is set, a photo exists and
 * `/api/avatar?v=<n>` serves it. The number is a cache-buster and nothing
 * more — the person can write any value into their own metadata, so the route
 * never reads it, and the path it serves is always built from the session.
 */

/** The bucket and the one object name inside each person's folder. */
export const AVATAR_BUCKET = "avatars";
export const AVATAR_FILE = "avatar.webp";
export const avatarPath = (uid: string): string => `${uid}/${AVATAR_FILE}`;

export const AVATAR_ENDPOINT = "/api/avatar";
export const AVATAR_META_KEY = "avatar_v";

/** What is stored: a 256x256 WebP, never more than the bucket's 256 KB. */
export const AVATAR_SIZE = 256;
export const AVATAR_MAX_BYTES = 262_144;
/** The route accepts a square-ish side in this range (the browser always sends 256). */
export const AVATAR_MIN_SIDE = 64;
export const AVATAR_MAX_SIDE = 512;
/** Width and height may differ by at most this ratio. */
export const AVATAR_MAX_ASPECT = 1.1;

/** What a person may pick: size and pixel limits are checked on the header bytes, before any decode. */
export const AVATAR_INPUT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const AVATAR_INPUT_ACCEPT = AVATAR_INPUT_TYPES.join(",");
export const AVATAR_INPUT_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_INPUT_MAX_SIDE = 8192;
export const AVATAR_INPUT_MAX_PIXELS = 40_000_000;

/** The sizes the Avatar draws, in CSS pixels. */
export const AVATAR_SIZES = [24, 32, 40, 64, 96] as const;
export type AvatarSizePx = (typeof AVATAR_SIZES)[number];

/** Every refusal the route and the uploader can name. Fixed codes; never storage or SQL text. */
export const AVATAR_ERRORS = [
  "unauthorized",
  "forbidden",
  "too_large",
  "not_webp",
  "bad_dimensions",
  "rate_limited",
  "unsupported",
  "unreadable",
  "image_too_large",
  "encode_unsupported",
  "failed",
] as const;
export type AvatarErrorCode = (typeof AVATAR_ERRORS)[number];

export function isAvatarErrorCode(v: unknown): v is AvatarErrorCode {
  return typeof v === "string" && (AVATAR_ERRORS as readonly string[]).includes(v);
}

/**
 * The version marker in a user's metadata, or null. Only a positive safe
 * integer counts (the route hands out a millisecond timestamp); a string, a
 * float, zero, a negative or null all mean "no photo", so a hand-edited value
 * can at worst show the initial instead of a photo.
 */
export function avatarVersionFromMetadata(meta: unknown): number | null {
  if (!meta || typeof meta !== "object") return null;
  const v = (meta as Record<string, unknown>)[AVATAR_META_KEY];
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** The image URL for a version, or null when there is no photo. */
export function avatarSrc(version: number | null | undefined): string | null {
  return typeof version === "number" && Number.isSafeInteger(version) && version > 0
    ? `${AVATAR_ENDPOINT}?v=${version}`
    : null;
}

/**
 * The letter shown in the circle when there is no photo: the first character of
 * the e-mail, upper-cased. A code point, not a UTF-16 unit (an address may start
 * with a letter outside the BMP). Anything that is not a letter or a digit (a
 * dot, an underscore, an empty string) gives null, which the Avatar draws as
 * the neutral person icon rather than a stray punctuation mark.
 */
export function avatarInitial(email: string | null | undefined): string | null {
  const first = Array.from((email ?? "").trim())[0];
  if (!first || !/^[\p{L}\p{N}]$/u.test(first)) return null;
  // "ß".toUpperCase() is "SS": keep one character.
  return Array.from(first.toUpperCase())[0] ?? null;
}
