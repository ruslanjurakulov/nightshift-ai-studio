"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { fmt } from "@/lib/i18n/core";
import { AuthAlert, AuthField, AuthShell, AuthSubmit } from "@/components/auth/AuthShell";
import { finishRecovery } from "@/app/reset-password/actions";
import { classifyPasswordUpdateError } from "@/lib/account-security";
import { setFlash } from "@/lib/flash";
import { FORGOT_PASSWORD_PATH } from "@/lib/public-paths";
import { PASSWORD_MAX, PASSWORD_MIN, validateNewPassword } from "@/lib/signup";

/**
 * The reset form (a recovery session is already in place: the page checked).
 * Same password policy as sign-up. On success: the other sessions are signed
 * out, the marker is cleared, and the person goes on into the app with a
 * one-line notice. Provider text is never shown; passwords are never logged.
 */
export function ResetPasswordForm({ email }: { email: string }) {
  const router = useRouter();
  const { t } = usePublicI18n();
  const r = t.recovery;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = validateNewPassword(password, confirm);
    if (problem) {
      setError(
        {
          password_short: fmt(t.signup.errPasswordShort, { n: PASSWORD_MIN }),
          password_long: t.signup.errPasswordLong,
          password_mismatch: t.signup.errMismatch,
        }[problem],
      );
      return;
    }
    const supabase = createClient();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        const outcome = classifyPasswordUpdateError(updateError);
        if (outcome === "session_expired") setExpired(true);
        setError(
          {
            weak_password: r.errWeak,
            same_password: r.errSame,
            session_expired: r.errSession,
            second_factor: r.errSecondFactor,
            rate_limited: r.errRateLimited,
            failed: r.errFailed,
          }[outcome],
        );
        setBusy(false);
        return;
      }
      // Every other device is signed out; this one stays in. Best effort: the password HAS changed.
      await supabase.auth.signOut({ scope: "others" }).catch(() => undefined);
      await finishRecovery().catch(() => undefined);
      setFlash("password_changed");
      router.replace("/");
      router.refresh();
    } catch {
      setError(r.errFailed);
      setBusy(false);
    }
  }

  return (
    <AuthShell title={r.resetTitle} subtitle={fmt(r.resetSub, { email })}>
      <form onSubmit={onSubmit} noValidate className="mt-8">
        <fieldset className="st-fieldset">
          <AuthField
            label={r.newPassword}
            type={show ? "text" : "password"}
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            hint={fmt(t.signup.passwordHint, { n: PASSWORD_MIN })}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <AuthField
            label={r.confirmPassword}
            type={show ? "text" : "password"}
            autoComplete="new-password"
            required
            maxLength={PASSWORD_MAX}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-pressed={show}
            className="st-link inline-flex min-h-11 items-center gap-2 self-start text-[15px]"
          >
            {show ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
            {show ? r.hidePasswords : r.showPasswords}
          </button>
          {error && (
            <AuthAlert tone="fail">
              {error}
              {expired && (
                <>
                  {" "}
                  <Link href={FORGOT_PASSWORD_PATH} className="underline underline-offset-4 text-[var(--ns-text)]">
                    {r.requestNew}
                  </Link>
                </>
              )}
            </AuthAlert>
          )}
          <AuthSubmit busy={busy}>{busy ? r.resetSaving : r.resetSubmit}</AuthSubmit>
        </fieldset>
      </form>
    </AuthShell>
  );
}
