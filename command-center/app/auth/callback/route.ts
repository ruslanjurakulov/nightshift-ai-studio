import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { publicOrigin } from "@/lib/server/public-origin";
import { safeNextPath } from "@/lib/safe-redirect";
import { callbackErrorFor, type CallbackError } from "@/lib/signup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where the sign-up confirmation email lands.
 *
 * Supabase verifies the address first, then redirects here with a one-time
 * `code` (PKCE); exchanging it for a session is what signs the new user in.
 * A custom email template may instead send `token_hash` + `type`, which is
 * verified here directly. Either way the session cookies are written through
 * the same anon-key SSR client the rest of the app uses — nothing here holds
 * or needs the service key.
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

// Only the types a sign-up confirmation can carry. A recovery or invite link
// is a different flow and is not completed from here.
const CONFIRM_TYPES: readonly EmailOtpType[] = ["signup", "email"];

function toLogin(origin: string, error: CallbackError) {
  const url = new URL("/login", origin);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url);
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
    } else if (tokenHash && type && CONFIRM_TYPES.includes(type)) {
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) return toLogin(origin, callbackErrorFor(error.code));
    } else {
      return toLogin(origin, "link_invalid");
    }
  } catch {
    return toLogin(origin, "link_invalid");
  }

  return NextResponse.redirect(new URL(next, origin));
}
