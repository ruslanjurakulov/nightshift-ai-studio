"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/config";
import { useI18n } from "@/lib/i18n/context";
import { AuthField, AuthShell } from "@/components/auth/AuthShell";
import { classifySignInError, isCallbackError, type CallbackError, type SignInOutcome } from "@/lib/signup";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkError, setLinkError] = useState<CallbackError | null>(null);

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
    if (!supabase) {
      setError(t.auth.notConfiguredErr);
      return;
    }
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
    router.push("/command-center");
    router.refresh();
  }

  return (
    <AuthShell title={t.auth.signInTitle} subtitle={t.auth.signInSub}>
      {!isSupabaseConfigured && (
        <p className="mt-5 text-[13px] font-light text-[var(--color-warn)]">{t.auth.notConfigured}</p>
      )}

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
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
        {linkError && !error && (
          <p role="alert" className="mono text-[11px] text-[var(--color-warn)]">
            {linkError === "link_expired" ? t.signup.linkExpired : t.signup.linkInvalid}
          </p>
        )}
        {error && (
          <p role="alert" className="mono text-[11px] text-[var(--color-fail)]">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="cta-glass pill mt-2 inline-flex items-center justify-center px-6 py-3 text-sm font-semibold disabled:opacity-50"
        >
          {busy ? t.auth.signingIn : t.auth.signIn}
        </button>
      </form>

      <p className="mt-6 text-center text-[13px] font-light text-[var(--color-muted)]">
        {t.signup.noAccount}{" "}
        <Link href="/signup" className="text-[var(--color-primary)] underline-offset-4 hover:underline">
          {t.signup.createAccount}
        </Link>
      </p>
    </AuthShell>
  );
}
