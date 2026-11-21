import { parseCookieHeader, serializeCookieHeader, type CookieOptions } from "@supabase/ssr";

/**
 * How the Supabase session cookie is written (ledger BR-S-021; docs/security/ADMIN_MFA.md,
 * "Session cookie").
 *
 * @supabase/ssr 0.5.x writes every auth cookie with `{ path: "/", sameSite: "lax", httpOnly: false,
 * maxAge: 400 days }` and, by design, IGNORES a `maxAge` passed in `cookieOptions` (its storage code sets
 * `maxAge: DEFAULT_COOKIE_OPTIONS.maxAge` after spreading the caller's options; only `secure`, `sameSite`,
 * `path` and `domain` survive). So the options are hardened where the cookie is actually WRITTEN, in the
 * `setAll` of each client (server, middleware, browser), by `hardenSessionCookie`:
 *
 * - `Secure` in a production build: the cookie is never sent over plain http. (`next dev` and tests are
 *   unchanged. Chrome and Firefox also accept a Secure cookie on http://localhost.)
 * - `SameSite=Lax`, never `None` (and `Strict` is kept if a caller asked for it).
 * - A 30-day lifetime instead of 400, ROLLING: every token refresh (about hourly while the person uses the
 *   site, in the middleware or the browser client) rewrites the cookie with a fresh 30 days, so an active
 *   session never expires and an abandoned browser stops being signed in after 30 days. The real session
 *   life is still the Supabase refresh token; this only bounds how long the cookie itself lingers.
 * - A deletion (`maxAge` 0 or less) is left alone.
 *
 * `httpOnly` stays OFF, on purpose: the browser client (components that sign in, enrol a factor, subscribe
 * to Realtime) reads the session from `document.cookie`, and an HttpOnly cookie would make every one of
 * them see "signed out". That is why a script-injection bug is dangerous here and why the Content-Security-Policy
 * matters (docs/security/CSP.md).
 */

export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function hardenSessionCookie(
  options: CookieOptions | undefined,
  production: boolean = process.env.NODE_ENV === "production",
): CookieOptions {
  const next: CookieOptions = { path: "/", ...options };
  next.sameSite = next.sameSite === "strict" ? "strict" : "lax";
  if (production) next.secure = true;
  const maxAge = typeof next.maxAge === "number" ? next.maxAge : SESSION_COOKIE_MAX_AGE_SECONDS;
  next.maxAge = maxAge <= 0 ? maxAge : Math.min(maxAge, SESSION_COOKIE_MAX_AGE_SECONDS);
  return next;
}

/**
 * The browser client's cookie storage: what @supabase/ssr does by default with `document.cookie`, with the
 * same hardening on every write. Outside a browser it reads nothing and refuses to write, as the default does.
 */
export function browserCookieStorage(production?: boolean) {
  return {
    getAll() {
      return typeof document === "undefined" ? [] : parseCookieHeader(document.cookie);
    },
    setAll(cookies: { name: string; value: string; options: CookieOptions }[]) {
      if (typeof document === "undefined") {
        throw new Error("browser cookie storage was used outside a browser");
      }
      for (const { name, value, options } of cookies) {
        document.cookie = serializeCookieHeader(name, value, hardenSessionCookie(options, production));
      }
    },
  };
}
