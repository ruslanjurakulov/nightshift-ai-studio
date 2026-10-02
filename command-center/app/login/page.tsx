"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/config";
import { useI18n } from "@/lib/i18n/context";
import { AuthAlert, AuthField, AuthShell, AuthSubmit } from "@/components/auth/AuthShell";
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
      setError(t.site.auth.unavailable);
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
    <AuthShell title={t.site.auth.signInTitle} subtitle={t.site.auth.signInSub}>
      {!isSupabaseConfigured && (
        <div className="mt-5">
          <AuthAlert tone="warn">{t.site.auth.unavailable}</AuthAlert>
        </div>
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
          <AuthAlert tone="warn">{linkError === "link_expired" ? t.signup.linkExpired : t.signup.linkInvalid}</AuthAlert>
        )}
        {error && (
          <AuthAlert tone="fail">{error}</AuthAlert>
        )}
        <AuthSubmit busy={busy}>{busy ? t.auth.signingIn : t.auth.signIn}</AuthSubmit>
      </form>

      <p className="st-small mt-8 flex flex-wrap items-center gap-x-2 border-t border-[var(--ns-rule)] pt-5">
        {t.signup.noAccount}
        <Link href="/signup" className="st-link text-[14.5px]">
          {t.signup.createAccount}
        </Link>
      </p>
    </AuthShell>
  );
}
