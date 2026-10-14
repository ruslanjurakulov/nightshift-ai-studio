"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { createReauthClient } from "@/lib/supabase/reauth";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n/core";
import { useToast } from "@/components/feedback/ToastProvider";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/signup";
import {
  FailureThrottle,
  classifyPasswordUpdateError,
  validatePasswordChange,
  verifyCurrentPassword,
} from "@/lib/account-security";

/**
 * Change the password: the current one (checked by signing in again on a
 * throwaway client; a wrong one is a generic "that password isn't right",
 * throttled here), a new one under the SAME policy as sign-up, typed twice.
 * Then updateUser({ password }) and every OTHER session is signed out — this
 * device stays in. The passwords live in this component's state only: never
 * logged, never stored.
 */
export function PasswordChangeForm({ email }: { email: string }) {
  const { t } = useI18n();
  const a = t.accountSecurity;
  const toast = useToast();
  const throttle = useRef(new FailureThrottle());
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setDone(false);
    const problem = validatePasswordChange({ current, next, confirm });
    if (problem) {
      setError(
        {
          current_required: a.errPasswordRequired,
          password_short: fmt(t.signup.errPasswordShort, { n: PASSWORD_MIN }),
          password_long: t.signup.errPasswordLong,
          password_mismatch: t.signup.errMismatch,
          password_unchanged: a.errUnchanged,
        }[problem],
      );
      return;
    }
    const supabase = createClient();
    const reauth = createReauthClient();
    if (!supabase || !reauth) return;
    setBusy(true);
    try {
      const verdict = await verifyCurrentPassword(reauth, email, current, throttle.current);
      if (verdict !== "ok") {
        setError({ throttled: a.errThrottle, wrong_password: a.errPasswordWrong, rate_limited: a.errRateLimited, failed: a.errFailed }[verdict]);
        return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ password: next });
      if (updateError) {
        setError(
          {
            weak_password: t.signup.errWeakPassword,
            same_password: a.errUnchanged,
            session_expired: a.errSession,
            second_factor: a.errSecondFactor,
            rate_limited: a.errRateLimited,
            failed: a.errFailed,
          }[classifyPasswordUpdateError(updateError)],
        );
        return;
      }
      // Every other device is signed out; this one stays in. Best effort: the password HAS changed.
      await supabase.auth.signOut({ scope: "others" }).catch(() => undefined);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
      toast.success(a.passwordChanged);
    } catch {
      setError(a.errFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <h3 className="g5-h">{a.passwordTitle}</h3>
      <div className="g5-form">
        <label className="g5-field">
          <span className="g5-k">{a.currentPassword}</span>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
            className="ns-field"
          />
        </label>
        <label className="g5-field">
          <span className="g5-k">{a.newPassword}</span>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            required
            className="ns-field"
          />
        </label>
        <label className="g5-field">
          <span className="g5-k">{a.confirmPassword}</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            maxLength={PASSWORD_MAX}
            required
            className="ns-field"
          />
        </label>
      </div>
      <p className="g5-note">{fmt(t.signup.passwordHint, { n: PASSWORD_MIN })}</p>
      {error && (
        <p role="alert" className="g5-note g5-fail-text">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="g5-note">
          {a.passwordChanged}
        </p>
      )}
      <div className="g5-actions">
        <button type="submit" className="btn-quiet px-5 text-sm" disabled={busy}>
          {busy ? a.passwordSaving : a.passwordSubmit}
        </button>
      </div>
    </form>
  );
}
