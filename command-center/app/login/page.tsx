"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/config";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { AuthAlert, AuthField, AuthShell, AuthSubmit } from "@/components/auth/AuthShell";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { SavedAccounts } from "@/components/auth/SavedAccounts";
import { useGoogleEnabled } from "@/components/auth/google-enabled-context";
import { safeLoginReturn, studioNext } from "@/lib/safe-redirect";
import { clearAllDrafts } from "@/lib/create-draft";
import { applyPendingHandle, type HandleClient } from "@/lib/handles";
import { retryInviteJoin } from "@/lib/friend-invites";
import { FORGOT_PASSWORD_PATH } from "@/lib/public-paths";
import { mfaVerifyUrl } from "@/lib/security/admin-mfa";
import { signInNextStep, type MfaClient } from "@/lib/security/challenge";
import { carriesPending, discardPending } from "@/lib/site/pending-attachment";
import { classifySignInError, isCallbackError, type CallbackError, type SignInOutcome } from "@/lib/signup";

export default function LoginPage() {
  const router = useRouter();
  const { t } = usePublicI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The way back, for someone without an account yet: a Studio form they came for (the landing's idea box) goes with them to sign-up.
  const [signupHref, setSignupHref] = useState("/signup");
  useEffect(() => {
    const next = studioNext(new URLSearchParams(window.location.search).get("next"));
    if (next) setSignupHref(`/signup?next=${encodeURIComponent(next)}`);
  }, []);
  const [linkError, setLinkError] = useState<CallbackError | null>(null);
  // With Google offered, it is the first and primary way in and the e-mail submit is the quiet key under it.
  const google = useGoogleEnabled();

  // Whoever arrives here — signed out, session expired, or switching accounts — leaves no create draft behind in this tab.
  useEffect(() => {
    clearAllDrafts();
  }, []);

  // /auth/callback sends a failed confirmation link here with a fixed code.
  // Read once on mount, from a closed set — never text from the URL.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (isCallbackError(code)) setLinkError(code);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLinkError(null);
    const supabase = createClient();
    // With sign-in switched off the form is disabled and the notice above it
    // already says why; nothing is sent and nothing is repeated as an error.
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      // Supabase's wording changes between releases and is written for
      // developers; the person gets what to do next instead.
      const messages: Record<SignInOutcome, string> = {
        invalid_credentials: t.signup.loginInvalid,
        email_not_confirmed: t.signup.loginNotConfirmed,
        rate_limited: t.signup.loginRateLimited,
        failed: t.signup.loginFailed,
      };
      setError(messages[classifySignInError(error)]);
      return;
    }
    // A username chosen at sign-up whose account was confirmed in another
    // browser has not been applied yet: do it now (quiet; never blocks sign-in).
    await applyPendingHandle(supabase as unknown as HandleClient);
    // A friend's invite cookie the confirmation callback could not use (its join failed and was kept): tried once more now
    // that this account is signed in. Bounded, not awaited, and silent: it never holds the sign-in up.
    void retryInviteJoin();
    // A connection request from an AI app sent this person here: back to it
    // (only that exact page is honoured), otherwise the app as always.
    const destination = safeLoginReturn(new URLSearchParams(window.location.search).get("next"), "/command-center");
    // A file kept from the home page (lib/site/pending-attachment.ts) is for the sign-in that carries its link; any other sign-in in
    // this browser removes it, so it is never offered to an account that did not attach it.
    if (!carriesPending(destination)) await discardPending();
    // An account with an authenticator is not signed in yet: the password made a
    // password-only session, and the code makes it complete. Nothing is pushed
    // to the app before that; /login/verify asks the server again and moves on
    // at once for anyone who needs no code.
    const step = await signInNextStep(supabase as unknown as MfaClient);
    router.push(step === "challenge" ? mfaVerifyUrl(destination) : destination);
    router.refresh();
  }

  return (
    <AuthShell title={t.site.auth.signInTitle} subtitle={t.site.auth.signInSub}>
      {!isSupabaseConfigured && (
        <div className="mt-5">
          <AuthAlert tone="warn">{t.site.auth.unavailable}</AuthAlert>
        </div>
      )}

      {/* The accounts still kept on this device (after "Add account", or when one of several signed out). Nothing if none. */}
      {isSupabaseConfigured && <SavedAccounts />}

      <GoogleButton mode="signin" />

      <form onSubmit={onSubmit} className="mt-8">
        <fieldset disabled={!isSupabaseConfigured} className="st-fieldset">
          <AuthField
            label={t.auth.email}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <AuthField
            label={t.auth.password}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Link href={FORGOT_PASSWORD_PATH} className="st-link self-start text-[15px]">
            {t.signup.forgotLink}
          </Link>
          {linkError && !error && (
            <AuthAlert tone="warn">{linkError === "link_expired" ? t.signup.linkExpired : t.signup.linkInvalid}</AuthAlert>
          )}
          {error && <AuthAlert tone="fail">{error}</AuthAlert>}
          <AuthSubmit busy={busy} disabled={!isSupabaseConfigured} tone={google ? "quiet" : undefined}>
            {busy ? t.auth.signingIn : t.auth.signIn}
          </AuthSubmit>
        </fieldset>
      </form>

      <p className="st-small mt-8 flex flex-wrap items-center gap-x-2 border-t border-[var(--ns-rule)] pt-5">
        {t.signup.noAccount}
        <Link href={signupHref} className="st-link text-[15px]">
          {t.signup.createAccount}
        </Link>
      </p>
    </AuthShell>
  );
}
