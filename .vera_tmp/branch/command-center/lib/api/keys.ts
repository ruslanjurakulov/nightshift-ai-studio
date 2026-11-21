/**
 * API keys (migrations 0031, 0040) — the pure half, shared by the browser that
 * creates a key and the server that checks one.
 *
 * A key is `nsk_live_` + 43 base62 characters (256 bits). Since migration
 * 0042 the database mints it (create_api_key), stores only its SHA-256 (hex)
 * and returns the whole key once, to the admin's browser, which shows it once
 * — a browser can no longer register a hash of a key it chose. No part of the
 * key — not a prefix, not a length, not a fragment — is stored, shown again or
 * logged (CLAUDE.md #1): keys are told apart by their name, id, creation and
 * last-use time. The API routes hash the presented key the same way and look
 * the hash up.
 *
 * Web Crypto only (crypto.getRandomValues, crypto.subtle), so the same code
 * runs in the browser, in Node and in the tests.
 */

export const API_KEY_PREFIX = "nsk_live_";
export const API_KEY_SECRET_LENGTH = 43;
export const API_KEY_RE = /^nsk_live_[0-9A-Za-z]{43}$/;
export const API_KEY_HASH_RE = /^[0-9a-f]{64}$/;
export const MAX_ACTIVE_KEYS = 10;

/** The columns the Developer console lists a key by: its name, id, times and
 *  what it may do (0062). Never the retired `prefix` column (0040) and never the hash. */
/** The list before 0062: what a deployment that has not applied it can still read. */
export const API_KEY_BASE_COLUMNS = "id,name,monthly_limit_cents,created_at,last_used_at,revoked_at";
export const API_KEY_LIST_COLUMNS =
  "id,name,monthly_limit_cents,created_at,last_used_at,revoked_at,scopes,rpm_limit,creative_monthly_credits";

/** What the browser sends to create_api_key (0042): which organization, a
 *  name and an optional limit — nothing of a key, which the database mints. */
export function createKeyArgs(orgId: string, name: string, limitCents: number | null) {
  return { p_org: orgId, p_name: name.slice(0, 60), p_monthly_limit_cents: limitCents };
}

/** The new key from create_api_key's result, or null when the result is not
 *  one of our keys (never shown half-formed). */
export function mintedKey(data: unknown): string | null {
  const key = data && typeof data === "object" ? (data as { key?: unknown }).key : undefined;
  return isWellFormedKey(key) ? key : null;
}

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
  /** A whole key in the production format — for tests and tooling; the
   *  Developer console's keys are minted by the database (0042). */
  key: string;
}

export function generateApiKey(
  random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
): NewApiKey {
  return { key: API_KEY_PREFIX + base62(random(32)) };
}

export function isWellFormedKey(key: unknown): key is string {
  return typeof key === "string" && API_KEY_RE.test(key);
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
