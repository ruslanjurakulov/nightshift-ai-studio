/**
 * Signs this browser out and says how far it got.
 *
 * The global sign-out asks the auth server to end the session, and supabase-js keeps the local session when that call
 * fails (offline, a 500). The person then lands on /login, the middleware sees a live cookie and bounces them straight
 * back in, while they believe they signed out (a lost or shared phone). So a failed or thrown global sign-out falls back
 * to `scope: "local"`, which only clears this browser's session and cannot fail on the network (as MfaChallenge does).
 *
 *  - "global": the server session ended too.
 *  - "local":  this browser is signed out; the server could not be reached, so other devices stay signed in.
 *  - "failed": even the local clear failed; the person is NOT signed out and must be told.
 */
export type SignOutOutcome = "global" | "local" | "failed";

type AuthLike = { signOut: (options?: { scope: "global" | "local" | "others" }) => PromiseLike<{ error: unknown } | void | undefined> };

export async function signOutThisBrowser(auth: AuthLike | null | undefined): Promise<SignOutOutcome> {
  if (!auth) return "failed";
  try {
    const res = await auth.signOut();
    if (!res || !res.error) return "global";
  } catch {
    /* fall through to the local clear */
  }
  try {
    const res = await auth.signOut({ scope: "local" });
    return res && res.error ? "failed" : "local";
  } catch {
    return "failed";
  }
}
