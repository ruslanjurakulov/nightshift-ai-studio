"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/config";
import { useI18n } from "@/lib/i18n/context";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSelector } from "@/components/LanguageSelector";
import { NightSky } from "@/components/NightSky";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const supabase = createClient();
    if (!supabase) {
      setError(t.auth.notConfiguredErr);
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      // Supabase's own message (e.g. "Invalid login credentials") — surfaced verbatim.
      setError(error.message);
      return;
    }
    router.push("/command-center");
    router.refresh();
  }

  return (
    <main className="atmos relative flex min-h-dvh items-center justify-center overflow-hidden p-6">
      <NightSky />
      {/* A soft accent bloom behind the card, so it reads as lit rather than
          dropped onto black — the dramatic entry, purely decorative. */}
      <div
        aria-hidden
        className="pointer-events-none absolute z-0 h-[520px] w-[520px] rounded-full blur-[120px]"
        style={{ background: "radial-gradient(circle, var(--glow-primary), transparent 70%)" }}
      />

      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <LanguageSelector />
        <ThemeToggle />
      </div>

      <div className="glass-card sheet-enter stagger-enter relative z-10 w-full max-w-sm rounded-[22px] border border-[var(--color-border)] p-8">
        <div
          className="font-display text-2xl font-semibold tracking-[-0.02em] text-[var(--color-primary)]"
          style={{ textShadow: "0 0 28px var(--glow-primary)" }}
        >
          {t.brand.name}
        </div>
        <div className="mt-1 text-[11px] font-light tracking-[0.14em] text-[var(--color-muted)]">
          {t.brand.tagline}
        </div>
        <h1 className="mt-8 text-[28px] font-semibold leading-tight tracking-[-0.02em]">{t.auth.signInTitle}</h1>
        <p className="mt-3 text-[15px] font-light text-[var(--color-muted)]">{t.auth.signInSub}</p>

        {!isSupabaseConfigured && (
          <p className="mt-5 text-[13px] font-light text-[var(--color-warn)]">{t.auth.notConfigured}</p>
        )}

        <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
              {t.auth.email}
            </span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="pill border border-[var(--color-border)] bg-transparent px-5 py-3 text-[15px] font-light outline-none transition-colors focus:border-[var(--color-primary)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
              {t.auth.password}
            </span>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pill border border-[var(--color-border)] bg-transparent px-5 py-3 text-[15px] font-light outline-none transition-colors focus:border-[var(--color-primary)]"
            />
          </label>
          {error && <p className="mono text-[11px] text-[var(--color-fail)]">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="btn-sky is-solid pill mt-2 justify-center px-6 py-3 text-sm disabled:opacity-50"
          >
            {busy ? t.auth.signingIn : t.auth.signIn}
          </button>
        </form>
      </div>
    </main>
  );
}
