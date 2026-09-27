/**
 * API keys (migration 0031) — the pure half, shared by the browser that
 * creates a key and the server that checks one.
 *
 * A key is `nsk_live_` + 32 random bytes in base62 (43 characters). It is
 * generated in the admin's browser and shown once; only its SHA-256 (hex) and
 * the first 8 characters of its random part travel to the database, so the
 * key itself is never sent to this app's server or stored anywhere. The API
 * routes hash the presented key the same way and look the hash up.
 *
 * Web Crypto only (crypto.getRandomValues, crypto.subtle), so the same code
 * runs in the browser, in Node and in the tests.
 */

export const API_KEY_PREFIX = "nsk_live_";
export const API_KEY_SECRET_LENGTH = 43;
export const API_KEY_DISPLAY_LENGTH = 8;
export const API_KEY_RE = /^nsk_live_[0-9A-Za-z]{43}$/;
export const API_KEY_HASH_RE = /^[0-9a-f]{64}$/;
export const MAX_ACTIVE_KEYS = 10;

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Big-endian bytes as base62, left-padded to `length`. 32 bytes need 43
 *  characters (62^43 > 2^256), so no key is ever shorter than another. */
export function base62(bytes: Uint8Array, length = API_KEY_SECRET_LENGTH): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(length, "0");
}

export interface NewApiKey {
  /** The whole key: shown once, never stored. */
  key: string;
  /** The first 8 characters of the random part, for telling keys apart. */
  prefix: string;
}

export function generateApiKey(
  random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
): NewApiKey {
  const secret = base62(random(32));
  return { key: API_KEY_PREFIX + secret, prefix: secret.slice(0, API_KEY_DISPLAY_LENGTH) };
}

export function isWellFormedKey(key: unknown): key is string {
  return typeof key === "string" && API_KEY_RE.test(key);
}

/** The display prefix of a well-formed key, or null. */
export function keyPrefix(key: string): string | null {
  return isWellFormedKey(key) ? key.slice(API_KEY_PREFIX.length, API_KEY_PREFIX.length + API_KEY_DISPLAY_LENGTH) : null;
}

/** How a key is named on screen and in logs — never more of it than this. */
export function displayKey(prefix: string): string {
  return `${API_KEY_PREFIX}${prefix}…`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the database stores and looks up: the key's SHA-256, lower-case hex. */
export function hashApiKey(key: string): Promise<string> {
  return sha256Hex(key);
}

/**
 * The key from an `Authorization: Bearer nsk_live_…` header, or null when the
 * header is missing or is not one of our keys. A malformed value is refused
 * here, before any database call.
 */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return m && isWellFormedKey(m[1]) ? m[1] : null;
}
