import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient as createStatelessClient, type EmailOtpType } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";
import { publicOrigin } from "@/lib/server/public-origin";
import { joinFromCookie } from "@/lib/server/friend-invites";
import { safeNextPath } from "@/lib/safe-redirect";
import { callbackErrorFor, type CallbackError } from "@/lib/signup";
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
 */

// Only the types a sign-up confirmation (or an emailed sign-in link) can
// carry. A recovery or invite link is a different flow and is not completed
// from here.
const CONFIRM_TYPES: readonly EmailOtpType[] = ["signup", "email"];

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

function toLogin(origin: string, error: CallbackError, status = 307) {
  const url = new URL("/login", origin);
  url.searchParams.set("error", error);
  return redirect(url, status);
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
  const next = safeNextPath(url.searchParams.get("next"));

  // Supabase itself reports a spent or expired link on the redirect.
  if (url.searchParams.get("error") || url.searchParams.get("error_code"))
    return toLogin(origin, callbackErrorFor(url.searchParams.get("error_code")));

  const supabase = await createClient();
  if (!supabase) return toLogin(origin, "link_invalid");

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;

  try {
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) return toLogin(origin, callbackErrorFor(error.code));
      // The address is confirmed and the person is signed in: the one moment a
      // friend's invite link (cookie from /i/<token>) may count (migration 0092).
      await joinFromCookie(supabase);
      return redirect(new URL(next, origin));
    }
    if (tokenHash && type && CONFIRM_TYPES.includes(type)) {
      const { data, error } = await stateless().auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) return toLogin(origin, callbackErrorFor(error.code));
      const rt = data.session?.refresh_token;
      const email = data.user?.email ?? data.session?.user?.email;
      if (!rt || !email) return toLogin(origin, "link_invalid");
      const pending = encodePending({ rt, email, csrf: newCsrfToken(), iat: Math.floor(Date.now() / 1000) });
      (await cookies()).set(PENDING_COOKIE, pending, pendingCookieOptions());
      const confirm = new URL(AUTH_CONFIRM_PATH, origin);
      confirm.searchParams.set("next", next);
      return redirect(confirm);
    }
    return toLogin(origin, "link_invalid");
  } catch {
    return toLogin(origin, "link_invalid");
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
  const next = safeNextPath(String(form.get("next") ?? ""));

  // A cross-site POST changes nothing — not even the pending sign-in, which a
  // forged request must not be able to discard either.
  if (!sameOrigin) return toLogin(origin, "link_invalid", 303);
  jar.set(PENDING_COOKIE, "", pendingCookieOptions(0));
  if (!pending || !sameToken(csrf, pending.csrf)) return toLogin(origin, "link_invalid", 303);
  if (action !== "continue") return redirect(new URL("/login", origin), 303);

  const supabase = await createClient();
  if (!supabase) return toLogin(origin, "link_invalid", 303);
  try {
    const { error } = await supabase.auth.refreshSession({ refresh_token: pending.rt });
    if (error) return toLogin(origin, callbackErrorFor(error.code), 303);
    await joinFromCookie(supabase);
  } catch {
    return toLogin(origin, "link_invalid", 303);
  }
  return redirect(new URL(next, origin), 303);
}
