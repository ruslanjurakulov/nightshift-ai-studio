/**
 * Opaque OAuth secrets: 256 random bits, a recognisable prefix, base64url.
 * The database stores only the SHA-256 of a token or code (migration 0093);
 * a plaintext one exists in memory long enough to be sent once.
 *
 * Web Crypto only, so the same code runs in the route handlers and the tests.
 */

import { sha256Hex } from "@/lib/api/keys";

export const ACCESS_PREFIX = "nso_at_";
export const REFRESH_PREFIX = "nso_rt_";
export const CODE_PREFIX = "nso_ac_";
export const REQUEST_PREFIX = "nso_rq_";

const B64URL = "[A-Za-z0-9_-]{43}";
export const ACCESS_TOKEN_RE = new RegExp(`^${ACCESS_PREFIX}${B64URL}$`);
export const REFRESH_TOKEN_RE = new RegExp(`^${REFRESH_PREFIX}${B64URL}$`);
export const CODE_RE = new RegExp(`^${CODE_PREFIX}${B64URL}$`);
export const REQUEST_SECRET_RE = new RegExp(`^${REQUEST_PREFIX}${B64URL}$`);

function randomB64url(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(32);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const newAccessToken = () => ACCESS_PREFIX + randomB64url();
export const newRefreshToken = () => REFRESH_PREFIX + randomB64url();
export const newAuthorizationCode = () => CODE_PREFIX + randomB64url();
export const newRequestSecret = () => REQUEST_PREFIX + randomB64url();

export const hashSecret = sha256Hex;

/** base64url(SHA-256(verifier)) — the PKCE S256 challenge (RFC 7636 4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 4.1: 43 to 128 characters of unreserved characters. */
export const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export type Bearer =
  | { kind: "none" }
  | { kind: "api_key" }
  | { kind: "oauth"; token: string }
  | { kind: "other" };

/** Which door a bearer credential asks for. Only the shape is looked at here;
 *  the database decides whether it is real. */
export function classifyBearer(header: string | null | undefined): Bearer {
  if (!header) return { kind: "none" };
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  if (!m) return { kind: "other" };
  if (m[1].startsWith("nsk_live_")) return { kind: "api_key" };
  if (ACCESS_TOKEN_RE.test(m[1])) return { kind: "oauth", token: m[1] };
  return { kind: "other" };
}
