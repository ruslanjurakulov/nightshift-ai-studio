/**
 * The explicit "Continue as <email>" step of an emailed sign-in link (P2).
 *
 * An emailed link that carries `token_hash` is verified by the server alone:
 * nothing ties it to the browser that asked for it (the PKCE `code` flow is
 * tied — its verifier lives in that browser's cookies). Anyone can mint such a
 * link for their OWN account and get someone else to open it; signing the
 * opener straight in would put them in the attacker's account, where what they
 * type (a channel, a payment, a key) lands with the attacker. That is login
 * CSRF.
 *
 * So /auth/callback verifies the link into a PENDING sign-in instead of a
 * session: the new session's refresh token and its email go into a short-lived
 * httpOnly cookie, the browser is sent to /auth/confirm, which says whose
 * account this is, and only a same-origin POST of that page's form — carrying
 * the pending cookie's own random token — turns it into the real session.
 * A cross-site page can make a browser open the link, but it cannot read the
 * token, cannot make a SameSite=Lax cookie ride on its POST, and cannot click
 * "Continue" for the person who is looking at someone else's email address.
 *
 * Pure (no Next, no Supabase) so the decisions are unit-tested.
 */

export const PENDING_COOKIE = "ns_auth_pending";
/** Long enough to read the page; a pending sign-in is not a session. */
export const PENDING_MAX_AGE_SECONDS = 600;
export { AUTH_CONFIRM_PATH } from "@/lib/public-paths";

export interface PendingSignIn {
  /** The verified session's refresh token — the only way to finish it. */
  rt: string;
  email: string;
  /** Random, per pending sign-in; the confirm form must echo it back. */
  csrf: string;
  /** Unix seconds; a pending sign-in past PENDING_MAX_AGE_SECONDS is void. */
  iat: number;
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function newCsrfToken(random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  return Array.from(random(24), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function encodePending(p: PendingSignIn): string {
  return b64urlEncode(JSON.stringify(p));
}

/** The pending sign-in in a cookie value, or null when absent, malformed or expired. */
export function decodePending(value: string | null | undefined, nowSeconds = Math.floor(Date.now() / 1000)): PendingSignIn | null {
  if (!value || value.length > 8192) return null;
  try {
    const p = JSON.parse(b64urlDecode(value)) as Partial<PendingSignIn>;
    if (typeof p.rt !== "string" || !p.rt || typeof p.email !== "string" || !p.email) return null;
    if (typeof p.csrf !== "string" || !/^[0-9a-f]{48}$/.test(p.csrf)) return null;
    if (typeof p.iat !== "number" || nowSeconds - p.iat > PENDING_MAX_AGE_SECONDS || p.iat - nowSeconds > 60) return null;
    return { rt: p.rt, email: p.email, csrf: p.csrf, iat: p.iat };
  } catch {
    return null;
  }
}

/** Constant-time string equality for the CSRF token. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Did this POST come from our own page? The browser's Origin header (sent on
 * every cross-origin POST, and on same-origin POSTs by current browsers) must
 * be ours; `Sec-Fetch-Site`, when present, must say same-origin. A request
 * with neither is refused — a confirmation is never inferred.
 */
export function isSameOriginPost(headers: Headers, origins: readonly string[]): boolean {
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = headers.get("origin");
  if (!origin || origin === "null") return false;
  return origins.includes(origin);
}

/** Cookie options for the pending sign-in: this path only, never script-readable. */
export function pendingCookieOptions(maxAge: number = PENDING_MAX_AGE_SECONDS) {
  return {
    path: "/auth",
    maxAge,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}
