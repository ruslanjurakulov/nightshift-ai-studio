/**
 * Does this browser hold a Supabase session cookie (`sb-<ref>-auth-token`, or its first chunk `.0`)? A HINT for the public
 * pages' header only: they are static, so the server cannot ask who is signed in without making every one of them dynamic.
 * The cookie is not HttpOnly (the browser client reads it, lib/supabase/cookie-options.ts), so its NAME is visible to the page;
 * its value is never read here. An expired session still has the cookie: the "Open app" link then goes through the middleware
 * gate like any app URL and lands on sign-in, so a stale hint costs one redirect and grants nothing.
 */
export const SESSION_COOKIE = /(?:^|;\s*)sb-[^=;\s]+-auth-token(?:\.0)?=[^;]/;

export function hasSessionCookie(cookie: string): boolean {
  return SESSION_COOKIE.test(cookie);
}

/**
 * Where "Open app" goes: the every-channel index, which sends each account to its own start (the owner's console, an
 * operator's Command Center, a customer's Home on their first channel: app/(app)/[channel]/page.tsx).
 */
export const APP_HOME = "/all-channels";
