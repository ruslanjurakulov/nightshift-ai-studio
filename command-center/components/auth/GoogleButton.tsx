"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/config";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { AuthAlert } from "@/components/auth/AuthShell";
import { GOOGLE_PROVIDER, googleRedirectTo, isGoogleError, type GoogleError } from "@/lib/google-signin";
import { DEFAULT_AFTER_AUTH } from "@/lib/safe-redirect";
import "@/components/auth/google-button.css";

/** Google's multi-colour "G", from Google's sign-in branding assets, unaltered. */
function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/**
 * "Continue with Google", above the email form on /login and /signup, with the
 * "or" divider under it. An outlined neutral button on purpose: the email
 * submit stays the page's one filled key.
 *
 * The click only starts the round trip (supabase.auth.signInWithOAuth, PKCE);
 * the session is made by /auth/callback, which also applies the verified-email
 * gate and the friend-invite cookie exactly as for a confirmed sign-up. A
 * failed attempt comes back as /login?error=<fixed code> and is shown here
 * from the closed set in lib/google-signin.ts, never from the URL's text.
 *
 * On /signup the line under the button carries the same consent the form's
 * checkbox does, because this button creates an account without that form.
 */
export function GoogleButton({ mode }: { mode: "signin" | "signup" }) {
  const { t } = usePublicI18n();
  const g = t.site.auth.google;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<GoogleError | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (isGoogleError(code)) setFailed(code);
  }, []);

  // Back from Google with the browser's back button can restore this page from
  // the back/forward cache with the button still "busy": clear it.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const messages: Record<GoogleError, string> = {
    google_denied: g.errDenied,
    google_unverified: g.errUnverified,
    google_failed: g.errFailed,
  };

  async function onClick() {
    if (busy) return;
    const supabase = createClient();
    if (!supabase) return;
    setFailed(null);
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: GOOGLE_PROVIDER,
        options: {
          redirectTo: googleRedirectTo(
            window.location.origin,
            new URLSearchParams(window.location.search).get("next"),
            mode === "signup" ? DEFAULT_AFTER_AUTH : "/command-center",
          ),
        },
      });
      // On success the browser is already on its way to Google.
      if (error) throw error;
    } catch {
      setFailed("google_failed");
      setBusy(false);
    }
  }

  const link =
    "-my-[14px] inline-block min-w-11 py-[14px] underline decoration-[var(--ns-rule-strong)] underline-offset-4 text-[var(--ns-text)] hover:text-[var(--st-act-ink)]";

  return (
    <div className="ns-google mt-8">
      {failed && <AuthAlert tone="fail">{messages[failed]}</AuthAlert>}
      <button
        type="button"
        className="ns-google-btn"
        onClick={onClick}
        disabled={!isSupabaseConfigured}
        aria-busy={busy || undefined}
      >
        {/* The mark and the spinner share one 18px box, so pressing the button moves nothing. */}
        {busy ? <span className="ns-google-spin" aria-hidden="true" /> : <GoogleG />}
        <span>{g.button}</span>
      </button>
      {mode === "signup" && (
        <p className="ns-google-consent">
          {g.consentPre}{" "}
          <Link href="/terms" target="_blank" className={link}>
            {g.terms}
          </Link>{" "}
          {g.consentAnd}{" "}
          <Link href="/privacy" target="_blank" className={link}>
            {g.privacy}
          </Link>
          {g.consentPost}
        </p>
      )}
      <div className="ns-google-or" aria-hidden="true">
        <span>{g.or}</span>
      </div>
    </div>
  );
}
