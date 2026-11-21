"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/config";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { fmt } from "@/lib/i18n/core";
import { AuthAlert, AuthField, AuthShell, AuthSubmit } from "@/components/auth/AuthShell";
import { LOGIN_PATH } from "@/lib/public-paths";
import { cooldownLeft, isRecoveryNotice, requestPasswordReset, type RecoveryNotice } from "@/lib/recovery";

/**
 * Ask for a password-reset e-mail.
 *
 * The answer is the same whatever Supabase says (lib/recovery.ts
 * requestPasswordReset): "if an account exists for this address, we sent a
 * link". Nothing on this page tells a registered address from an unregistered
 * one, a rate limit from a send, or an error from success; the one thing a
 * person is told differently is a malformed address, before anything is sent.
 * "Send again" waits 60 seconds on this page.
 */
export default function ForgotPasswordPage() {
  const { t } = usePublicI18n();
  const r = t.recovery;
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState<RecoveryNotice | null>(null);

  // /auth/callback and /reset-password send someone here with a fixed code.
  // Read once on mount, from a closed set — never text from the URL.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("s");
    if (isRecoveryNotice(code)) setNotice(code);
  }, []);

  const left = cooldownLeft(sentAt, now);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [left]);

  async function send(address: string) {
    if (busy) return;
    setBusy(true);
    setInvalid(false);
    const outcome = await requestPasswordReset(createClient(), address, window.location.origin);
    setBusy(false);
    if (outcome === "invalid_email") {
      setInvalid(true);
      return;
    }
    // "unavailable" (no backend) shows the notice above the form and sends nothing.
    if (outcome === "unavailable") return;
    setNotice(null);
    setSentTo(address.trim());
    setSentAt(Date.now());
    setNow(Date.now());
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void send(email);
  }

  if (sentTo) {
    return (
      <AuthShell title={r.sentTitle}>
        <p role="status" className="st-body mt-4 text-[var(--ns-text)]">
          {fmt(r.sentBody, { email: sentTo })}
        </p>
        <p className="st-small mt-3">{r.sentHint}</p>
        <div className="mt-8 flex flex-col gap-3">
          <button
            type="button"
            className="st-key"
            data-tone="quiet"
            data-block="true"
            disabled={busy || left > 0}
            onClick={() => void send(sentTo)}
          >
            {left > 0 ? fmt(r.resendIn, { n: left }) : r.resend}
          </button>
          <button
            type="button"
            onClick={() => {
              setSentTo(null);
              setSentAt(null);
            }}
            className="st-link self-center text-sm"
          >
            {r.useDifferent}
          </button>
          <Link href={LOGIN_PATH} className="st-link self-center text-sm">
            {r.backToSignIn}
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={r.forgotTitle} subtitle={r.forgotSub}>
      {!isSupabaseConfigured && (
        <div className="mt-5">
          <AuthAlert tone="warn">{r.unavailable}</AuthAlert>
        </div>
      )}
      <form onSubmit={onSubmit} noValidate className="mt-8">
        <fieldset disabled={!isSupabaseConfigured} className="st-fieldset">
          <AuthField
            label={t.auth.email}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {notice && !invalid && <AuthAlert tone="warn">{notice === "expired" ? r.noticeExpired : r.noticeNeedsLink}</AuthAlert>}
          {invalid && <AuthAlert tone="fail">{r.errEmail}</AuthAlert>}
          <AuthSubmit busy={busy} disabled={!isSupabaseConfigured}>
            {busy ? r.forgotSending : r.forgotSubmit}
          </AuthSubmit>
        </fieldset>
      </form>
      <p className="st-small mt-8 flex flex-wrap items-center gap-x-2 border-t border-[var(--ns-rule)] pt-5">
        <Link href={LOGIN_PATH} className="st-link text-[15px]">
          {r.backToSignIn}
        </Link>
      </p>
    </AuthShell>
  );
}
