import { SOLUTIONS_PATH, SOLUTION_IDS, solutionHref } from "@/lib/solutions";

/**
 * Which URLs a signed-out visitor may see, and what the auth gate does with
 * every other one.
 *
 * Google's OAuth verification for `youtube.upload` requires a homepage that
 * describes the app and a Privacy Policy and Terms of Service on the same
 * domain, reachable without an account; Paddle's seller verification adds a
 * pricing page anyone can read before paying. Self-serve sign-up adds the
 * account form and the route its confirmation email lands on. Those pages are
 * the entire public surface. Everything else — every channel screen and every
 * API route — stays behind the sign-in exactly as before.
 *
 * Matching is exact on purpose. `/privacy` is public; `/privacy/videos` is not,
 * because the router resolves it as the Videos screen of a channel whose URL
 * segment happens to be "privacy". A prefix match here would have published
 * that screen to anyone.
 */

/** Always public: the legal pages Google's reviewers and users must be able to read. */
export const LEGAL_PATHS = ["/privacy", "/terms"] as const;

/** Always public: what a credit pack costs. Paddle's reviewers read it signed
 *  out, and a signed-in user sees the same page (plus the live credit rates).
 *  The API reference and its OpenAPI spec are read before anyone has a key. */
export const INFO_PATHS = ["/pricing", "/docs/api", "/docs/api/openapi.json"] as const;

/** Always public: what the product does, by who it is for (lib/solutions.ts).
 *  Listed one by one — the index and each page — never as a prefix. */
export const SOLUTION_PATHS = [SOLUTIONS_PATH, ...SOLUTION_IDS.map(solutionHref)] as const;

/**
 * The public API (migration 0031). Its callers are programs holding an API
 * key, never a browser session: each route authenticates the bearer key
 * itself, so the cookie gate must neither redirect them to /login nor spend a
 * Supabase round trip on a session they do not have. Exactly /api/v1 and the
 * paths under it — /api/v10 or /api/v1x are not the API and stay gated.
 */
export const PUBLIC_API_PREFIX = "/api/v1";

/** The MCP endpoint (Streamable HTTP): the same bearer keys, exactly this path. */
export const MCP_PATH = "/api/mcp";

export function isPublicApiPath(pathname: string): boolean {
  return pathname === PUBLIC_API_PREFIX || pathname.startsWith(PUBLIC_API_PREFIX + "/") || pathname === MCP_PATH;
}

/**
 * Media files behind a signed link (migration 0038,
 * app/api/media/file/[id]/[variant]). The HMAC in the query string is the
 * authorization — minted only after an RLS read under a member's session —
 * so the cookie gate neither redirects nor spends a Supabase round trip on
 * every range request a <video> makes. Exactly `/api/media/file/<id>/<variant>`.
 */
export const SIGNED_MEDIA_PREFIX = "/api/media/file/";

export function isSignedMediaPath(pathname: string): boolean {
  return /^\/api\/media\/file\/[0-9a-f-]{36}\/(original|thumb|proxy)$/.test(pathname);
}

/** Served as-is to anyone, signed in or not, without channel resolution. */
export const ALWAYS_PUBLIC_PATHS = [...LEGAL_PATHS, ...INFO_PATHS, ...SOLUTION_PATHS] as const;

/** Create an account. Like /login, only for someone signed out: a signed-in
 *  user asking for it is sent on to their app. */
export const SIGNUP_PATH = "/signup";

/** Where the confirmation email lands. Public because the person opening it is
 *  not signed in yet — this route is what signs them in. */
export const AUTH_CALLBACK_PATH = "/auth/callback";

/** "Continue as <email>?" for an emailed link that is not bound to this
 *  browser (lib/auth-confirm.ts). Public for the same reason as the callback:
 *  the person on it is not signed in yet, or is replacing an older session. */
export const AUTH_CONFIRM_PATH = "/auth/confirm";

/** First-run onboarding: needs a session, but sits outside the channel layout
 *  (a new account has no channel, and possibly no organization, to resolve). */
export const WELCOME_PATH = "/welcome";

/** Public for a signed-out visitor. `/` is the landing page for them; a signed-in
 *  user asking for `/` is sent on to their Command Center as before. */
export const PUBLIC_PATHS = ["/", ...ALWAYS_PUBLIC_PATHS, SIGNUP_PATH, AUTH_CALLBACK_PATH, AUTH_CONFIRM_PATH] as const;

/**
 * Top-level URL segments that are pages of their own, so no channel may take
 * one as its id — a channel called "privacy" would have its index shadowed by
 * the Privacy Policy.
 */
export const RESERVED_ROOT_SEGMENTS = [
  "login",
  "signup",
  "auth",
  "welcome",
  "privacy",
  "terms",
  "pricing",
  "solutions",
  "api",
  "docs",
] as const;

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

export function isSignupPath(pathname: string): boolean {
  return normalize(pathname) === SIGNUP_PATH;
}

export function isAuthCallbackPath(pathname: string): boolean {
  const p = normalize(pathname);
  return p === AUTH_CALLBACK_PATH || p === AUTH_CONFIRM_PATH;
}

export function isWelcomePath(pathname: string): boolean {
  return normalize(pathname) === WELCOME_PATH;
}

/**
 * What the middleware does with a request, given only who is asking.
 *
 * - `to-login`: signed out and not public — the app is private.
 * - `to-home`:  signed in and on /login or /signup — nothing to do there.
 * - `pass`:     serve as-is, without channel resolution (public pages, /login,
 *               /signup, the auth callback, and /welcome once signed in).
 * - `app`:      a signed-in app URL — resolve the channel as before, including
 *               redirecting `/` to the last channel viewed.
 */
export type GateDecision = "to-login" | "to-home" | "pass" | "app";

export function gateDecision(pathname: string, signedIn: boolean): GateDecision {
  if (isPublicApiPath(pathname)) return "pass";
  if (isLoginPath(pathname) || isSignupPath(pathname)) return signedIn ? "to-home" : "pass";
  if (isAlwaysPublicPath(pathname)) return "pass";
  // Either way: a confirmation link opened in a browser that still holds an
  // older session must be able to replace it.
  if (isAuthCallbackPath(pathname)) return "pass";
  if (isWelcomePath(pathname)) return signedIn ? "pass" : "to-login";
  if (!signedIn) return isPublicPath(pathname) ? "pass" : "to-login";
  return "app";
}
