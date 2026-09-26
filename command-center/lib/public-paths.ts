/**
 * Which URLs a signed-out visitor may see, and what the auth gate does with
 * every other one.
 *
 * Google's OAuth verification for `youtube.upload` requires a homepage that
 * describes the app and a Privacy Policy and Terms of Service on the same
 * domain, reachable without an account; Paddle's seller verification adds a
 * pricing page anyone can read before paying. Those four pages are the entire
 * public surface. Everything else — every channel screen and every API route —
 * stays behind the sign-in exactly as before.
 *
 * Matching is exact on purpose. `/privacy` is public; `/privacy/videos` is not,
 * because the router resolves it as the Videos screen of a channel whose URL
 * segment happens to be "privacy". A prefix match here would have published
 * that screen to anyone.
 */

/** Always public: the legal pages Google's reviewers and users must be able to read. */
export const LEGAL_PATHS = ["/privacy", "/terms"] as const;

/** Always public: what a credit pack costs. Paddle's reviewers read it signed
 *  out, and a signed-in user sees the same page (plus the live credit rates). */
export const INFO_PATHS = ["/pricing"] as const;

/** Served as-is to anyone, signed in or not, without channel resolution. */
export const ALWAYS_PUBLIC_PATHS = [...LEGAL_PATHS, ...INFO_PATHS] as const;

/** Public for a signed-out visitor. `/` is the landing page for them; a signed-in
 *  user asking for `/` is sent on to their Command Center as before. */
export const PUBLIC_PATHS = ["/", ...ALWAYS_PUBLIC_PATHS] as const;

/**
 * Top-level URL segments that are pages of their own, so no channel may take
 * one as its id — a channel called "privacy" would have its index shadowed by
 * the Privacy Policy.
 */
export const RESERVED_ROOT_SEGMENTS = ["login", "privacy", "terms", "pricing", "api"] as const;

/** Next's router treats `/terms/` as `/terms`; the gate must agree with it. */
function normalize(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
}

export function isLegalPath(pathname: string): boolean {
  return (LEGAL_PATHS as readonly string[]).includes(normalize(pathname));
}

export function isAlwaysPublicPath(pathname: string): boolean {
  return (ALWAYS_PUBLIC_PATHS as readonly string[]).includes(normalize(pathname));
}

export function isPublicPath(pathname: string): boolean {
  return (PUBLIC_PATHS as readonly string[]).includes(normalize(pathname));
}

export function isLoginPath(pathname: string): boolean {
  // Unchanged from the original gate, which matched the prefix.
  return pathname.startsWith("/login");
}

/**
 * What the middleware does with a request, given only who is asking.
 *
 * - `to-login`: signed out and not public — the app is private.
 * - `to-home`:  signed in and on /login — nothing to do there.
 * - `pass`:     serve as-is, without channel resolution (public pages, /login).
 * - `app`:      a signed-in app URL — resolve the channel as before, including
 *               redirecting `/` to the last channel viewed.
 */
export type GateDecision = "to-login" | "to-home" | "pass" | "app";

export function gateDecision(pathname: string, signedIn: boolean): GateDecision {
  if (isLoginPath(pathname)) return signedIn ? "to-home" : "pass";
  if (isAlwaysPublicPath(pathname)) return "pass";
  if (!signedIn) return isPublicPath(pathname) ? "pass" : "to-login";
  return "app";
}
