/**
 * Signs this browser out and says how far it got.
 *
 * supabase-js asks the auth server to end the session, and keeps the local session when that call fails (offline, a
 * 500). That holds for `scope: "local"` too: auth-js still POSTs /auth/v1/logout?scope=local and returns the error
 * without removing the session. So during an auth outage the library cannot sign this browser out at all, and the person
 * would land on /login, be bounced straight back into the app by the middleware, and believe they had signed out (a lost
 * or shared phone). The fallback therefore removes the session itself: the `sb-*-auth-token*` cookies (not HttpOnly, by
 * design: lib/supabase/cookie-options.ts) and the matching localStorage keys, then checks they are gone.
 *
 *  - "global":  the server session ended too.
 *  - "local":   the library's local sign-out worked (the server call had failed).
 *  - "cleared": the library could not, so the session cookies/keys were removed here. This browser is signed out; the
 *               server could not be reached, so the session is NOT revoked there. The person is told.
 *  - "failed":  the session is still in this browser after all of that; the person is NOT signed out and must be told.
 */
export type SignOutOutcome = "global" | "local" | "cleared" | "failed";

type AuthLike = { signOut: (options?: { scope: "global" | "local" | "others" }) => PromiseLike<{ error: unknown } | void | undefined> };

/** The Supabase auth cookie and its chunks (`sb-<ref>-auth-token`, `sb-<ref>-auth-token.0`, ...). */
const AUTH_COOKIE = /^sb-.+-auth-token(?:\.\d+)?$/;
const AUTH_STORAGE = /^sb-.+-auth-token/;

export interface SessionEnv {
  cookieNames(): string[];
  expireCookie(name: string): void;
  storageKeys(): string[];
  removeStorage(key: string): void;
}

export function browserSessionEnv(): SessionEnv {
  return {
    cookieNames: () => {
      try {
        return document.cookie
          .split(";")
          .map((c) => c.split("=")[0]?.trim() ?? "")
          .filter(Boolean);
      } catch {
        return [];
      }
    },
    expireCookie: (name) => {
      try {
        const secure = window.location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${secure}`;
      } catch {
        /* cookies blocked: the check below says the session is still there */
      }
    },
    storageKeys: () => {
      try {
        return Object.keys(window.localStorage);
      } catch {
        return [];
      }
    },
    removeStorage: (key) => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* nothing to remove, or blocked */
      }
    },
  };
}

/** Removes this browser's Supabase session by hand; true when no session cookie is left. */
export function clearSessionByHand(env: SessionEnv): boolean {
  for (const name of env.cookieNames()) if (AUTH_COOKIE.test(name)) env.expireCookie(name);
  for (const key of env.storageKeys()) if (AUTH_STORAGE.test(key)) env.removeStorage(key);
  return !env.cookieNames().some((n) => AUTH_COOKIE.test(n));
}

export async function signOutThisBrowser(
  auth: AuthLike | null | undefined,
  env: SessionEnv = browserSessionEnv(),
): Promise<SignOutOutcome> {
  if (auth) {
    try {
      const res = await auth.signOut();
      if (!res || !res.error) return "global";
    } catch {
      /* fall through */
    }
    try {
      const res = await auth.signOut({ scope: "local" });
      if (!res || !res.error) return "local";
    } catch {
      /* fall through */
    }
  }
  return clearSessionByHand(env) ? "cleared" : "failed";
}
