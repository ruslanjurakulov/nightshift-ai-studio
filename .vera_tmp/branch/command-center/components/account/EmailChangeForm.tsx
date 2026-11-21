"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { createReauthClient } from "@/lib/supabase/reauth";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n/core";
import { useToast } from "@/components/feedback/ToastProvider";
import { AUTH_CALLBACK_PATH } from "@/lib/public-paths";
import {
  FailureThrottle,
  classifyEmailChangeError,
  validateEmailChange,
  verifyCurrentPassword,
  type EmailChangeOutcome,
} from "@/lib/account-security";

/**
 * Change the sign-in e-mail: the new address and the CURRENT password (checked
 * by signing in again, on a throwaway client), then updateUser({ email }).
 * Supabase mails confirmation links (secure e-mail change: to the old and the
 * new address) and the address only changes once they are opened, so what the
 * person sees is a pending state. It never says whether the new address is
 * already in use: that case reads exactly like a free one.
 */
export function EmailChangeForm({ email, pendingEmail }: { email: string; pendingEmail: string | null }) {
  const { t } = useI18n();
  const a = t.accountSecurity;
  const toast = useToast();
  const throttle = useRef(new FailureThrottle());
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const pending = sentTo ?? pendingEmail;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const problem = validateEmailChange({ current: email, next, password });
    if (problem) {
      setError({ email_invalid: a.emailInvalid, email_same: a.emailSame, password_required: a.errPasswordRequired }[problem]);
      return;
    }
    const supabase = createClient();
    const reauth = createReauthClient();
    if (!supabase || !reauth) return;
    setBusy(true);
    try {
      const verdict = await verifyCurrentPassword(reauth, email, password, throttle.current);
      if (verdict !== "ok") {
        setError(
          { throttled: a.errThrottle, wrong_password: a.errPasswordWrong, rate_limited: a.errRateLimited, failed: a.emailFailed }[verdict],
        );
        return;
      }
      const address = next.trim();
      const { error: updateError } = await supabase.auth.updateUser(
        { email: address },
        { emailRedirectTo: `${window.location.origin}${AUTH_CALLBACK_PATH}?next=${encodeURIComponent("/")}` },
      );
      const outcome: EmailChangeOutcome = updateError ? classifyEmailChangeError(updateError) : "sent";
      if (outcome !== "sent") {
        setError(
          {
            invalid_email: a.emailInvalid,
            second_factor: a.errSecondFactor,
            session_expired: a.errSession,
            rate_limited: a.errRateLimited,
            failed: a.emailFailed,
          }[outcome],
        );
        return;
      }
      setSentTo(address);
      setNext("");
      setPassword("");
      setOpen(false);
      toast.success(fmt(a.emailSent, { email: address, current: email }));
    } catch {
      setError(a.emailFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="g5-h">{a.emailTitle}</h3>
        <p className="g5-note mt-1">
          {a.emailYours} <strong className="g5-v break-all">{email}</strong>
        </p>
      </div>
      {pending && (
        <p role="status" className="g5-note" data-testid="email-pending">
          {sentTo ? fmt(a.emailSent, { email: sentTo, current: email }) : fmt(a.emailPending, { email: pending })}
        </p>
      )}
      {!open ? (
        <button type="button" className="btn-quiet self-start px-5 text-sm" onClick={() => setOpen(true)}>
          {a.emailChange}
        </button>
      ) : (
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <div className="g5-form">
            <label className="g5-field">
              <span className="g5-k">{a.newEmail}</span>
              <input
                type="email"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="email"
                required
                className="ns-field"
              />
            </label>
            <label className="g5-field">
              <span className="g5-k">{a.currentPassword}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="ns-field"
              />
            </label>
          </div>
          {error && (
            <p role="alert" className="g5-note g5-fail-text">
              {error}
            </p>
          )}
          <div className="g5-actions">
            <button type="submit" className="btn-quiet px-5 text-sm" disabled={busy}>
              {busy ? a.emailSending : a.emailSubmit}
            </button>
            <button
              type="button"
              className="g5-link"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              {a.cancel}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
