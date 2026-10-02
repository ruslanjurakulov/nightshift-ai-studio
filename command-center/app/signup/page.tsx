"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/config";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { fmt } from "@/lib/i18n/core";
import { AuthAlert, AuthField, AuthShell, AuthSubmit } from "@/components/auth/AuthShell";
import { AUTH_CALLBACK_PATH, WELCOME_PATH } from "@/lib/public-paths";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  classifySignupError,
  classifySignupResult,
  validateSignup,
  type SignupFieldError,
  type SignupOutcome,
} from "@/lib/signup";

/**
 * Self-serve sign-up. The account is created by Supabase Auth with the anon
 * key, exactly like sign-in; nothing here touches a table. With "Confirm
 * email" on (docs/SIGNUP_SETUP.md), no session exists until the emailed link
 * is opened — it lands on /auth/callback, which signs the person in and sends
 * them to /welcome.
 */
export default function SignupPage() {
  const router = useRouter();
  const { t } = usePublicI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SignupFieldError | SignupOutcome | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const messages: Record<SignupFieldError | Exclude<SignupOutcome, "check_email" | "signed_in">, string> = {
    email_invalid: t.signup.errEmail,
    password_short: fmt(t.signup.errPasswordShort, { n: PASSWORD_MIN }),
    password_long: t.signup.errPasswordLong,
    password_mismatch: t.signup.errMismatch,
    consent_required: t.signup.errConsent,
    already_registered: t.signup.errAlreadyRegistered,
    weak_password: t.signup.errWeakPassword,
    rate_limited: t.signup.errRateLimited,
    signups_closed: t.signup.errSignupsClosed,
    failed: t.signup.errFailed,
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const invalid = validateSignup({ email, password, confirm, consent });
    if (invalid) {
      setProblem(invalid);
      return;
    }
    const supabase = createClient();
    if (!supabase) return;

    setBusy(true);
    setProblem(null);
    const address = email.trim();
    try {
      const { data, error } = await supabase.auth.signUp({
        email: address,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}${AUTH_CALLBACK_PATH}?next=${encodeURIComponent(WELCOME_PATH)}`,
        },
      });
      const outcome = error ? classifySignupError(error) : classifySignupResult(data);
      if (outcome === "signed_in") {
        // "Confirm email" is off in this project: the account is live already.
        router.push(WELCOME_PATH);
        router.refresh();
        return;
      }
      if (outcome === "check_email") {
        setPassword("");
        setConfirm("");
        setSentTo(address);
      } else {
        setProblem(outcome);
      }
    } catch {
      setProblem("failed");
    }
    setBusy(false);
  }

  if (sentTo) {
    return (
      <AuthShell title={t.signup.checkTitle} mode="signup">
        <p role="status" className="st-body mt-4 text-[var(--ns-text)]">
          {fmt(t.signup.checkBody, { email: sentTo })}
        </p>
        <p className="st-small mt-3">{t.signup.checkHint}</p>
        <div className="mt-8 flex flex-col gap-3">
          <Link href="/login" className="st-key" data-block="true">
            {t.signup.signIn}
          </Link>
          <button
            type="button"
            onClick={() => {
              setSentTo(null);
              setBusy(false);
            }}
            className="st-link self-center text-[14px]"
          >
            {t.signup.useDifferent}
          </button>
        </div>
      </AuthShell>
    );
  }

  const shownProblem = problem && problem !== "check_email" && problem !== "signed_in" ? messages[problem] : null;

  return (
    <AuthShell title={t.signup.title} subtitle={t.signup.sub} mode="signup">
      {!isSupabaseConfigured && (
        <div className="mt-5">
          <AuthAlert tone="warn">{t.site.auth.unavailableSignup}</AuthAlert>
        </div>
      )}

      <form onSubmit={onSubmit} noValidate className="mt-8">
        <fieldset disabled={!isSupabaseConfigured} className="st-fieldset">
          <AuthField
            label={t.signup.email}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <AuthField
            label={t.signup.password}
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            hint={fmt(t.signup.passwordHint, { n: PASSWORD_MIN })}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <AuthField
            label={t.signup.confirm}
            type="password"
            autoComplete="new-password"
            required
            maxLength={PASSWORD_MAX}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <label className="mt-1 flex min-h-11 items-start gap-3 text-[14px] leading-snug text-[var(--ns-text-dim)]">
            <input
              type="checkbox"
              required
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="size-6 shrink-0 accent-[var(--ns-amber)]"
            />
            <span>
              {t.signup.consentPre}{" "}
              <Link
                href="/terms"
                target="_blank"
                className="-my-[14px] inline-block py-[14px] underline decoration-[var(--ns-rule-strong)] underline-offset-4 text-[var(--ns-text)] hover:text-[var(--ns-amber-ink)]"
              >
                {t.signup.terms}
              </Link>{" "}
              {t.signup.consentAnd}{" "}
              <Link
                href="/privacy"
                target="_blank"
                className="-my-[14px] inline-block py-[14px] underline decoration-[var(--ns-rule-strong)] underline-offset-4 text-[var(--ns-text)] hover:text-[var(--ns-amber-ink)]"
              >
                {t.signup.privacy}
              </Link>
              {t.signup.consentPost}
            </span>
          </label>
          {shownProblem && (
            <AuthAlert tone="fail">
              {shownProblem}
              {problem === "already_registered" && (
                <>
                  {" "}
                  <Link href="/login" className="underline underline-offset-4 text-[var(--ns-text)]">
                    {t.signup.signIn}
                  </Link>
                </>
              )}
            </AuthAlert>
          )}
          <AuthSubmit busy={busy} disabled={!isSupabaseConfigured}>
            {busy ? t.signup.submitting : t.signup.submit}
          </AuthSubmit>
        </fieldset>
      </form>

      <p className="st-small mt-8 flex flex-wrap items-center gap-x-2 border-t border-[var(--ns-rule)] pt-5">
        {t.signup.haveAccount}
        <Link href="/login" className="st-link text-[14.5px]">
          {t.signup.signIn}
        </Link>
      </p>
    </AuthShell>
  );
}
