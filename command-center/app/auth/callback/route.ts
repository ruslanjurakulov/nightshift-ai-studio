import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient as createStatelessClient, type EmailOtpType } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";
import { publicOrigin } from "@/lib/server/public-origin";
import { joinFromCookie } from "@/lib/server/friend-invites";
import { applyPendingHandle, type HandleClient } from "@/lib/handles";
import { DEFAULT_AFTER_AUTH, safeLoginReturn } from "@/lib/safe-redirect";
import { callbackErrorFor, type CallbackError } from "@/lib/signup";
import { GOOGLE_PROVIDER, googleCallbackError, googleGate, type GoogleError } from "@/lib/google-signin";
import {
  FORGOT_PASSWORD_PATH,
  RECOVERY_COOKIE,
  RESET_PASSWORD_PATH,
  encodeRecovery,
  recoveryCookieOptions,
  type RecoveryNotice,
} from "@/lib/recovery";
import {
  AUTH_CONFIRM_PATH,
  PENDING_COOKIE,
  decodePending,
  encodePending,
  isSameOriginPost,
  newCsrfToken,
  pendingCookieOptions,
  sameToken,
} from "@/lib/auth-confirm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where the sign-up confirmation email lands.
 *
 * Supabase verifies the address first, then redirects here with a one-time
 * `code` (PKCE); exchanging it for a session is what signs the new user in.
 * That exchange needs the PKCE verifier from the cookies of the browser that
 * signed up, so the link only works there — it is bound to the person who
 * asked for it, and completes at once.
 *
 * A custom email template may instead send `token_hash` + `type`. Nothing
 * binds that link to a browser, so it is NOT turned into a session here: it is
 * verified into a pending sign-in and the person is asked, on /auth/confirm,
 * whether to continue as that account (lib/auth-confirm.ts explains the login
 * CSRF this prevents). The POST from that page finishes it. Either way the
 * session cookies are written through the same anon-key SSR client the rest of
 * the app uses — nothing here holds or needs the service key.
 *
 * `next` is attacker-writable (anyone can craft the link), so it only ever
 * resolves to a path on this origin; see lib/safe-redirect.ts.
 *
 * On failure the person is sent to /login with a fixed error code, never
 * Supabase's own text. The usual failure is benign: the link was opened in a
 * different browser from the one that signed up (the PKCE verifier lives in
 * that browser's cookies), in which case the address IS confirmed and signing
 * in with the password works.
 *
 * A PASSWORD-RECOVERY link takes the same two routes. The PKCE `code` (same
 * browser as the request) becomes a recovery session at once; a `token_hash`
 * with type=recovery (any browser) goes through the same "continue as <email>?"
 * step as every other unbound link, so opening someone else's reset link cannot
 * sign you into their account. Either way the session is marked for
 * /reset-password (lib/recovery.ts) and that is the only place it is sent; a
 * failed reset link goes to /forgot-password with a fixed notice, to ask for a
 * new one, rather than to /login.
 */

// Only the types a sign-up confirmation (or an emailed sign-in link) can
// carry. An invite link is a different flow and is not completed from here.
const CONFIRM_TYPES: readonly EmailOtpType[] = ["signup", "email"];
// A password-recovery link. Like the others it is verified into a PENDING
// sign-in (never a session) and finished on the "continue as <email>?" page; the
// session it becomes is a recovery session, sent to /reset-password.
const RECOVERY_TYPE: EmailOtpType = "recovery";

/** Responses in this flow are never framed, cached or leaked by Referer. */
const NO_FRAME: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
};

function redirect(url: URL, status = 307) {
  const res = NextResponse.redirect(url, status);
  for (const [k, v] of Object.entries(NO_FRAME)) res.headers.set(k, v);
  return res;
}

function toLogin(origin: string, error: CallbackError | GoogleError, status = 307) {
  const url = new URL("/login", origin);
  url.searchParams.set("error", error);
  return redirect(url, status);
}

/**
 * End a session this callback has just made and must not keep (the Google
 * gate said no). Logout is asked for first, but whatever it answers (an error,
 * a 5xx, a thrown network failure) the browser's sb-* auth cookies are expired
 * here too: the person is never left holding a session we refused.
 */
async function dropSession(supabase: { auth: { signOut: (o: { scope: "local" }) => PromiseLike<unknown> } }) {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    /* the cookies below are the part that must not fail */
  }
  try {
    const jar = await cookies();
    for (const c of jar.getAll()) if (c.name.startsWith("sb-")) jar.set(c.name, "", { path: "/", maxAge: 0 });
  } catch {
    /* a read-only cookie store: nothing more can be done from here */
  }
}

/** A failed reset link goes to the page that can ask for another, with a fixed notice. */
function toForgot(origin: string, notice: RecoveryNotice, status = 307) {
  const url = new URL(FORGOT_PASSWORD_PATH, origin);
  url.searchParams.set("s", notice);
  return redirect(url, status);
}

/** Mark this browser's session as a RECOVERY session for /reset-password (see lib/recovery.ts). */
async function markRecovery(userId: string) {
  (await cookies()).set(RECOVERY_COOKIE, encodeRecovery({ uid: userId, iat: Math.floor(Date.now() / 1000) }), recoveryCookieOptions());
}

/** A client that verifies a link without writing this browser's session. */
function stateless() {
  return createStatelessClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = publicOrigin(request);
  // safeLoginReturn: the same rule as before, plus the one longer path an AI app's connection request needs.
  const next = safeLoginReturn(url.searchParams.get("next"), DEFAULT_AFTER_AUTH);
  const google = url.searchParams.get("provider") === GOOGLE_PROVIDER;

  // A reset link that failed is sent where a new one can be asked for. A Google
  // attempt is never a reset link: its failures always go to /login.
  const recovering = !google && next === RESET_PASSWORD_PATH;

  // Supabase itself reports a spent or expired link on the redirect.
  if (url.searchParams.get("error") || url.searchParams.get("error_code")) {
    if (recovering) return toForgot(origin, "expired");
    return toLogin(origin, googleCallbackError(url.searchParams) ?? callbackErrorFor(url.searchParams.get("error_code")));
  }

  const supabase = await createClient();
  if (!supabase) return recovering ? toForgot(origin, "expired") : toLogin(origin, "link_invalid");

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;

  try {
    if (code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) return recovering ? toForgot(origin, "expired") : toLogin(origin, google ? "google_failed" : callbackErrorFor(error.code));
      // "Continue with Google" (lib/google-signin.ts): keep the session only if Google vouches for the address.
      // This gate runs BEFORE the recovery marker below and before anything
      // that treats the session as a signed-in account (invite, handle): a
      // session we refuse never reaches them, and a Google session can never be
      // turned into a recovery session.
      const denied = googleGate(data?.user, google);
      if (denied) {
        await dropSession(supabase);
        return toLogin(origin, denied);
      }
      // A password-recovery code (the browser that asked for it is this one:
      // the PKCE verifier proved it). The session is a recovery session: mark
      // it and go straight to the reset page, whatever `next` said.
      if ((data as { redirectType?: string | null } | null)?.redirectType === "PASSWORD_RECOVERY") {
        const uid = data?.user?.id ?? data?.session?.user?.id;
        if (!uid) return toForgot(origin, "expired");
        await markRecovery(uid);
        return redirect(new URL(RESET_PASSWORD_PATH, origin));
      }
      // The address is confirmed and the person is signed in: the one moment a
      // friend's invite link (cookie from /i/<token>) may count (migration 0092).
      await joinFromCookie(supabase);
      // The username chosen at sign-up goes on the account now that it has a session (quiet; never blocks).
      await applyPendingHandle(supabase as unknown as HandleClient);
      return redirect(new URL(next, origin));
    }
    if (tokenHash && type && (CONFIRM_TYPES.includes(type) || type === RECOVERY_TYPE)) {
      const rec = type === RECOVERY_TYPE;
      const { data, error } = await stateless().auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) return rec ? toForgot(origin, "expired") : toLogin(origin, callbackErrorFor(error.code));
      const rt = data.session?.refresh_token;
      const email = data.user?.email ?? data.session?.user?.email;
      if (!rt || !email) return rec ? toForgot(origin, "expired") : toLogin(origin, "link_invalid");
      const pending = encodePending({
        rt,
        email,
        csrf: newCsrfToken(),
        iat: Math.floor(Date.now() / 1000),
        ...(rec ? { rec: true } : {}),
      });
      (await cookies()).set(PENDING_COOKIE, pending, pendingCookieOptions());
      const confirm = new URL(AUTH_CONFIRM_PATH, origin);
      confirm.searchParams.set("next", rec ? RESET_PASSWORD_PATH : next);
      return redirect(confirm);
    }
    return recovering ? toForgot(origin, "expired") : toLogin(origin, "link_invalid");
  } catch {
    return recovering ? toForgot(origin, "expired") : toLogin(origin, "link_invalid");
  }
}

/**
 * The /auth/confirm form: `continue` turns the pending sign-in into this
 * browser's session, anything else drops it. Refused unless the POST comes
 * from our own page and echoes the pending sign-in's token.
 */
export async function POST(request: Request) {
  const origin = publicOrigin(request);
  const jar = await cookies();
  const pending = decodePending(jar.get(PENDING_COOKIE)?.value);
  const ours = [origin, new URL(request.url).origin];
  const sameOrigin = isSameOriginPost(request.headers, ours);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return toLogin(origin, "link_invalid", 303);
  }
  const csrf = String(form.get("csrf") ?? "");
  const action = String(form.get("action") ?? "");
  const next = safeLoginReturn(String(form.get("next") ?? ""), DEFAULT_AFTER_AUTH);

  // A cross-site POST changes nothing — not even the pending sign-in, which a
  // forged request must not be able to discard either.
  if (!sameOrigin) return toLogin(origin, "link_invalid", 303);
  jar.set(PENDING_COOKIE, "", pendingCookieOptions(0));
  if (!pending || !sameToken(csrf, pending.csrf)) return toLogin(origin, "link_invalid", 303);
  if (action !== "continue") return redirect(new URL("/login", origin), 303);

  const supabase = await createClient();
  if (!supabase) return toLogin(origin, "link_invalid", 303);
  try {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: pending.rt });
    if (pending.rec) {
      // A recovery session: marked for /reset-password, and never counted as a
      // new account for a friend's invite.
      if (error) return toForgot(origin, "expired", 303);
      const uid = data?.user?.id ?? data?.session?.user?.id;
      if (!uid) return toForgot(origin, "expired", 303);
      await markRecovery(uid);
      return redirect(new URL(RESET_PASSWORD_PATH, origin), 303);
    }
    if (error) return toLogin(origin, callbackErrorFor(error.code), 303);
    await joinFromCookie(supabase);
    await applyPendingHandle(supabase as unknown as HandleClient);
  } catch {
    return pending.rec ? toForgot(origin, "expired", 303) : toLogin(origin, "link_invalid", 303);
  }
  return redirect(new URL(next, origin), 303);
}
